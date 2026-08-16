#!/usr/bin/env node
/**
 * check-typed-error-lint.mjs — gate on newly introduced silent failures.
 *
 * The three rules here (`silent-clamp`, `silent-empty-fallback`,
 * `silent-sentinel`) describe code that succeeds while lying. The baseline
 * starts empty and should stay empty: a command written to this repository's
 * rules has no reason to add an entry. `--update-baseline` exists for a
 * deliberate, reviewed decision — not for making a red build green.
 *
 * Usage:
 *   node scripts/check-typed-error-lint.mjs
 *   node scripts/check-typed-error-lint.mjs --update-baseline
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConventionAudit } from './lib/convention-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, 'typed-error-lint-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');
const RULES = new Set(['silent-clamp', 'silent-empty-fallback', 'silent-sentinel']);

const report = await runConventionAudit({});
const current = addOccurrenceIndexes(sortRecords(
  report.categories
    .filter((category) => RULES.has(category.rule))
    .flatMap((category) => category.violations.map(toBaselineRecord)),
));

if (UPDATE) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Updated scripts/typed-error-lint-baseline.json with ${current.length} entr${current.length === 1 ? 'y' : 'ies'}.`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error('scripts/typed-error-lint-baseline.json not found. Run with --update-baseline.');
  process.exit(1);
}

const baseline = addOccurrenceIndexes(sortRecords(JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))));
const baselineSignatures = new Set(baseline.map(signature));
const currentSignatures = new Set(current.map(signature));
const added = current.filter((record) => !baselineSignatures.has(signature(record)));
const resolved = baseline.filter((record) => !currentSignatures.has(signature(record)));

console.log(`Typed-error lint: current=${current.length}, baseline=${baseline.length}, new=${added.length}, resolved=${resolved.length}`);

if (resolved.length > 0) {
  console.log('\nBaseline entries no longer present — shrink the baseline:');
  for (const record of resolved) console.log(`  - ${record.rule} ${record.command} ${record.file}:${record.line}`);
}

if (added.length === 0) {
  console.log('OK - no new typed-error lint violations.');
  process.exit(0);
}

console.log('\nNew typed-error lint violations:');
for (const record of added) {
  console.log(`  - ${record.rule} ${record.command} ${record.file}:${record.line}`);
  if (record.text) console.log(`    ${record.text}`);
}
console.log('\nFix the silent fallback. Updating the baseline is a reviewed decision, not a repair.');
process.exit(1);

function toBaselineRecord(violation) {
  return {
    rule: String(violation.rule ?? ''),
    command: String(violation.command ?? ''),
    file: String(violation.file ?? ''),
    line: Number(violation.line ?? 0),
    text: String(violation.details?.text ?? ''),
  };
}

function signature(record) {
  return `${record.rule}\0${record.command}\0${record.file}\0${record.text}\0${record.occurrence}`;
}

function sortRecords(records) {
  return records
    .map((record) => ({
      rule: String(record.rule),
      command: String(record.command),
      file: String(record.file),
      line: Number(record.line ?? 0),
      text: String(record.text ?? ''),
      occurrence: Number(record.occurrence ?? 0),
    }))
    .sort((a, b) => stableOrder(a).localeCompare(stableOrder(b)));
}

function addOccurrenceIndexes(records) {
  const seen = new Map();
  return records.map((record) => {
    const key = `${record.rule}\0${record.command}\0${record.file}\0${record.text}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { ...record, occurrence };
  });
}

function stableOrder(record) {
  return `${record.rule}\0${record.command}\0${record.file}\0${record.text}\0${record.line}`;
}
