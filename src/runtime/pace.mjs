/**
 * One rate for every request this CLI makes, kept between commands.
 *
 * A command is a process that lives for one call, and an agent runs several of
 * them in a row — so a gap held in memory is a gap that exists only inside
 * whichever command happened to make two requests, and `get-item` twice in a
 * row hits Avito as fast as the shell can start Node. The pace is therefore a
 * file: the moment the last request was accounted for, written beside the
 * browser choice and the broker state, and read by whichever process asks next.
 * That makes it one clock for the whole machine — inside a command, between two
 * commands, and between two commands running at once.
 *
 * The gap is measured from the end of the previous request, or from its start
 * while it is still running, whichever is later. A request reserves its slot
 * before it goes out and stamps the clock again when it comes back, so a second
 * process cannot fire into the middle of a request it cannot see.
 *
 * Every request draws its own gap between the two constants below, and nothing
 * this CLI accepts — no argument, no environment variable — changes them. What
 * the caller can still move is where the clock lives, because it lives in the
 * state directory with everything else (`AVITO_BROKER_DIR`), and a clock that
 * is not there reads as a machine that has not requested anything yet. No file
 * the caller owns can defend itself against the caller; what this file promises
 * is that the CLI itself offers no way to ask for a faster rate.
 *
 * Every failure here is a failure towards slower. A clock that cannot be read,
 * cannot be written, or says something impossible buys the longest gap there is
 * rather than none, and stamping the clock never replaces the error from the
 * request it was stamping for.
 *
 * Nothing about Avito lives here. This is milliseconds between requests, and
 * what a safe rate actually is has still never been measured (D-082).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { stateDir } from './browser-config.mjs';

/** The gap one request waits is drawn between these two, inclusive. */
export const MIN_REQUEST_GAP_MS = 1000;
export const MAX_REQUEST_GAP_MS = 2500;

/**
 * The longest queue of concurrent requests this CLI can put on one machine,
 * in gaps. A reservation further out than this is not a queue.
 */
const MAX_QUEUED_GAPS = 20;
const MAX_WAIT_MS = MAX_REQUEST_GAP_MS * MAX_QUEUED_GAPS;

/** A lock this far from now, in either direction, is not held by anybody. */
const LOCK_STALE_MS = 5000;
const LOCK_POLL_MS = 20;
/** Waiting past this for a lock means giving up on the clock, not on the gap. */
const LOCK_WAIT_LIMIT_MS = 4 * LOCK_STALE_MS;

export function paceClockFile() {
  return path.join(stateDir(), 'pace.json');
}

