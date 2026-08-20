/**
 * One CDP connection, many commands.
 *
 * A browser with debugging on at `chrome://inspect` asks the person in front of
 * it to approve every client that attaches, and each CLI run is its own process
 * — so connecting per invocation turns a ten-command chain into ten modals.
 * This process holds the connection and the commands talk to it instead.
 *
 * It speaks plain HTTP and exposes only page ownership, navigation and runtime
 * evaluation, which keeps it incapable of doing more to the browser than a
 * command could (D-045, D-079).
 *
 * It knows nothing about Avito. No URL, no decoder, no header belongs here.
 *
 * Access is gated by a token written beside the endpoint in a file only the user
 * can read: holding a browser connection open for convenience must not become
 * an open door onto a logged-in session for every process on the machine.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { connectToBrowser } from './cdp-connection.mjs';
import {
  BROKER_PROTOCOL_VERSION,
  BROKER_STATE_FILE,
  writeBrokerStartError,
} from './broker-client.mjs';
import { resolveBrowserOptions, stateDir } from './browser-config.mjs';
import { PageRegistry } from './page-registry.mjs';

const DEFAULT_IDLE_SECONDS = 300;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (body === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`malformed request body: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export async function startBroker({
  browserWs,
  browserProfile,
  browserUrl,
  idleSeconds = Number(process.env.AVITO_BROKER_IDLE_SECONDS) || DEFAULT_IDLE_SECONDS,
} = {}) {
  const { connection, endpoint } = await connectToBrowser({ browserWs, browserProfile, browserUrl });
  const token = randomUUID();
  const pages = new PageRegistry(connection);

  let idleTimer = null;
  const shutdown = async (reason) => {
    clearTimeout(idleTimer);
    await pages.closeAll();
    connection.close();
    try {
      fs.rmSync(BROKER_STATE_FILE);
    } catch {
      // Another process already cleaned up the state file.
    }
    server.close();
    process.exitCode = 0;
    if (reason) process.stderr.write(`avito broker: ${reason}\n`);
  };

  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (pages.busySize === 0) shutdown('idle, closing the browser connection');
      else touch();
    }, idleSeconds * 1000);
    idleTimer.unref?.();
  };

  const server = http.createServer(async (request, response) => {
    touch();
    if (request.headers['x-avito-broker-token'] !== token && request.url !== '/health') {
      send(response, 403, { ok: false, error: 'bad or missing broker token' });
      return;
    }
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const body = request.method === 'POST' ? await readBody(request) : {};

      if (url.pathname === '/health') {
        send(response, 200, {
          ok: true,
          protocolVersion: BROKER_PROTOCOL_VERSION,
          endpoint,
          pages: pages.size,
          pid: process.pid,
        });
        return;
      }
      if (url.pathname === '/shutdown') {
        send(response, 200, { ok: true });
        await shutdown('stopped on request');
        return;
      }
      if (url.pathname === '/page/open') {
        const page = await pages.acquire({
          key: typeof body.key === 'string' && body.key ? body.key : null,
          persistent: body.persistent === true,
          ownerPid: Number(body.ownerPid) || null,
        });
        send(response, 200, {
          ok: true,
          pageId: page.pageId,
          sessionId: page.sessionId,
          created: page.created,
        });
        return;
      }
      if (url.pathname === '/page/bind') {
        await pages.bind(body.pageId, body.key);
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/page/release') {
        await pages.release(body.pageId, { discard: body.discard === true });
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/page/close') {
        await pages.release(body.pageId, { discard: true });
        send(response, 200, { ok: true });
        return;
      }
      if (url.pathname === '/session/send') {
        const result = await connection.send(body.method, body.params ?? {}, body.sessionId, body.timeoutSeconds);
        send(response, 200, { ok: true, result });
        return;
      }
      // Navigation is one broker operation rather than "subscribe, then
      // navigate" from the client. Over HTTP those are two requests with no
      // guaranteed order, and a load event that fires between them is lost —
      // the command would then wait out its whole timeout on a page that had
      // already loaded.
      if (url.pathname === '/page/goto') {
        const { sessionId, url: target, waitUntil = 'load', settleMs = 0, timeoutSeconds } = body;
        const loaded = waitUntil === 'load'
          ? connection.once('Page.loadEventFired', sessionId, timeoutSeconds)
          : Promise.resolve();
        const result = await connection.send('Page.navigate', { url: target }, sessionId, timeoutSeconds);
        if (result?.errorText) {
          send(response, 200, { ok: false, error: `navigating to ${target} failed: ${result.errorText}` });
          return;
        }
        await loaded;
        if (settleMs > 0) await new Promise((resolve) => { setTimeout(resolve, settleMs); });
        send(response, 200, { ok: true, result });
        return;
      }
      send(response, 404, { ok: false, error: `unknown broker route ${url.pathname}` });
    } catch (error) {
      send(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();

  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(
    BROKER_STATE_FILE,
    `${JSON.stringify({
      protocolVersion: BROKER_PROTOCOL_VERSION,
      port,
      token,
      pid: process.pid,
      endpoint,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  touch();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { shutdown(`received ${signal}`); });
  }
  connection.onClose(() => shutdown('the browser connection closed'));

  return { port, token, endpoint, shutdown };
}

// Started as its own process by the CLI. Options arrive through the environment
// because this process is detached and has no argv of its own worth parsing.
//
// It also has no stderr anyone reads, so a startup failure is written where the
// process that spawned it will look for it. Without that, the only thing the
// caller ever learns is that no broker appeared (F-074).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    await startBroker(resolveBrowserOptions());
  } catch (error) {
    writeBrokerStartError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
