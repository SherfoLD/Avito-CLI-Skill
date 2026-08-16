#!/usr/bin/env node
/**
 * check-verify-fixtures.mjs — static gate over `verify/`.
 *
 * Runs without a browser and without Avito. It answers three questions:
 *
 *   1. Does every command have a fixture? A command without one has no check
 *      that looks at real values, so a decoder reading the wrong field would
 *      pass every offline suite.
 *   2. Is every fixture well formed? A typo in a key name is silently ignored
 *      by a matcher that only looks at keys it knows, which turns a rule the
 *      author believed they wrote into no rule at all.
 *   3. Does `expect.columns` still match the command descriptor, exactly and in
 *      order? That equality is what pins the row shape across the four commands
 *      that share it.
 *
 * It also warns about a fixture that carries neither `patterns` nor `notEmpty`:
 * that is a seed nobody hardened, and it will pass against almost any output.
 *
 * Usage: node scripts/check-verify-fixtures.mjs
 */

import { loadManifest } from './lib/manifest.mjs';
import { listFixtures, loadFixture, validateFixtureSchema } from './lib/verify-fixture.mjs';
import { relativeToRoot } from './lib/paths.mjs';

const manifest = await loadManifest();
const fixtures = listFixtures();
const byCommand = new Map(manifest.map((entry) => [entry.name, entry]));

const errors = [];
const warnings = [];

for (const entry of manifest) {
  if (!fixtures.some((fixture) => fixture.command === entry.name)) {
    errors.push(`${entry.name}: verify/${entry.name}.json is missing — every command needs one`);
  }
}

for (const { command, file } of fixtures) {
  let fixture;
  try {
    fixture = loadFixture(command);
  } catch (error) {
    errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const descriptor = byCommand.get(command);
  if (!descriptor && manifest.length > 0) {
    warnings.push(`${command}: ${relativeToRoot(file)} has no command in src/commands`);
  }

  const problems = validateFixtureSchema(fixture, { declaredColumns: descriptor?.columns });
  for (const problem of problems) errors.push(`${command}: ${problem}`);

  const expect = fixture?.expect ?? {};
  const hasPatterns = expect.patterns && Object.keys(expect.patterns).length > 0;
  const hasNotEmpty = Array.isArray(expect.notEmpty) && expect.notEmpty.length > 0;
  if (!hasPatterns && !hasNotEmpty) {
    warnings.push(`${command}: no patterns and no notEmpty — this is an untightened seed, not a check`);
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
