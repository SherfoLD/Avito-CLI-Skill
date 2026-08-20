// Offline checks for the rate every request goes out at.
//
// The failure this layer exists to prevent is invisible in every answer: two
// commands in a row hit Avito as fast as the shell can start Node, nothing in
// the JSON says so, and what comes back is a challenge nobody can attribute. So
// what is checked here is the one property a gap held in memory never had — the
// clock survives the process — plus the two directions it may not fail in: a
// clock nobody can read must buy a wait rather than skip one, and no argument
// or environment variable may talk the pace down.
//
// The gaps are the real ones, so the suite waits out a few seconds of them.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runner } from './harness.mjs';
import {
  MAX_REQUEST_GAP_MS,
  MIN_REQUEST_GAP_MS,
  describeRequestPace,
  nextGapMs,
  paceClockFile,
  pacedRequest,
} from '../src/runtime/pace.mjs';

const { check, assert, run } = runner();

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACE_MODULE = path.join(PROJECT_ROOT, 'src', 'runtime', 'pace.mjs');
/** setTimeout may fire a millisecond early, and a loaded machine is not a bug. */
const SLACK_MS = 15;
/** Past this, the module has given up on the lock rather than kept waiting. */
const LOCK_GIVE_UP_MS = 20_000;
/** Past this, a reservation is a broken clock rather than a queue. */
const CLOCK_CEILING_MS = 60_000;

