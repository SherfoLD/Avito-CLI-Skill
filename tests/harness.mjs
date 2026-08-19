// Offline harness: `loadCommand` for a command module and its descriptor,
// `assertRows` for what a command returned against the contract it declares,
// and the check runner.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRows } from '../src/runtime/schema.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function readCommandSource(name) {
  return readFileSync(join(PROJECT_ROOT, 'src', 'commands', `${name}.mjs`), 'utf8');
}

export function readPageSource(name) {
  return readFileSync(join(PROJECT_ROOT, 'src', 'browser', 'commands', `${name}.mjs`), 'utf8');
}

/**
 * Import a command module. `COMMAND` is its descriptor; the names in
 * `exportNames` must be real named exports.
 *
 * That list is not decoration. The suites name the helpers they test, so the
 * boundary between the node half and the browser half is pinned by the offline
 * set rather than by whoever last edited the file: an export that quietly moves
 * or disappears fails here instead of silently losing its coverage.
 */
export async function loadCommand(name, exportNames = []) {
  const module = await import(`../src/commands/${name}.mjs`);
  const missing = exportNames.filter((exportName) => module[exportName] === undefined);
  if (missing.length > 0) {
    throw new Error(`src/commands/${name}.mjs no longer exports: ${missing.join(', ')}`);
  }
  return { ...module, COMMAND: module.default };
}

/**
 * Parse what a command returned through the contract it declares — the same
 * parse `bin/avito.mjs` runs before printing, so a suite cannot pass on a row a
 * caller would never be given.
 */
export function assertRows(command, rows) {
  return parseRows(command.row, rows, command.name);
}

/** The same, for a suite that built exactly one row. */
export function assertRow(command, row) {
  return assertRows(command, [row])[0];
}

/** The error a call threw, or null if it did not throw. */
export async function failureOf(call) {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return null;
}

export function runner() {
  const checks = [];
  return {
    check: (name, fn) => checks.push([name, fn]),
    assert: (condition, message) => { if (!condition) throw new Error(message); },
    async run(title) {
      let failed = 0;
      console.log(`\n${title}`);
      for (const [name, fn] of checks) {
        try {
          await fn();
          console.log(`  PASS  ${name}`);
        } catch (error) {
          failed += 1;
          console.log(`  FAIL  ${name}\n        ${error.message}`);
        }
      }
      return failed;
    },
  };
}
