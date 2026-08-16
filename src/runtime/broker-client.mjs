/**
 * Talking to the session broker, and starting one when there is none.
 *
 * The whole point is that the browser is approached once per session rather
 * than once per command, so this file is careful about exactly one thing:
 * never starting a second broker. Two brokers would mean two connections and
 * two approval modals, which is the problem it exists to remove.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function brokerStateDir() {
  return process.env.AVITO_BROKER_DIR || path.join(os.homedir(), '.avito-cdp');
}

export const BROKER_STATE_FILE = path.join(brokerStateDir(), 'broker.json');
const BROKER_LOCK_FILE = path.join(brokerStateDir(), 'broker.lock');
const BROKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'broker.mjs');
const START_TIMEOUT_MS = 20000;

export function readBrokerState() {
  try {
    return JSON.parse(fs.readFileSync(BROKER_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function health(state) {
  if (!state?.port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** A state file left behind by a dead broker must not look like a live one. */
export async function liveBroker() {
  const state = readBrokerState();
  if (!state) return null;
  const alive = await health(state);
  if (!alive) {
    try {
      fs.rmSync(BROKER_STATE_FILE);
    } catch {
      // Someone else removed it first, which is the outcome we wanted.
    }
    return null;
  }
  return state;
}

export async function callBroker(state, route, body) {
  const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-avito-broker-token': state.token },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || `broker refused ${route}`);
  return payload;
}

function spawnBroker(options) {
  const child = spawn(process.execPath, [BROKER_ENTRY], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(options.browserWs ? { AVITO_BROWSER_WS: options.browserWs } : {}),
      ...(options.browserProfile ? { AVITO_BROWSER_PROFILE: options.browserProfile } : {}),
      ...(options.browserUrl ? { AVITO_BROWSER_URL: options.browserUrl } : {}),
    },
  });
  child.unref();
}

/**
 * Return a live broker, starting one if necessary.
 *
 * The lock is what keeps two commands started at the same moment from opening
 * two connections: whoever creates the lock file starts the broker, everyone
 * else waits for the state file to appear.
 */
export async function ensureBroker(options = {}) {
  const existing = await liveBroker();
  if (existing) return existing;

  fs.mkdirSync(brokerStateDir(), { recursive: true });
  let owner = false;
  try {
    fs.writeFileSync(BROKER_LOCK_FILE, String(process.pid), { flag: 'wx' });
    owner = true;
  } catch {
    // A stale lock from a crashed start would block every later run, so it is
    // adopted after the same timeout a start is given.
    try {
      const age = Date.now() - fs.statSync(BROKER_LOCK_FILE).mtimeMs;
      if (age > START_TIMEOUT_MS) {
        fs.writeFileSync(BROKER_LOCK_FILE, String(process.pid));
        owner = true;
      }
    } catch {
      // The lock vanished between the two calls: the other starter finished.
    }
  }

  try {
    if (owner) spawnBroker(options);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await liveBroker();
      if (state) return state;
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
    throw new Error(
      'the session broker did not start. Run `avito session status` for what it reports, '
      + 'or set AVITO_BROKER=off to connect directly on every command.',
    );
  } finally {
    if (owner) {
      try {
        fs.rmSync(BROKER_LOCK_FILE);
      } catch {
        // Already gone.
      }
    }
  }
}

export async function stopBroker() {
  const state = await liveBroker();
  if (!state) return false;
  await callBroker(state, '/shutdown');
  return true;
}
