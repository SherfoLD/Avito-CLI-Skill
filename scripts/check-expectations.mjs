#!/usr/bin/env node
/**
 * check-expectations.mjs — static gate over `expectations/`.
 *
 * Runs without a browser and without Avito. It answers three questions:
 *
 *   1. Does every command have one? A command without it has no check that looks
 *      at real values, so a decoder reading the wrong field would pass every
 *      offline suite.
 *   2. Does every file load and export an `output` schema over the whole answer?
 *      One that throws on import is a live check nobody runs.
 *   3. Does it constrain something the schema does not already guarantee, and
 *      does every field it names exist? A rule about a field the command never
 *      returns can never fire, and neither can one that says nothing.
 *
 * Usage: node scripts/check-expectations.mjs
 */

import { loadManifest } from './lib/manifest.mjs';
import { listExpectations, loadExpectation, validateExpectation } from './lib/expectation.mjs';
import { relativeToRoot } from './lib/paths.mjs';

const manifest = await loadManifest();
const expectations = listExpectations();
const byCommand = new Map(manifest.map((entry) => [entry.name, entry]));

const errors = [];
const warnings = [];

for (const entry of manifest) {
  if (!expectations.some((expectation) => expectation.command === entry.name)) {
    errors.push(`${entry.name}: expectations/${entry.name}.mjs is missing — every command needs one`);
  }
}

for (const { command, file } of expectations) {
  let expectation;
  try {
    expectation = await loadExpectation(command);
  } catch (error) {
    errors.push(`${command}: ${error.message}`);
    continue;
  }

  const descriptor = byCommand.get(command);
  if (!descriptor && manifest.length > 0) {
    warnings.push(`${command}: ${relativeToRoot(file)} has no command in src/commands`);
  }

  for (const problem of validateExpectation(expectation, { outputSchema: descriptor?.output })) {
    errors.push(`${command}: ${problem}`);
  }
  if (!('args' in expectation)) {
    warnings.push(`${command}: no args — the command will run with none`);
  }
}

console.log(`Expectations: ${expectations.length} file(s), ${manifest.length} command(s).`);

for (const warning of warnings) console.log(`  warn  ${warning}`);
for (const error of errors) console.log(`  FAIL  ${error}`);

if (errors.length > 0) {
  console.log(`\n${errors.length} problem(s). An expectation is tightened to match the command, never loosened to match its output.`);
  process.exit(1);
}

console.log('OK - every expectation is well formed and agrees with its command.');
