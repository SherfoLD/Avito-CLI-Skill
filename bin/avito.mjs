#!/usr/bin/env node
/**
 * `avito` — the CLI entry point: find the command, parse its declared arguments,
 * open one browser context, print the answer. Every rule about what an argument
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
import { parseOutput } from '../src/runtime/schema.mjs';
import { brokerEnabled, openBrowserContext } from '../src/runtime/cdp.mjs';
import { liveBroker, stopBroker } from '../src/runtime/broker-client.mjs';
import { requestedSearchUrl } from '../src/site/url.mjs';
import {
  browserConfigFile,
  clearBrowserConfig,
  describeBrowserTarget,
  discoverBrowsers,
  probeBrowserTarget,
  resolveBrowserOptions,
  writeBrowserConfig,
} from '../src/runtime/browser-config.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'commands');

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
  const lines = ['avito <command> [arguments]', '', 'Commands:'];
  const width = Math.max(...[...commands.keys()].map((name) => name.length), 1);
  for (const descriptor of commands.values()) {
    lines.push(`  ${descriptor.name.padEnd(width)}  ${firstSentence(descriptor.description)}`);
  }
  lines.push('', 'Every command prints one JSON object. Run `avito <command> --help` for its');
  lines.push('arguments and the type of that object. `avito --version` names the build.');
  lines.push('');
  lines.push('The browser is a Chromium you already own. Three ways to reach it:');
  lines.push('  --browser-profile <dir>  a running browser with chrome://inspect debugging on');
  lines.push('  --browser-url <url>      a browser started with --remote-debugging-port');
  lines.push('  --browser-ws <ws://…>    the browser socket directly');
  lines.push('AVITO_BROWSER_PROFILE, AVITO_BROWSER_URL and AVITO_BROWSER_WS do the same.');
  lines.push('');
  lines.push('`avito browser` lists the browsers offering a connection right now, and');
  lines.push('`avito browser use --profile <dir>` remembers one, so later runs need no flag.');
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
  lines.push('Output:');
  lines.push('  One JSON object, printed to stdout.');
  lines.push('');
  for (const line of descriptor.type.split('\n')) lines.push(line ? `  ${line}` : '');
  lines.push('');
  if (descriptor.example) lines.push('Example:', `  ${descriptor.example}`, '');
  return lines.join('\n');
}

/**
 * The first line of a report against this CLI. The path is here because a
 * version alone does not say which checkout answered.
 */
function versionLine() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  return `avito ${manifest.version} (${path.join(PROJECT_ROOT, 'bin', 'avito.mjs')})`;
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

/**
 * What this machine would connect to, and whether that endpoint is there.
 *
 * Printed by both `session status` and `browser`, because "not running" said
 * nothing about the browser and that was the whole failure: the report has to
 * name the endpoint and go look at it (F-074).
 */
async function reportBrowserTarget() {
  const target = resolveBrowserOptions();
  console.log(`browser: ${describeBrowserTarget(target)}`);
  console.log(`chosen by: ${target.source}`);
  const { reachable, detail } = await probeBrowserTarget(target);
  if (reachable === null) console.log(`reachable: unknown — ${detail}`);
  else console.log(`reachable: ${reachable ? 'yes' : 'no'} — ${detail}`);
  return reachable;
}

