/**
 * Which browser this machine reads Avito through, remembered between runs.
 *
 * The three transports were reachable only through a flag or an environment
 * variable, and an agent runs every command in a fresh shell — an `export` in
 * the person's own terminal never reaches it, so the CLI fell back to the
 * default port and reported a browser that was never asked for (F-074). The
 * choice is therefore written once into a file beside the broker state.
 *
 * Precedence is by layer, not by field. Whichever layer names a transport first
 * decides it outright: a `--browser-url` on the command line must not lose to a
 * profile the config file remembers.
 *
 *   1. the flag passed to this invocation
 *   2. AVITO_BROWSER_WS / AVITO_BROWSER_PROFILE / AVITO_BROWSER_URL
 *   3. browser.json in the state directory
 *   4. the default debugging port
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_BROWSER_URL, webSocketUrlFromProfile } from './cdp-connection.mjs';

const PORT_FILE_NAME = 'DevToolsActivePort';
const PROBE_TIMEOUT_MS = 2000;
const DISCOVERY_DEPTH = 3;

/** Everything this CLI keeps between runs: the broker's state and the browser choice. */
export function stateDir() {
  return process.env.AVITO_BROKER_DIR || path.join(os.homedir(), '.avito-cdp');
}

export function browserConfigFile() {
  return path.join(stateDir(), 'browser.json');
}

export function readBrowserConfig() {
  let contents;
  try {
    contents = fs.readFileSync(browserConfigFile(), 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${browserConfigFile()} is not valid JSON (${error.message}). Delete it or run \`avito browser forget\`.`,
      { cause: error },
    );
  }
  const { browserWs, browserProfile, browserUrl } = parsed ?? {};
  if (!browserWs && !browserProfile && !browserUrl) return null;
  return {
    ...(browserWs ? { browserWs } : {}),
    ...(browserProfile ? { browserProfile } : {}),
    ...(browserUrl ? { browserUrl } : {}),
  };
}

/**
 * Refuse a target that cannot be one rather than remembering it and failing on
 * the first command, when the person who chose it is no longer watching.
 */
export function validateBrowserChoice(choice) {
  if (choice.browserWs) {
    if (!/^wss?:\/\//.test(choice.browserWs)) {
      throw new Error(`${choice.browserWs} is not a WebSocket URL — it has to start with ws:// or wss://`);
    }
    return choice;
  }
  if (choice.browserProfile) {
    const resolved = path.resolve(choice.browserProfile);
    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch {
      throw new Error(`${resolved} does not exist, so no browser keeps its profile there`);
    }
    if (!stats.isDirectory()) throw new Error(`${resolved} is not a directory`);
    return { browserProfile: resolved };
  }
  if (choice.browserUrl) {
    try {
      return { browserUrl: new URL(choice.browserUrl).href };
    } catch {
      throw new Error(`${choice.browserUrl} is not a URL`);
    }
  }
  throw new Error('name one of --profile, --url or --ws');
}

export function writeBrowserConfig(choice) {
  const validated = validateBrowserChoice(choice);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(browserConfigFile(), `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  return validated;
}

export function clearBrowserConfig() {
  try {
    fs.rmSync(browserConfigFile());
    return true;
  } catch {
    return false;
  }
}

function fromLayer(layer, source) {
  if (!layer) return null;
  if (layer.browserWs) return { browserWs: layer.browserWs, source };
  if (layer.browserProfile) return { browserProfile: layer.browserProfile, source };
  if (layer.browserUrl) return { browserUrl: layer.browserUrl, source };
  return null;
}

/**
 * The one place the four layers are collapsed into a single transport. Every
 * caller that needs to know which browser to talk to goes through here, so the
 * answer a command uses and the answer `avito session status` prints cannot
 * disagree.
 */
export function resolveBrowserOptions(explicit = {}) {
  const layers = [
    [explicit, 'the command line'],
    [{
      browserWs: process.env.AVITO_BROWSER_WS,
      browserProfile: process.env.AVITO_BROWSER_PROFILE,
      browserUrl: process.env.AVITO_BROWSER_URL,
    }, 'the environment'],
    [readBrowserConfig(), browserConfigFile()],
  ];
  for (const [layer, source] of layers) {
    const chosen = fromLayer(layer, source);
    if (chosen) return chosen;
  }
  return { browserUrl: DEFAULT_BROWSER_URL, source: 'the default' };
}

export function describeBrowserTarget(target) {
  if (target.browserWs) return `socket ${target.browserWs}`;
  if (target.browserProfile) return `profile ${target.browserProfile}`;
  return `debugging port ${target.browserUrl}`;
}

/**
 * Whether the browser can be found — not whether it will let us in.
 *
 * A profile naming a live port and a port answering `/json/version` both stop
 * short of the approval a person still has to click (F-071), so "reachable"
 * here means the endpoint exists, and nothing more.
 */
export async function probeBrowserTarget(target) {
  if (target.browserWs) {
    return { reachable: null, detail: 'a socket URL cannot be checked without connecting' };
  }
  if (target.browserProfile) {
    try {
      webSocketUrlFromProfile(target.browserProfile);
    } catch (error) {
      return { reachable: false, detail: error.message };
    }
    return { reachable: true, detail: `${PORT_FILE_NAME} names a live debugging socket` };
  }
  try {
    const response = await fetch(new URL('/json/version', target.browserUrl).href, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 404) {
      return {
        reachable: false,
        detail: 'that browser serves the WebSocket only, which is what chrome://inspect debugging does — '
          + 'point at its profile directory instead',
      };
    }
    if (!response.ok) return { reachable: false, detail: `the debugging port answered ${response.status}` };
    const payload = await response.json();
    return { reachable: true, detail: payload?.Browser ? String(payload.Browser) : 'the debugging port answered' };
  } catch {
    return { reachable: false, detail: 'nothing is listening on that debugging port' };
  }
}

function collectPortFiles(root, depth, found) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // Unreadable directories are everywhere under a home directory and none of
    // them is a browser we could have offered. The scan carries on.
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === PORT_FILE_NAME) found.push(root);
    else if (entry.isDirectory() && depth > 0) collectPortFiles(path.join(root, entry.name), depth - 1, found);
  }
}

function discoveryRoots() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support')];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return local ? [local] : [];
  }
  return [path.join(home, '.config')];
}

/**
 * Profile directories of browsers that have debugging on right now.
 *
 * A browser with debugging off leaves no `DevToolsActivePort` behind, so an
 * empty result is the answer "nothing on this machine is offering a connection"
 * rather than "we could not look".
 */
export function discoverBrowsers() {
  const found = [];
  for (const root of discoveryRoots()) collectPortFiles(root, DISCOVERY_DEPTH, found);
  const browsers = [];
  for (const profileDir of found) {
    let socket;
    try {
      socket = webSocketUrlFromProfile(profileDir);
    } catch {
      // The file is there but names no socket: a profile whose browser exited
      // without cleaning up. Offering it would hand back a dead endpoint.
      continue;
    }
    browsers.push({ profileDir, socket, name: path.basename(profileDir) });
  }
  return browsers.sort((left, right) => left.profileDir.localeCompare(right.profileDir));
}
