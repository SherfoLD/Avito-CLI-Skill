#!/usr/bin/env node
/**
 * verify.mjs — the live check: run a command for real and apply its fixture.
 *
 * This is the only check in the repository that sees real values coming back
 * from Avito. The offline suites run against a synthetic carrier, so they
 * cannot tell a correct decoder from one that confidently reads the wrong
 * field; that is what these fixtures are for.
 *
 * It runs the CLI as a subprocess rather than importing the command, because
 * what needs verifying is what a caller actually gets: argv parsing, the row
 * shape on stdout and the exit code, not an in-process return value.
 *
 * Nothing here retries. A refusal is the result — a `429`, a challenge or a
 * drifted shape is reported with its typed error and the run fails. Re-running
 * a rejected request is exactly what this repository does not do.
 *
 * Usage:
 *   node scripts/verify.mjs            # every fixture, one after another
 *   node scripts/verify.mjs search     # one command
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROJECT_ROOT } from './lib/paths.mjs';
import {
  expandFixtureArgs,
  listFixtures,
  loadFixture,
  validateRowShape,
  validateRows,
} from './lib/verify-fixture.mjs';

const CLI = path.join(PROJECT_ROOT, 'bin', 'avito.mjs');

function runCommand(command, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, command, ...argv, '-f', 'json'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function verifyOne(command) {
  const fixture = loadFixture(command);
  if (!fixture) return { command, failures: [{ rule: 'fixture', detail: `verify/${command}.json is missing` }] };

  const argv = expandFixtureArgs(fixture.args);
  console.log(`\navito ${command} ${argv.join(' ')}`);

  const result = await runCommand(command, argv);
  if (result.code !== 0) {
    return {
      command,
      failures: [{
        rule: 'exit',
        detail: `the command exited ${result.code}: ${result.stderr.trim() || '(no message)'}`,
      }],
    };
  }

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch (error) {
    return {
      command,
      failures: [{ rule: 'output', detail: `stdout is not JSON: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (!Array.isArray(rows)) {
    return { command, failures: [{ rule: 'output', detail: 'the command printed something other than an array of rows' }] };
  }

  const failures = [...validateRows(rows, fixture), ...validateRowShape(rows)];
  if (failures.length === 0) console.log(`  OK — ${rows.length} row(s) satisfy verify/${command}.json`);
  return { command, failures, rowCount: rows.length };
}

const target = process.argv[2];
const known = listFixtures().map((fixture) => fixture.command);

if (target && !known.includes(target)) {
  console.error(`"${target}" has no fixture in verify/. Known: ${known.join(', ')}`);
  process.exit(1);
}

// A fixture whose command has not been converted yet is not a failure, and it
// is not a silent skip either: reporting it is what keeps "all live checks
// passed" from quietly meaning "two of the ten ran".
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'commands');
const built = new Set(
  fs.existsSync(COMMANDS_DIR)
    ? fs.readdirSync(COMMANDS_DIR).filter((entry) => entry.endsWith('.mjs')).map((entry) => entry.replace(/\.mjs$/, ''))
    : [],
);

const wanted = (target ? [target] : known).filter((command) => built.has(command));
const pending = (target ? [target] : known).filter((command) => !built.has(command));

const results = [];
for (const command of wanted) {
  results.push(await verifyOne(command));
}

if (pending.length > 0) {
  console.log(`\nNot yet converted (${pending.length} of ${known.length}): ${pending.join(', ')}`);
}
if (wanted.length === 0) {
  console.log('\nNo converted command has a fixture to run.');
  process.exit(0);
}

let failed = 0;
for (const result of results) {
  if (result.failures.length === 0) continue;
  failed += 1;
  console.log(`\nFAIL  ${result.command}`);
  for (const failure of result.failures) {
    const where = failure.rowIndex === undefined ? '' : ` [row ${failure.rowIndex}]`;
    console.log(`  ${failure.rule}${where}: ${failure.detail}`);
  }
}

console.log(failed === 0
  ? `\nALL LIVE CHECKS PASSED (${results.length} command(s))`
  : `\n${failed} COMMAND(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