async function isolated(fn) {
  const savedDir = process.env.AVITO_BROKER_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avito-pace-'));
  process.env.AVITO_BROKER_DIR = scratch;
  try {
    await fn(scratch);
  } finally {
    if (savedDir === undefined) delete process.env.AVITO_BROKER_DIR;
    else process.env.AVITO_BROKER_DIR = savedDir;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Milliseconds one paced request spent between being asked for and going out. */
async function timeOneRequest() {
  const startedAt = Date.now();
  let ranAt = null;
  const answer = await pacedRequest(async () => {
    ranAt = Date.now();
    return 'answered';
  });
  assert(answer === 'answered', 'the paced request must return what the request returned');
  return { waited: ranAt - startedAt, total: Date.now() - startedAt };
}

check('with no clock behind it, the first request goes out immediately', async () => {
  await isolated(async () => {
    const { waited } = await timeOneRequest();
    assert(
      waited < MIN_REQUEST_GAP_MS,
      `nothing preceded this request, so it waited for nothing, not ${waited} ms`,
    );
  });
});

check('a second request inside one command waits out the gap', async () => {
  await isolated(async () => {
    await timeOneRequest();
    const { waited } = await timeOneRequest();
    assert(
      waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
      `the second request went out ${waited} ms after the first`,
    );
    assert(
      waited <= MAX_REQUEST_GAP_MS + SLACK_MS,
      `the second request waited ${waited} ms, past the longest gap there is`,
    );
  });
});

check('the clock survives the process, so the gap holds between two commands', async () => {
  await isolated(async (scratch) => {
    // A whole other Node process, which is what a second `avito get-item` is.
    execFileSync(process.execPath, [
      '-e',
      "const { pacedRequest } = await import(process.env.PACE_MODULE); await pacedRequest(async () => {});",
      '--input-type=module',
    ], {
      env: { ...process.env, AVITO_BROKER_DIR: scratch, PACE_MODULE },
    });
    const { waited } = await timeOneRequest();
    assert(
      waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
      `the next command's request went out ${waited} ms after the previous one`,
    );
    assert(fs.existsSync(paceClockFile()), 'the clock is a file, or it does not cross a process boundary');
  });
});

check('two requests started at once are served one gap apart', async () => {
  await isolated(async () => {
    const startedAt = Date.now();
    const [first, second] = await Promise.all([timeOneRequest(), timeOneRequest()]);
    const later = Math.max(first.waited, second.waited);
    assert(
      later >= MIN_REQUEST_GAP_MS - SLACK_MS,
      `the second of two concurrent requests waited only ${later} ms`,
    );
    assert(
      Date.now() - startedAt < MAX_REQUEST_GAP_MS * 3,
      'two requests must not cost three gaps',
    );
  });
});

check('a clock nobody can read buys a whole gap, never none', async () => {
  await isolated(async () => {
    fs.mkdirSync(path.dirname(paceClockFile()), { recursive: true });
    fs.writeFileSync(paceClockFile(), 'not json at all');
    const { waited } = await timeOneRequest();
    assert(
      waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
      `an unreadable clock let a request out after ${waited} ms`,
    );
  });
});

check('every gap drawn lands between the two constants', async () => {
  assert(MIN_REQUEST_GAP_MS < MAX_REQUEST_GAP_MS, 'the shortest gap must be shorter than the longest');
  const drawn = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const gap = nextGapMs();
    assert(Number.isInteger(gap), `a gap must be a whole number of milliseconds, not ${gap}`);
    assert(
      gap >= MIN_REQUEST_GAP_MS && gap <= MAX_REQUEST_GAP_MS,
      `${gap} ms is outside ${MIN_REQUEST_GAP_MS}–${MAX_REQUEST_GAP_MS} ms`,
    );
    drawn.add(gap);
  }
  assert(drawn.size > 1, 'the gap is drawn anew for each request, so 2000 draws are not one value');
  assert(
    describeRequestPace().includes(String(MIN_REQUEST_GAP_MS))
      && describeRequestPace().includes(String(MAX_REQUEST_GAP_MS)),
    'the report must name both ends of the pace in force',
  );
});

check('no argument and no environment variable shortens the gap', async () => {
  // The settings this pace used to have, and the ones next door that still
  // exist: none of them is allowed to be a rate control. Asserting the source
  // mentions no `process.env` would pass while the dependency sat one import
  // away, so what is checked is the wait itself.
  const meddling = {
    AVITO_REQUEST_GAP_MS: '0',
    AVITO_REQUEST_GAP: '0',
    AVITO_PACE: 'off',
    AVITO_BROKER: 'off',
  };
  const saved = Object.fromEntries(Object.keys(meddling).map((key) => [key, process.env[key]]));
  Object.assign(process.env, meddling);
  try {
    await isolated(async () => {
      await timeOneRequest();
      const { waited } = await timeOneRequest();
      assert(
        waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
        `an environment variable talked the gap down to ${waited} ms`,
      );
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // The gap reaches `pacedRequest` from `nextGapMs` and from nowhere a caller
  // can reach, so there is no argument to talk it down with either.
  assert(pacedRequest.length === 1, 'pacedRequest takes the request and nothing that sets its gap');
});

check('a lock left behind with a future mtime is stolen, not waited on', async () => {
  await isolated(async (scratch) => {
    // What a backward clock step leaves behind: `Date.now() - mtimeMs` is
    // negative forever, so an age-only staleness test never expires it and
    // every command on the machine hangs with no error and no recovery.
    const lock = path.join(scratch, 'pace.lock');
    fs.writeFileSync(lock, '999999');
    const hour = Date.now() + 3_600_000;
    fs.utimesSync(lock, new Date(hour), new Date(hour));

    const startedAt = Date.now();
    await timeOneRequest();
    assert(
      Date.now() - startedAt < LOCK_GIVE_UP_MS,
      'a lock dated in the future must be stolen rather than outlived',
    );
  });
});

check('an impossible clock cannot switch pacing off', async () => {
  await isolated(async () => {
    // A garbled but numeric `at` taken at face value overflows setTimeout's
    // 32-bit delay, which Node clamps to 1 ms — and the overflowed value gets
    // written back, so every later request on the machine skips its gap too.
    fs.mkdirSync(path.dirname(paceClockFile()), { recursive: true });
    fs.writeFileSync(paceClockFile(), JSON.stringify({ at: 1e18 }));

    const { waited } = await timeOneRequest();
    assert(
      waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
      `an impossible clock let a request out after ${waited} ms`,
    );
    const { at } = JSON.parse(fs.readFileSync(paceClockFile(), 'utf-8'));
    assert(
      at < Date.now() + CLOCK_CEILING_MS,
      `the clock was left at ${at}, so the next request skips its gap as well`,
    );
  });
});

check('an unwritable state directory buys a gap rather than a crash', async () => {
  await isolated(async (scratch) => {
    fs.chmodSync(scratch, 0o500);
    try {
      // Root ignores the mode, and a machine where the write still lands has
      // nothing for this check to observe.
      let writable = true;
      try {
        fs.writeFileSync(path.join(scratch, 'probe'), 'x');
        fs.rmSync(path.join(scratch, 'probe'));
      } catch {
        writable = false;
      }
      if (!writable) {
        const { waited } = await timeOneRequest();
        assert(
          waited >= MIN_REQUEST_GAP_MS - SLACK_MS,
          `a clock that cannot be written let a request out after ${waited} ms`,
        );
      }
    } finally {
      fs.chmodSync(scratch, 0o700);
    }
  });
});

check('a pacer that cannot stamp still lets the request error through', async () => {
  await isolated(async (scratch) => {
    // The 429 and the challenge are the whole diagnosis this CLI is built
    // around, and a throw from the `finally` that stamps the clock would
    // replace them with an errno nobody can act on.
    const refusal = new Error('Avito answered 429');
    let raised = null;
    let ran = false;
    fs.chmodSync(scratch, 0o500);
    try {
      await pacedRequest(async () => {
        ran = true;
        throw refusal;
      });
    } catch (error) {
      raised = error;
    } finally {
      fs.chmodSync(scratch, 0o700);
    }
    assert(ran, 'the request must still be attempted');
    assert(raised === refusal, `the caller saw ${raised && raised.message} instead of the refusal`);
  });
});

export default await run('Request pace (src/runtime/pace.mjs)');
