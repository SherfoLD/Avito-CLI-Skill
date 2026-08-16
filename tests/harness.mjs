// Offline harness: `loadCommand` for a command module and its descriptor,
// `assertDeclaredColumns` for a returned row against the columns it declares,
// and the check runner.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function readCommandSource(name) {
  return readFileSync(join(PROJECT_ROOT, 'src', 'commands', `${name}.mjs`), 'utf8');
}

export function readDecoderSource(name) {
  return readFileSync(join(PROJECT_ROOT, 'src', 'decoders', `${name}.mjs`), 'utf8');
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
 * A returned row must fill exactly the columns the command declares: a key renamed in one
 * of the two places (the `columns` list or the row mapping) is a silent contract drift the
 * decoder checks cannot see.
 */
export function assertDeclaredColumns(command, row) {
  const keys = Object.keys(row);
  if (keys.length !== command.columns.length) {
    throw new Error(`row has ${keys.length} keys, ${command.columns.length} columns declared: ${keys.join(',')}`);
  }
  for (const column of command.columns) {
    if (!(column in row)) throw new Error(`declared column ${column} is missing from the row`);
  }
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
