/**
 * How shared code reaches the page.
 *
 * `Function.prototype.toString()` is what crosses the CDP boundary, and a
 * serialized function carries none of its imports. So the modules in
 * `src/browser/` are inlined — every export concatenated into one scope, with
 * the command's own function evaluated inside it. In the page the names resolve
 * to those inlined declarations; in Node they resolve to ordinary `import`s, so
 * the offline suite runs the same code the browser runs.
 *
 * That costs two rules, and this module enforces both:
 *
 *   1. Every top-level declaration in `src/browser/` is exported. An unexported
 *      one is invisible here, so it would exist in Node and be a ReferenceError
 *      in the page — the worst possible split, because the offline suite would
 *      stay green.
 *   2. An export is either a function declaration or a JSON-serializable value.
 *      A regular expression or a Map at module level cannot be reconstructed
 *      from `toString()`, so anything of that kind has to live inside a
 *      function.
 *
 * The whole prelude is shipped on every call rather than selected per command.
 * Choosing would mean maintaining a dependency list by hand, and forgetting an
 * entry fails only in the browser; a few kilobytes of expression is not worth
 * that class of bug.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BROWSER_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'browser');
const UNEXPORTED_TOP_LEVEL = /^(?:const|let|var|function|async function|class)\s/;

let cached = null;

function assertOnlyExportedDeclarations(file, source) {
  const offenders = source
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => UNEXPORTED_TOP_LEVEL.test(entry.line));
  if (offenders.length > 0) {
    throw new Error(
      `${file} declares ${offenders.map((entry) => `line ${entry.number}`).join(', ')} at top level without export. `
      + 'Everything in src/browser/ must be exported or it will not exist in the page.',
    );
  }
}

function emit(file, name, value) {
  if (typeof value === 'function') {
    const source = value.toString();
    if (!/^(?:async\s+)?function\s/.test(source)) {
      throw new Error(
        `${file} exports ${name} as an arrow or method shorthand. `
        + 'Exports here must be function declarations, so the inlined source is a declaration too.',
      );
    }
    return source;
  }
  let literal;
  try {
    literal = JSON.stringify(value);
  } catch {
    literal = undefined;
  }
  if (literal === undefined) {
    throw new Error(
      `${file} exports ${name}, which is neither a function nor JSON-serializable. `
      + 'Move it inside a function — a value like a RegExp cannot be rebuilt from source here.',
    );
  }
  return `const ${name} = ${literal};`;
}

/** Declarations hoist, so the order of files and exports does not matter. */
export async function browserPreludeSource() {
  if (cached != null) return cached;
  const parts = [];
  for (const entry of fs.readdirSync(BROWSER_DIR).sort()) {
    if (!entry.endsWith('.mjs')) continue;
    const filePath = path.join(BROWSER_DIR, entry);
    assertOnlyExportedDeclarations(entry, fs.readFileSync(filePath, 'utf-8'));
    const module = await import(pathToFileURL(filePath).href);
    for (const [name, value] of Object.entries(module)) {
      parts.push(emit(entry, name, value));
    }
  }
  cached = parts.join('\n');
  return cached;
}
