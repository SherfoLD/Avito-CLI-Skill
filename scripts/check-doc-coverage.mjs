#!/usr/bin/env node
/**
 * check-doc-coverage.mjs — every command belongs to exactly one domain file.
 *
 * `docs/areas/` holds one file per group of commands, and its first heading
 * names the commands it covers in backticks. That is the index the next session
 * reads before touching anything, so a command missing from it is a command
 * whose decisions and observations have nowhere to live and will be rediscovered
 * from scratch.
 *
 * Membership only: flags and columns live in the descriptor, never in markdown.
 *
 * Usage: node scripts/check-doc-coverage.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { DOCS_DIR } from './lib/paths.mjs';
import { loadManifest } from './lib/manifest.mjs';

const AREAS_DIR = path.join(DOCS_DIR, 'areas');
const manifest = await loadManifest();

if (!fs.existsSync(AREAS_DIR)) {
  console.error('docs/areas/ is missing.');
  process.exit(1);
}

const covered = new Map();
for (const file of fs.readdirSync(AREAS_DIR).filter((entry) => entry.endsWith('.md')).sort()) {
  const full = path.join(AREAS_DIR, file);
  const heading = fs.readFileSync(full, 'utf-8').split(/\r?\n/).find((line) => line.startsWith('# ')) ?? '';
  for (const match of heading.matchAll(/`([a-z][a-z0-9-]*)`/g)) {
    const name = match[1];
    if (!covered.has(name)) covered.set(name, []);
    covered.get(name).push(`docs/areas/${file}`);
  }
}

const missing = manifest.filter((entry) => !covered.has(entry.name));
const duplicated = [...covered.entries()].filter(([, files]) => files.length > 1);
const commandNames = new Set(manifest.map((entry) => entry.name));
const orphaned = manifest.length === 0 ? [] : [...covered.keys()].filter((name) => !commandNames.has(name));

console.log(`Doc coverage: ${manifest.length - missing.length}/${manifest.length} command(s) claimed by a domain file.`);

for (const [name, files] of duplicated) {
  console.log(`  FAIL  ${name} is claimed by ${files.join(' and ')} — a command has one home`);
}
for (const entry of missing) {
  console.log(`  FAIL  ${entry.name} appears in no docs/areas/*.md heading`);
}
for (const name of orphaned) {
  console.log(`  warn  docs/areas mentions ${name}, which is not a command`);
}

if (missing.length > 0 || duplicated.length > 0) {
  console.log('\nAdd the command to the heading of the domain file that owns it, or create the file.');
  process.exit(1);
}

console.log('OK - every command has a domain file.');
