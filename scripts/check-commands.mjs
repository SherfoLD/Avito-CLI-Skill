#!/usr/bin/env node
/**
 * check-commands.mjs — the two rules `defineCommand` cannot check on its own.
 *
 * Most of what one command must satisfy is checked where it is declared, so
 * loading the manifest is most of this check: a command that fails to import
 * fails here.
 *
 *   type-in-step                `type` is written by hand and `output` is the
 *                               schema that is actually enforced. Nothing keeps
 *                               them together except this: a name in one and not
 *                               the other is a printed contract that lies.
 *   write-without-delete-pair   a write command with no undo strands remote
 *                               state the caller cannot walk back. Nothing here
 *                               writes yet; this is the gate that has to be
 *                               answered on the day something does.
 *
 * Usage: node scripts/check-commands.mjs
 */

import { declaredKeyNames } from '../src/runtime/schema.mjs';
import { loadManifest } from './lib/manifest.mjs';

/** A field name in a TypeScript body: an identifier that opens a line. */
const TYPE_FIELD = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\??:/gm;

const WRITE_PAIRS = [
  { match: /(^|[-_])favorite($|[-_])/, describe: 'favorite', undo: (name) => [name.replace(/favorite/g, 'unfavorite'), 'unfavorite', 'remove-favorite'] },
  { match: /(^|[-_])add($|[-_])/, describe: 'add', undo: (name) => [name.replace(/add/g, 'remove'), 'remove', 'delete'] },
  { match: /(^|[-_])create($|[-_])/, describe: 'create', undo: (name) => [name.replace(/create/g, 'delete'), name.replace(/create/g, 'remove'), 'delete', 'remove'] },
  { match: /(^|[-_])save($|[-_])/, describe: 'save', undo: (name) => [name.replace(/save/g, 'unsave'), 'unsave', 'delete', 'remove'] },
  { match: /(^|[-_])subscribe($|[-_])/, describe: 'subscribe', undo: (name) => [name.replace(/subscribe/g, 'unsubscribe'), 'unsubscribe'] },
];

const manifest = await loadManifest();
const names = new Set(manifest.map((entry) => entry.name));
const problems = [];

for (const entry of manifest) {
  const declared = declaredKeyNames(entry.output);
  const printed = new Set([...entry.type.matchAll(TYPE_FIELD)].map((match) => match[1]));

  const missing = [...declared].filter((key) => !printed.has(key));
  if (missing.length > 0) {
    problems.push(`${entry.name}: output declares ${missing.join(', ')}, and 'type' does not print ${missing.length === 1 ? 'it' : 'them'}`);
  }
  const invented = [...printed].filter((key) => !declared.has(key));
  if (invented.length > 0) {
    problems.push(`${entry.name}: 'type' prints ${invented.join(', ')}, which the output schema does not declare`);
  }
}

for (const entry of manifest) {
  if (entry.access !== 'write') continue;
  const pair = WRITE_PAIRS.find((rule) => rule.match.test(entry.name));
  if (!pair) continue;
  const undo = [...new Set(pair.undo(entry.name))].filter((name) => name !== entry.name);
  if (undo.some((name) => names.has(name))) continue;
  problems.push(
    `${entry.name}: a write command that looks like ${pair.describe} but nothing undoes it `
    + `(expected one of: ${undo.join(', ')})`,
  );
}

const writes = manifest.filter((entry) => entry.access === 'write').length;
console.log(`Commands: ${manifest.length} loaded, ${manifest.length - writes} read-only, ${writes} write.`);

for (const problem of problems) console.log(`  FAIL  ${problem}`);

if (problems.length > 0) {
  console.log('\n`type` is what --help prints and `output` is what the CLI enforces. They say the'
    + '\nsame thing or the printed contract is a lie. A write command ships with the'
    + '\ncommand that walks it back, or it does not ship.');
  process.exit(1);
}

console.log('OK - every command declares a reviewable contract, and prints the one it enforces.');