function paceLockFile() {
  return path.join(stateDir(), 'pace.lock');
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function nextGapMs() {
  const span = MAX_REQUEST_GAP_MS - MIN_REQUEST_GAP_MS + 1;
  return MIN_REQUEST_GAP_MS + Math.floor(Math.random() * span);
}

export function describeRequestPace() {
  return `request pace: ${MIN_REQUEST_GAP_MS}–${MAX_REQUEST_GAP_MS} ms between requests, `
    + `drawn anew for each one, kept in ${paceClockFile()}`;
}

/**
 * The moment the last request was accounted for, and whether that is knowledge.
 *
 * `{ at: null, known: true }` means nothing has been requested yet; `known:
 * false` means the clock was there and could not be read, which is a different
 * thing and is not allowed to look like the first one. An unreadable clock buys
 * a whole gap, never none: the direction a failure here may err in is slower.
 */
function readClock() {
  let contents;
  try {
    contents = fs.readFileSync(paceClockFile(), 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return { at: null, known: true };
    return { at: null, known: false };
  }
  try {
    const { at } = JSON.parse(contents);
    if (typeof at === 'number' && Number.isFinite(at)) {
      // A reservation further out than the longest queue there can be is a
      // clock that stepped backwards or a file that got garbled, and taken at
      // face value it fails in both directions at once: `1e18` overflows the
      // 32-bit delay `setTimeout` accepts, Node clamps it to 1 ms, and the
      // overflowed value is then written back — pacing off, permanently and
      // silently. Capping it heals the file on the next write.
      return { at: Math.min(at, Date.now() + MAX_WAIT_MS), known: true };
    }
  } catch {
    // Not JSON, so not a clock. The unknown answer below is the honest one.
  }
  return { at: null, known: false };
}

function writeClock(at) {
  fs.writeFileSync(paceClockFile(), `${JSON.stringify({ at }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Take the lock, or say the holder still has it. The critical section is one
 * read and one write of a two-line file, so a lock five seconds from now is not
 * held by anybody: it is what a process killed mid-write left behind. Distance
 * counts in both directions — an mtime in the future is what a backward clock
 * step leaves behind, and waiting for that to age is waiting forever.
 */
function takeLock() {
  try {
    fs.writeFileSync(paceLockFile(), String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let age;
  try {
    age = Date.now() - fs.statSync(paceLockFile()).mtimeMs;
  } catch {
    // It vanished between the two calls: the holder finished, and the next turn
    // of the loop takes it cleanly.
    return false;
  }
  if (Math.abs(age) <= LOCK_STALE_MS) return false;
  // Unlink and re-create with `wx` rather than overwrite: two processes that
  // saw the same stale lock would both have been told they hold it, and their
  // read-then-write would interleave into one lost reservation. Whoever's `wx`
  // wins here is the only one inside.
  try {
    fs.rmSync(paceLockFile());
  } catch {
    // The other claimant got there first; the `wx` below is still the arbiter.
  }
  try {
    fs.writeFileSync(paceLockFile(), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the lock this process holds, and only that one. A process whose lock was
 * stolen while it stalled would otherwise delete the new holder's.
 */
function releaseLock() {
  try {
    if (fs.readFileSync(paceLockFile(), 'utf-8') !== String(process.pid)) return;
    fs.rmSync(paceLockFile());
  } catch {
    // Already gone, or unreadable: either way this process is not holding it.
  }
}

/**
 * Read the clock and write the next one without another process interleaving.
 * Reserving and stamping are both read-then-write, and two commands starting in
 * the same moment would otherwise reserve the same slot and fire together.
 *
 * Throws when the clock cannot be kept at all — an unwritable state directory,
 * or a lock nobody ever releases. Both callers below turn that into a wait.
 */
async function withClock(update) {
  const startedAt = Date.now();
  fs.mkdirSync(stateDir(), { recursive: true });
  while (!takeLock()) {
    if (Date.now() - startedAt > LOCK_WAIT_LIMIT_MS) {
      throw new Error(`no pace lock after ${LOCK_WAIT_LIMIT_MS} ms`);
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    return update();
  } finally {
    releaseLock();
  }
}

/** Claim the next slot in the queue and wait until it is this request's turn. */
async function waitForSlot(gap) {
  const now = Date.now();
  let at;
  try {
    at = await withClock(() => {
      const clock = readClock();
      let next;
      if (!clock.known) next = now + gap;
      else if (clock.at === null) next = now;
      else next = Math.max(now, clock.at + gap);
      writeClock(next);
      return next;
    });
  } catch {
    // No clock to keep: the state directory will not take one, or a lock is
    // stuck. A pace that cannot be recorded is not a pace that may be skipped,
    // and this process cannot see what else is in flight, so it buys the
    // longest gap there is rather than none.
    await sleep(MAX_REQUEST_GAP_MS);
    return MAX_REQUEST_GAP_MS;
  }
  const waitMs = at - now;
  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

/**
 * A request that came back — or failed — still happened, and dates the clock.
 * This runs in a `finally`, where a throw would replace the error the request
 * itself raised: a 429 or a challenge is the whole diagnosis this CLI is built
 * around, and it may not be overwritten by an errno from the pacer. A stamp
 * that did not land costs the next request a whole gap, which is the direction
 * this is allowed to fail in.
 */
async function stampFinished() {
  try {
    await withClock(() => {
      const clock = readClock();
      const now = Date.now();
      writeClock(clock.known && clock.at !== null ? Math.max(clock.at, now) : now);
    });
  } catch {
    // Deliberately swallowed. See above: the caller's error outranks this one.
  }
}

/**
 * Run one request at the pace the machine is keeping. Every navigation and
 * every page fetch this CLI makes goes through here, so the gap holds however
 * many commands the caller runs and however fast it runs them.
 */
export async function pacedRequest(run) {
  await waitForSlot(nextGapMs());
  try {
    return await run();
  } finally {
    await stampFinished();
  }
}
