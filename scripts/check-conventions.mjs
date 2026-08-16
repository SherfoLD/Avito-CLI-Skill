#!/usr/bin/env node
/**
 * check-conventions.mjs — the full convention report, and a gate on the rules
 * that have no baseline.
 *
 * Four rules fail the build immediately (`missing-access-metadata`,
 * `column-naming`, `hardcoded-site-vocabulary`, `write-without-delete-pair`):
 * each is precise, and each has an obvious fix that is never "record it and
 * move on". The four `silent-*` rules are reported here for reading and gated
 * against a baseline by `check-typed-error-lint.mjs` and
 * `check-silent-column-drop.mjs`.
 *
 * Usage:
 *   node scripts/check-conventions.mjs            # every command
 *   node scripts/check-conventions.mjs search     # one command
 *   node scripts/check-conventions.mjs --json
 */

import { runConventionAudit, renderConventionAuditText, HARD_RULES } from './lib/convention-audit.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const target = argv.find((arg) => !arg.startsWith('-'));

const report = await runConventionAudit({ target });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderConventionAuditText(report));
}

if (report.summary.commands === 0) {
  console.log('No commands in src/commands yet — nothing to audit.');
  process.exit(0);
}

const blocking = report.categories
  .filter((category) => HARD_RULES.includes(category.rule))
  .reduce((total, category) => total + category.count, 0);

if (blocking > 0) {
  console.log(`FAIL — ${blocking} violation(s) of a rule that has no baseline.`);
  process.exit(1);
}

console.log('OK — no violations of the ungated rules.');
