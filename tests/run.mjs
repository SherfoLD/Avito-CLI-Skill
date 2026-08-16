// Offline test entry point: no network, no browser, no Chrome.
// Usage: node tests/run.mjs   (after `npm install` at the repository root)
//
// The list below is the whole set. A suite that is listed but absent is
// reported rather than skipped quietly, so "everything passed" can never mean
// "nothing ran".
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  './schema.test.mjs',
  './lint-rules.test.mjs',
  './verify-fixtures.test.mjs',
  './prelude.test.mjs',
  './search.test.mjs',
  './search.page.test.mjs',
  './get-item.test.mjs',
  './get-page.test.mjs',
  './apply-filters.test.mjs',
  './get-filters.test.mjs',
  './get-categories.test.mjs',
  './move-category.test.mjs',
  './get-location.test.mjs',
  './get-coords.test.mjs',
  './get-seller-reviews.test.mjs',
];

const present = suites.filter((suite) => fs.existsSync(path.join(HERE, suite)));
const missing = suites.filter((suite) => !present.includes(suite));

let failed = 0;
for (const suite of present) {
  const module = await import(suite);
  failed += module.default ?? 0;
}

if (missing.length > 0) {
  console.log(`\nLISTED BUT MISSING (${missing.length} of ${suites.length}):`);
  for (const suite of missing) console.log(`  ${suite}`);
  console.log('A suite named here has to exist. Restore it or take it off the list.');
  process.exit(1);
}

console.log(failed === 0 ? '\nALL OFFLINE CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