async function runBrowserSubcommand(rest) {
  const [subcommand, ...flags] = rest;

  if (subcommand === 'forget') {
    const removed = clearBrowserConfig();
    console.log(removed
      ? `forgotten — ${browserConfigFile()} removed`
      : 'no browser was remembered');
    return EXIT_CODES.SUCCESS;
  }

  if (subcommand === 'use') {
    const choice = {};
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === '--profile') choice.browserProfile = flags[++index];
      else if (flags[index] === '--url') choice.browserUrl = flags[++index];
      else if (flags[index] === '--ws') choice.browserWs = flags[++index];
      else throw new ArgumentError(`unknown option "${flags[index]}" — expected --profile, --url or --ws`);
    }
    const named = Object.keys(choice).length;
    if (named === 0) throw new ArgumentError('name one of --profile <dir>, --url <url> or --ws <ws://…>');
    if (named > 1) {
      throw new ArgumentError('name exactly one of --profile, --url or --ws: a browser is reached one way');
    }
    let remembered;
    try {
      remembered = writeBrowserConfig(choice);
    } catch (error) {
      throw new ArgumentError(error.message);
    }
    console.log(`remembered: ${describeBrowserTarget(remembered)}`);
    console.log(`written to: ${browserConfigFile()}`);
    const { reachable, detail } = await probeBrowserTarget(remembered);
    if (reachable === false) {
      console.log(`not reachable yet — ${detail}`);
      console.log('Turn debugging on at chrome://inspect/#remote-debugging in that browser.');
    }
    return EXIT_CODES.SUCCESS;
  }

  if (subcommand === undefined || subcommand === 'list') {
    await reportBrowserTarget();
    const browsers = discoverBrowsers();
    console.log('');
    if (browsers.length === 0) {
      console.log('No browser on this machine is offering a debugging connection.');
      console.log('Open chrome://inspect/#remote-debugging in the browser you actually use, turn it');
      console.log('on there, then run `avito browser` again.');
      return EXIT_CODES.SUCCESS;
    }
    console.log(`Offering a connection right now (${browsers.length}):`);
    for (const browser of browsers) console.log(`  ${browser.profileDir}`);
    console.log('');
    console.log('Remember one with `avito browser use --profile <dir>`.');
    return EXIT_CODES.SUCCESS;
  }

  console.error(`unknown browser subcommand "${subcommand}" — expected list, use or forget`);
  return EXIT_CODES.USAGE_ERROR;
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
    } else {
      const state = await liveBroker();
      if (state) {
        console.log(`session broker: running (pid ${state.pid}, port ${state.port})`);
        console.log(`connected to: ${state.endpoint}`);
        return EXIT_CODES.SUCCESS;
      }
      console.log('session broker: not running — the next command will start one');
    }
    await reportBrowserTarget();
    return EXIT_CODES.SUCCESS;
  }
  console.error(`unknown session subcommand "${subcommand}" — expected status or stop`);
  return EXIT_CODES.USAGE_ERROR;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--version')) {
    console.log(versionLine());
    return EXIT_CODES.SUCCESS;
  }

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

  // `session` and `browser` are not commands: they answer with no data and touch no
  // site. One makes the long-lived connection visible and stoppable, the other
  // settles which browser that connection is made to.
  if (name === 'session' || name === 'browser') {
    if (wantsHelp) {
      console.log(name === 'session'
        ? 'avito session [status]        the connection this session holds, and the browser it would use\navito session stop            close it'
        : 'avito browser [list]                  which browser will be used, and which ones offer a connection now\n'
          + 'avito browser use --profile <dir>     remember a running browser with chrome://inspect debugging on\n'
          + 'avito browser use --url <url>         remember a browser started with --remote-debugging-port\n'
          + 'avito browser use --ws <ws://…>       remember a browser socket directly\n'
          + 'avito browser forget                  stop remembering one');
      return EXIT_CODES.SUCCESS;
    }
    const rest = argv.slice(argv.indexOf(name) + 1);
    return name === 'session' ? runSessionSubcommand(rest[0]) : runBrowserSubcommand(rest);
  }

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
  const options = { browserUrl: undefined };
  const forwarded = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    // Named rather than left to "unexpected argument": this used to select a
    // format, and a caller repeating it deserves to be told the answer is JSON.
    if (token === '-f' || token === '--format' || token.startsWith('--format=')) {
      throw new ArgumentError('there is no output format to choose — every command prints one JSON object');
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
  const args = parseArguments(descriptor, forwarded);
  const persistentTab = descriptor.browserTab !== 'ephemeral';
  const tabKey = descriptor.browserTab === 'search-url'
    ? requestedSearchUrl(args.searchUrl)
    : null;

  const context = await openBrowserContext({
    ...(options.browserUrl ? { browserUrl: options.browserUrl } : {}),
    ...(options.browserProfile ? { browserProfile: options.browserProfile } : {}),
    ...(options.browserWs ? { browserWs: options.browserWs } : {}),
  }, { key: tabKey, persistent: persistentTab });
  let parsed;
  let succeeded = false;
  try {
    const returned = await descriptor.run(context.page, args);
    parsed = parseOutput(descriptor.output, returned, descriptor.name);
    if (persistentTab && parsed.searchUrl) {
      await context.bind(requestedSearchUrl(parsed.searchUrl));
    }
    succeeded = true;
  } finally {
    await context.release({ discardCreated: !succeeded });
  }

  // The only gate that sees the answer a caller actually gets.
  console.log(JSON.stringify(parsed, null, 2));
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
