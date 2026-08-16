#!/usr/bin/env node
/**
 * check-silent-column-drop.mjs — gate on rows that carry keys the descriptor
 * never declares.
 *
 * A dropped key is invisible in tabular output and present in JSON, so the two
 * formats of the same command disagree and `--help` describes neither.
 *
 * Usage:
 *   node scripts/check-silent-column-drop.mjs
 *   node scripts/check-silent-column-drop.mjs --update-baseline
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConventionAudit } from './lib/convention-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, 'silent-column-drop-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

const report = await runConventionAudit({});
const category = report.categories.find((item) => item.rule === 'silent-column-drop');
const current = sortRecords((category?.violations ?? []).map(toBaselineRecord));

if (UPDATE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Updated scripts/silent-column-drop-baseline.json with ${current.length} entr${current.length === 1 ? 'y' : 'ies'}.`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error('scripts/silent-column-drop-baseline.json not found. Run with --update-baseline.');
  process.exit(1);
}

const baseline = sortRecords(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')));
const baselineSignatures = new Set(baseline.map(signature));
const currentSignatures = new Set(current.map(signature));
const added = current.filter((record) => !baselineSignatures.has(signature(record)));
const resolved = baseline.filter((record) => !currentSignatures.has(signature(record)));

console.log(`Silent-column-drop: current=${current.length}, baseline=${baseline.length}, new=${added.length}, resolved=${resolved.length}`);

if (resolved.length > 0) {
  console.log('\nBaseline entries no longer present — shrink the baseline:');
  for (const record of resolved) console.log(`  - ${record.command} ${record.file} missing=[${record.missing.join(', ')}]`);
}

if (added.length === 0) {
  console.log('OK - no new silent-column-drop violations.');
  process.exit(0);
}

console.log('\nNew silent-column-drop violations:');
for (const record of added) console.log(`  - ${record.command} ${record.file} missing=[${record.missing.join(', ')}]`);
console.log('\nEither declare the key as a column or stop emitting it. Changing the column list also changes verify/<command>.json.');
process.exit(1);

function toBaselineRecord(violation) {
  const missing = Array.isArray(violation.details?.missing) ? violation.details.missing.map(String).sort() : [];
  return {
    command: String(violation.command ?? ''),
    file: String(violation.file ?? ''),
    missing,
  };
}

function signature(record) {
  return `${record.command}\0${record.file}\0${record.missing.join('\0')}`;
}

function sortRecords(records) {
  return records
    .map((record) => ({
      command: String(record.command),
      file: String(record.file),
      missing: Array.isArray(record.missing) ? record.missing.map(String).sort() : [],
    }))
    .sort((a, b) => signature(a).localeCompare(signature(b)));
}
