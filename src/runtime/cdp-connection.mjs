/**
 * Finding a browser and talking to it over the DevTools Protocol.
 *
 * This is the wire only — request/response correlation, event waiting, and the
 * three ways an endpoint can be reached. What may be *done* over that wire is
 * decided in `cdp.mjs`, and by the broker, which exposes a much smaller set of
 * operations than CDP itself.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_BROWSER_URL = 'http://127.0.0.1:9222';
export const COMMAND_TIMEOUT_SECONDS = 30;

/**
 * `Target.createTarget` arguments for the tab a command works in.
 *
 * A target created plainly is a foreground tab: the browser takes the screen
 * away from whatever the person was doing. `background` keeps the application
 * where it was and still puts the tab in the strip and in `Target.getTargets`,
 * unthrottled and reporting `visibilityState: 'visible'` (F-073, F-099) — a tab
 * the person can watch, click into and close. What it does not have is the
 * `hidden` tab's lifetime: that one dies with the socket that opened it, while
 * this one outlives a broker killed hard enough to skip `closeAll` (D-080).
 */
export const COMMAND_TAB = { url: 'about:blank', background: true };

/**
 * There are two ways a Chromium exposes the protocol, and they are not
 * interchangeable.
 *
 *   --remote-debugging-port   serves the `/json/*` HTTP endpoints, so the
 *                             browser socket can be discovered from the port
 *                             alone. This is a browser started for automation.
 *
 *   chrome://inspect          Chrome 144+ can turn debugging on for a browser
 *   #remote-debugging         that is already running, with the profile the
 *                             user actually uses. That mode serves the
 *                             WebSocket and nothing else: `/json/version`
 *                             answers 404, and the socket path is written to
 *                             `DevToolsActivePort` in the profile directory.
 *
 * The second one matters beyond convenience. Avito withholds private seller
 * identity from an anonymous session and refuses a profile with no history
 * outright (F-049, F-068), so a purpose-launched browser is not a neutral
 * choice — attaching to the profile the user already browses with is the only
 * way to read what a person reads (D-044).
 */
export function webSocketUrlFromProfile(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let contents;
  try {
    contents = fs.readFileSync(portFile, 'utf-8');
  } catch {
    throw new Error(
      `${portFile} does not exist, so that profile has no debugging session. `
      + 'Turn it on at chrome://inspect/#remote-debugging in that browser, then run `avito browser` to check.',
    );
  }
  const [port, socketPath] = contents.split('\n');
  if (!/^\d+$/.test(String(port).trim()) || !String(socketPath ?? '').startsWith('/devtools/')) {
    throw new Error(`${portFile} does not name a debugging socket`);
  }
  return `ws://127.0.0.1:${port.trim()}${socketPath.trim()}`;
}

/** Read the endpoint once, so a missing browser is a clear failure and not a hang. */
export async function webSocketUrlFromHttp(browserUrl, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
  const target = new URL('/json/version', browserUrl);
  let response;
  try {
    response = await fetch(target.href, { signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  } catch (error) {
    throw new Error(
      `no Chrome DevTools endpoint at ${browserUrl} (${error instanceof Error ? error.message : String(error)}). `
      + 'Run `avito browser` to see which browsers on this machine have debugging on, and '
      + '`avito browser use --profile <dir>` to pick one.',
      { cause: error },
    );
  }
  if (response.status === 404) {
    throw new Error(
      `${browserUrl} answered 404: that browser serves the WebSocket only, which is what `
      + 'chrome://inspect debugging does. Run `avito browser use --profile <its profile directory>` instead.',
    );
  }
  if (!response.ok) throw new Error(`Chrome DevTools endpoint answered ${response.status}`);
  const payload = await response.json();
  const webSocketUrl = payload?.webSocketDebuggerUrl;
  if (typeof webSocketUrl !== 'string' || !webSocketUrl) {
    throw new Error('Chrome DevTools endpoint reported no webSocketDebuggerUrl');
  }
  return webSocketUrl;
}

/**
 * Options arrive already resolved: which flag, variable or remembered choice
 * won is decided once, in `browser-config.mjs`. Reading the environment again
 * here would let a profile from one layer beat a URL from a higher one.
 */
export async function resolveWebSocketUrl({
  browserWs,
  browserProfile,
  browserUrl = DEFAULT_BROWSER_URL,
} = {}) {
  if (browserWs) return browserWs;
  if (browserProfile) return webSocketUrlFromProfile(browserProfile);
  return webSocketUrlFromHttp(browserUrl);
}

export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closeHandlers = new Set();
    this.closed = null;

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (CDP ${message.error.code})`));
        else resolve(message.result);
        return;
      }
      for (const listener of [...this.listeners]) listener(message);
    });

    socket.addEventListener('close', () => {
      this.closed = new Error('the browser connection closed');
      for (const { reject } of this.pending.values()) reject(this.closed);
      this.pending.clear();
      for (const handler of [...this.closeHandlers]) handler();
    });
  }

  static async open(webSocketUrl, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connecting to the browser timed out')), timeoutSeconds * 1000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the browser connection failed')); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
  }

  send(method, params = {}, sessionId, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  /** Resolve on the first matching event, or reject when the wait runs out. */
  once(method, sessionId, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`waiting for ${method} timed out after ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The socket is already gone; there is nothing to release.
    }
  }
}

export async function connectToBrowser(options = {}) {
  const endpoint = await resolveWebSocketUrl(options);
  const connection = await CdpConnection.open(endpoint);
  return { connection, endpoint };
}
