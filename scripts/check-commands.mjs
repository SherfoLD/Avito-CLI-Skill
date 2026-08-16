#!/usr/bin/env node
/**
 * check-commands.mjs — the rules that need two commands to see.
 *
 * What one command must satisfy is checked where it is declared: `defineCommand`
 * validates the descriptor and the row schema at import, so loading the manifest
 * is most of this check — a command that fails to import fails here.
 *
 *   write-without-delete-pair   a write command with no undo strands remote
 *                               state the caller cannot walk back. Nothing here
 *                               writes yet; this is the gate that has to be
 *                               answered on the day something does.
 *
 * Usage: node scripts/check-commands.mjs
 */

import { loadManifest } from './lib/manifest.mjs';

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
  console.log('\nA write command ships with the command that walks it back, or it does not ship.');
  process.exit(1);
}

console.log('OK - every command declares a reviewable contract.');
