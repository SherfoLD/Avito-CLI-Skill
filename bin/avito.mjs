#!/usr/bin/env node
/**
 * `avito` — the CLI entry point: find the command, parse its declared arguments,
 * open one browser context, print the rows. Every rule about what an argument
 * may be lives in the descriptor, and `--help` is generated from it.
 *
 * An unknown flag is refused rather than ignored: a caller who mistypes
 * `--location` for `--location-id` would otherwise get a plausible page for the
 * wrong region with no way to tell.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ArgumentError, CliError, EXIT_CODES, exitCodeFor } from '../src/runtime/errors.mjs';
import { brokerEnabled, openBrowserContext } from '../src/runtime/cdp.mjs';
import { liveBroker, stopBroker } from '../src/runtime/broker-client.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'commands');
const FORMATS = new Set(['json', 'table']);

async function loadCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) return new Map();
  const commands = new Map();
  for (const entry of fs.readdirSync(COMMANDS_DIR).sort()) {
    if (!entry.endsWith('.mjs') || entry.startsWith('_') || entry.includes('.test.')) continue;
    const module = await import(pathToFileURL(path.join(COMMANDS_DIR, entry)).href);
    const descriptor = module.default;
    if (!descriptor?.name) throw new Error(`${entry} does not default-export a command descriptor`);
    commands.set(descriptor.name, descriptor);
  }
  return commands;
}

function usage(commands) {
  const lines = ['avito <command> [arguments] [--format json|table]', '', 'Commands:'];
  const width = Math.max(...[...commands.keys()].map((name) => name.length), 1);
  for (const descriptor of commands.values()) {
    lines.push(`  ${descriptor.name.padEnd(width)}  ${firstSentence(descriptor.description)}`);
  }
  lines.push('', 'Run `avito <command> --help` for the arguments of one command.');
  lines.push('');
  lines.push('The browser is a Chromium you already own. Three ways to reach it:');
  lines.push('  --browser-profile <dir>  a running browser with chrome://inspect debugging on');
  lines.push('  --browser-url <url>      a browser started with --remote-debugging-port');
  lines.push('  --browser-ws <ws://…>    the browser socket directly');
  lines.push('AVITO_BROWSER_PROFILE, AVITO_BROWSER_URL and AVITO_BROWSER_WS do the same.');
  lines.push('');
  lines.push('The connection is held by a session broker, so the browser is approached once');
  lines.push('rather than once per command: `avito session status`, `avito session stop`.');
  lines.push('AVITO_BROKER=off connects directly on every command instead.');
  return lines.join('\n');
}

function commandHelp(descriptor) {
  const lines = [`avito ${descriptor.name} — ${descriptor.description}`, ''];
  const positional = descriptor.args.filter((arg) => arg.positional);
  const named = descriptor.args.filter((arg) => !arg.positional);
  const signature = [
    'avito',
    descriptor.name,
    ...positional.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)),
    named.length > 0 ? '[options]' : '',
  ].filter(Boolean).join(' ');
  lines.push(`Usage: ${signature}`, '');

  if (positional.length > 0) {
    lines.push('Arguments:');
    for (const arg of positional) lines.push(`  ${arg.name}  ${arg.help}`);
    lines.push('');
  }
  if (named.length > 0) {
    const width = Math.max(...named.map((arg) => arg.name.length + (arg.type === 'bool' ? 2 : arg.type.length + 5)));
    lines.push('Options:');
    for (const arg of named) {
      const label = arg.type === 'bool' ? `--${arg.name}` : `--${arg.name} <${arg.type}>`;
      lines.push(`  ${label.padEnd(width + 2)}  ${arg.help}`);
    }
    lines.push('');
  }
  lines.push('Columns:', `  ${descriptor.columns.join(', ')}`, '');
  if (descriptor.example) lines.push('Example:', `  ${descriptor.example}`, '');
  return lines.join('\n');
}

function firstSentence(text) {
  const stop = text.indexOf('. ');
  return stop > 0 ? text.slice(0, stop + 1) : text;
}

/**
 * Parse argv against the descriptor. Positional arguments are consumed in the
 * order they were declared; everything else must be a declared flag.
 */
