/**
 * Talking to the session broker, and starting one when there is none.
 *
 * The whole point is that the browser is approached once per session rather
 * than once per command, so this file is careful about exactly one thing:
 * never starting a second broker. Two brokers would mean two connections and
 * two approval modals, which is the problem it exists to remove.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describeBrowserTarget, stateDir } from './browser-config.mjs';

export const BROKER_STATE_FILE = path.join(stateDir(), 'broker.json');
const BROKER_LOCK_FILE = path.join(stateDir(), 'broker.lock');

/**
 * Where the broker leaves the reason it could not start.
 *
 * The broker is detached with no stdio, so a failure to reach the browser used
 * to die inside the child: the parent waited out its whole timeout and reported
 * "the broker did not start", naming the broker instead of the browser (F-074).
 * The child writes its own cause here and the parent reads it back.
 */
export const BROKER_ERROR_FILE = path.join(stateDir(), 'broker-error.json');
const BROKER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'broker.mjs');
const START_TIMEOUT_MS = 20000;

export function writeBrokerStartError(message) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      BROKER_ERROR_FILE,
      `${JSON.stringify({ message, pid: process.pid }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Nowhere to write the cause. The parent's timeout still reports a failure,
    // which is worse but not wrong.
  }
}

/**
 * `notBefore` is what keeps a failure from a previous run being reported as
 * this one's. Only the process that created the lock clears the file, so a
 * second command waiting on that same start can otherwise read whatever an
 * earlier attempt left there.
 */
export function readBrokerStartError(notBefore = 0) {
  try {
    if (fs.statSync(BROKER_ERROR_FILE).mtimeMs < notBefore) return null;
    const { message } = JSON.parse(fs.readFileSync(BROKER_ERROR_FILE, 'utf-8'));
    return typeof message === 'string' && message ? message : null;
  } catch {
    return null;
  }
}

function clearBrokerStartError() {
  try {
    fs.rmSync(BROKER_ERROR_FILE);
  } catch {
    // There was none, which is the state we wanted.
  }
}

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

  fs.mkdirSync(stateDir(), { recursive: true });
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

  const startedAt = Date.now();
  try {
    if (owner) {
      clearBrokerStartError();
      spawnBroker(options);
    }
    const deadline = startedAt + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await liveBroker();
      if (state) return state;
      // The cause the child recorded arrives long before the deadline does, and
      // waiting the rest of it out would only delay the same answer.
      const cause = readBrokerStartError(startedAt);
      if (cause) throw new Error(`could not reach the browser: ${cause}`);
      await new Promise((resolve) => { setTimeout(resolve, 150); });
    }
    throw new Error(
      `the session broker did not start within ${START_TIMEOUT_MS / 1000}s and recorded no reason. `
      + `It was told to use ${describeBrowserTarget(options)}. `
      + 'Run `avito session status` for what that endpoint looks like from here.',
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
