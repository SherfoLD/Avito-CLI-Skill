#!/usr/bin/env node
/**
 * check-verify-fixtures.mjs — static gate over `verify/`.
 *
 * Runs without a browser and without Avito. It answers three questions:
 *
 *   1. Does every command have a fixture? A command without one has no check
 *      that looks at real values, so a decoder reading the wrong field would
 *      pass every offline suite.
 *   2. Does every fixture load and export a `rows` schema over the returned
 *      array? A fixture that throws on import is a live check nobody runs.
 *   3. Does it constrain something a schema does not already guarantee, and does
 *      every column it names exist? A rule about a column the command never
 *      returns can never fire, and neither can a fixture that says nothing.
 *
 * Usage: node scripts/check-verify-fixtures.mjs
 */

import { loadManifest } from './lib/manifest.mjs';
import { listFixtures, loadFixture, validateFixture } from './lib/verify-fixture.mjs';
import { relativeToRoot } from './lib/paths.mjs';

const manifest = await loadManifest();
const fixtures = listFixtures();
const byCommand = new Map(manifest.map((entry) => [entry.name, entry]));

const errors = [];
const warnings = [];

for (const entry of manifest) {
  if (!fixtures.some((fixture) => fixture.command === entry.name)) {
    errors.push(`${entry.name}: verify/${entry.name}.mjs is missing — every command needs one`);
  }
}

for (const { command, file } of fixtures) {
  let fixture;
  try {
    fixture = await loadFixture(command);
  } catch (error) {
    errors.push(`${command}: ${error.message}`);
    continue;
  }

  const descriptor = byCommand.get(command);
  if (!descriptor && manifest.length > 0) {
    warnings.push(`${command}: ${relativeToRoot(file)} has no command in src/commands`);
  }

  for (const problem of validateFixture(fixture, { declaredColumns: descriptor?.columns })) {
    errors.push(`${command}: ${problem}`);
  }
  if (!('args' in fixture)) {
    warnings.push(`${command}: no args — the fixture will run the command with none`);
  }
}

console.log(`Verify fixtures: ${fixtures.length} fixture(s), ${manifest.length} command(s).`);

for (const warning of warnings) console.log(`  warn  ${warning}`);
for (const error of errors) console.log(`  FAIL  ${error}`);

if (errors.length > 0) {
  console.log(`\n${errors.length} problem(s). A fixture is tightened to match the command, never loosened to match its output.`);
  process.exit(1);
}

console.log('OK - every fixture is well formed and agrees with its command.');