function parseArguments(descriptor, argv) {
  const byName = new Map(descriptor.args.map((arg) => [arg.name, arg]));
  const positional = descriptor.args.filter((arg) => arg.positional);
  const parsed = {};
  const seenPositional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      const slot = positional[seenPositional.length];
      if (!slot) throw new ArgumentError(`unexpected argument "${token}"`);
      seenPositional.push(slot.name);
      parsed[slot.name] = token;
      continue;
    }
    const [flag, inlineValue] = splitFlag(token.slice(2));
    const declared = byName.get(flag);
    if (!declared || declared.positional) {
      throw new ArgumentError(`unknown option --${flag}`, `run \`avito ${descriptor.name} --help\` for the declared arguments`);
    }
    if (declared.type === 'bool') {
      if (inlineValue != null && inlineValue !== 'true' && inlineValue !== 'false') {
        throw new ArgumentError(`--${flag} is a flag and takes no value`);
      }
      parsed[flag] = inlineValue == null ? true : inlineValue === 'true';
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value == null) throw new ArgumentError(`--${flag} needs a value`);
    parsed[flag] = declared.type === 'int' ? asInteger(flag, value) : value;
  }

  for (const arg of descriptor.args) {
    if (arg.required && parsed[arg.name] == null) {
      throw new ArgumentError(`${arg.name} is required`, arg.help);
    }
    if (parsed[arg.name] == null && arg.default !== undefined) parsed[arg.name] = arg.default;
  }
  return parsed;
}

function splitFlag(token) {
  const equals = token.indexOf('=');
  return equals < 0 ? [token, null] : [token.slice(0, equals), token.slice(equals + 1)];
}

function asInteger(flag, value) {
  if (!/^-?\d+$/.test(String(value))) throw new ArgumentError(`--${flag} must be an integer`);
  return Number(value);
}

function renderTable(rows, columns) {
  if (rows.length === 0) return '';
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return String(value.length);
    return String(value);
  };
  const widths = columns.map((column) => Math.max(
    column.length,
    ...rows.map((row) => cell(row[column]).length),
  ));
  const line = (values) => values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join('\n');
}

async function runSessionSubcommand(subcommand) {
  if (subcommand === 'stop') {
    const stopped = await stopBroker();
    console.log(stopped ? 'session closed' : 'no session was open');
    return EXIT_CODES.SUCCESS;
  }
  if (subcommand === undefined || subcommand === 'status') {
    if (!brokerEnabled()) {
      console.log('session broker: off (AVITO_BROKER=off) — every command connects on its own');
      return EXIT_CODES.SUCCESS;
    }
    const state = await liveBroker();
    if (!state) {
      console.log('session broker: not running — the next command will start one');
      return EXIT_CODES.SUCCESS;
    }
    console.log(`session broker: running (pid ${state.pid}, port ${state.port})`);
    console.log(`browser: ${state.endpoint}`);
    return EXIT_CODES.SUCCESS;
  }
  console.error(`unknown session subcommand "${subcommand}" — expected status or stop`);
  return EXIT_CODES.USAGE_ERROR;
}

async function main() {
  const argv = process.argv.slice(2);
  const commands = await loadCommands();

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const name = argv.find((token) => !token.startsWith('-'));

  if (commands.size === 0) {
    console.error('No commands in src/commands yet.');
    return EXIT_CODES.GENERIC_ERROR;
  }
  if (!name) {
    console.log(usage(commands));
    return wantsHelp ? EXIT_CODES.SUCCESS : EXIT_CODES.USAGE_ERROR;
  }

  // `session` is not a command: it has no rows, touches no site, and exists to
  // make the one long-lived thing in this CLI visible and stoppable.
  if (name === 'session') return runSessionSubcommand(argv[argv.indexOf(name) + 1]);

  const descriptor = commands.get(name);
  if (!descriptor) {
    console.error(`unknown command "${name}"\n`);
    console.error(usage(commands));
    return EXIT_CODES.USAGE_ERROR;
  }
  if (wantsHelp) {
    console.log(commandHelp(descriptor));
    return EXIT_CODES.SUCCESS;
  }

  const rest = argv.slice(argv.indexOf(name) + 1);
  const options = { format: 'json', browserUrl: undefined };
  const forwarded = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '-f' || token === '--format') {
      options.format = rest[++index];
      continue;
    }
    if (token === '--browser-url') {
      options.browserUrl = rest[++index];
      continue;
    }
    if (token === '--browser-profile') {
      options.browserProfile = rest[++index];
      continue;
    }
    if (token === '--browser-ws') {
      options.browserWs = rest[++index];
      continue;
    }
    forwarded.push(token);
  }
  if (!FORMATS.has(options.format)) {
    throw new ArgumentError(`format must be one of: ${[...FORMATS].join(', ')}`);
  }

  const args = parseArguments(descriptor, forwarded);

  const context = await openBrowserContext({
    ...(options.browserUrl ? { browserUrl: options.browserUrl } : {}),
    ...(options.browserProfile ? { browserProfile: options.browserProfile } : {}),
    ...(options.browserWs ? { browserWs: options.browserWs } : {}),
  });
  let rows;
  try {
    rows = await descriptor.run(context.page, args);
  } finally {
    await context.release();
  }

  if (options.format === 'table') console.log(renderTable(rows, descriptor.columns));
  else console.log(JSON.stringify(rows, null, 2));
  return EXIT_CODES.SUCCESS;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof CliError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = exitCodeFor(error);
}
