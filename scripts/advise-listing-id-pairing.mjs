#!/usr/bin/env node
/**
 * advise-listing-id-pairing.mjs — advisory, never a gate. Always exits 0.
 *
 * When a command returns a list of things and another command fetches one of
 * them, the list has to carry something the second command accepts. Without it
 * the caller has to search again by title, which is both slower and wrong
 * whenever two listings share a title.
 *
 * This is advisory because "should this list pair with a detail command" is a
 * judgment call: a list of filter keys or category names legitimately has
 * nothing to fetch. Read the report, do not obey it.
 *
 * Usage: node scripts/advise-listing-id-pairing.mjs
 */

import { loadManifest } from './lib/manifest.mjs';

/** Commands whose rows are individually fetchable things. */
const LISTING_NAMES = new Set(['search', 'get-page', 'apply-filters', 'move-category']);
/** Commands that fetch one thing by something a listing row could carry. */
const DETAIL_NAMES = new Set(['get-item', 'get-seller-reviews']);

const ID_COLUMN_PATTERNS = [/^id$/i, /Id$/, /_id$/i, /^url$/i, /^slug$/i];

const manifest = await loadManifest();
const detail = manifest.filter((entry) => DETAIL_NAMES.has(entry.name) && entry.access === 'read');
const listings = manifest.filter((entry) => LISTING_NAMES.has(entry.name));

if (manifest.length === 0) {
  console.log('No commands in src/commands yet — nothing to advise on.');
  process.exit(0);
}

console.log(`Checked ${listings.length} listing command(s) against ${detail.length} detail command(s).`);

const findings = listings.filter((entry) => !entry.columns.some((column) => ID_COLUMN_PATTERNS.some((pattern) => pattern.test(column))));

if (findings.length === 0) {
  console.log('OK - every listing carries a column a detail command can take.');
  process.exit(0);
}

console.log('');
for (const entry of findings) {
  console.log(`  • ${entry.name}`);
  console.log(`      columns: [${entry.columns.join(', ')}]`);
  console.log(`      detail commands: ${detail.map((item) => item.name).join(', ') || '(none)'}`);
}
console.log('\nAdvisory only. If a row genuinely has nothing to fetch, this is fine.');
