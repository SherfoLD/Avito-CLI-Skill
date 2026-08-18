/**
 * The browser context: what a command is allowed to do inside the page.
 *
 * Avito refuses an anonymous server-side fetch — `HTTP 429`, `server: QRATOR`,
 * a CAPTCHA page (F-006) — so every read happens inside a browser the user
 * already owns. This module is the whole surface of that:
 *
 *   goto(url, options)          navigate the tab, used only to prime the origin
 *                               and, in get-item, to render one listing
 *   evaluateWithArgs(fn, args)  ship a function into the page and run it there
 *   fetchJson(url)              one same-origin JSON read from the page
 *   wait(seconds)               the single bounded backoff `search` is allowed
 *
 * There is no `click` and no `waitForSelector`. The catalog is never rendered:
 * after hydration the live DOM carries neither `script[data-mfe-state]` nor
 * `searchCore`, so the state has to be read by a separate same-origin fetch
 * anyway.
 *
 * Two backends sit under the same surface: the session broker by default, and
 * a direct connection under `AVITO_BROKER=off`, which is right for a browser
 * started with `--remote-debugging-port`, where nothing ever asks (D-045).
 *
 * Nothing here retries. A refusal is returned to the caller as it arrived.
 */

import { COMMAND_TIMEOUT_SECONDS, HIDDEN_TAB, connectToBrowser } from './cdp-connection.mjs';
import { browserPreludeSource } from './browser-prelude.mjs';
import { callBroker, ensureBroker } from './broker-client.mjs';
import { resolveBrowserOptions } from './browser-config.mjs';

const NAVIGATION_TIMEOUT_SECONDS = 30;

/** Built as source, not serialized: these globals cannot cross the wire. */
const BROWSER_ENV_SOURCE = '{ fetch: (...a) => window.fetch(...a), DOMParser: window.DOMParser, '
  + 'location: window.location, document: window.document, window }';

class PageContext {
  constructor(backend) {
    this.backend = backend;
  }

  /**
   * `settleMs` is time after the load event, for the one navigation that lands
   * on the homepage to see whether Avito is serving this session at all.
   * Everything else passes 0: a document is fetched, not rendered, and the
   * state a rendered page does carry is inline in it (F-093).
   */
  async goto(url, { waitUntil = 'load', settleMs = 0 } = {}) {
    return this.backend.goto(url, { waitUntil, settleMs });
  }

  /**
   * `fn` crosses the wire through `toString()`, so it must be self-contained:
   * anything it calls has to come from the prelude (`browser-prelude.mjs`), and
   * the browser globals arrive as its second parameter.
   */
  async evaluateWithArgs(fn, args) {
    const prelude = await browserPreludeSource();
    const expression = `(async () => {
${prelude}
const __command = ${String(fn)};
return await __command(${JSON.stringify(args ?? {})}, ${BROWSER_ENV_SOURCE});
})()`;
    return this.evaluate(expression);
  }

  async evaluate(expression) {
    const result = await this.backend.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result?.exceptionDetails) {
      const thrown = result.exceptionDetails.exception;
      const message = thrown?.description ?? thrown?.value ?? result.exceptionDetails.text;
      throw new Error(String(message));
    }
    return result?.result?.value;
  }

  /**
   * One same-origin JSON read. A non-200 is thrown rather than returned: the
   * directory calls that use this have no meaningful partial answer, and a
   * challenge must stop the command instead of becoming an empty vocabulary.
   */
  async fetchJson(url) {
    return this.evaluateWithArgs(async (input, env) => {
      const response = await env.fetch(input.url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 429) throw new Error('Avito answered 429 — rate limit or access challenge');
      if (!response.ok) throw new Error(`Avito answered ${response.status}`);
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Avito returned malformed JSON');
      }
    }, { url });
  }

  /** The single bounded backoff a command is allowed, never a courtesy gap. */
  async wait(seconds) {
    await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
  }
}

/** One connection for this process only. Used when the broker is turned off. */
async function directBackend(options) {
  const { connection } = await connectToBrowser(options);
  const { targetId } = await connection.send('Target.createTarget', HIDDEN_TAB);
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  await connection.send('Page.enable', {}, sessionId);
  await connection.send('Runtime.enable', {}, sessionId);

  return {
    async goto(url, { waitUntil, settleMs }) {
      const loaded = waitUntil === 'load'
        ? connection.once('Page.loadEventFired', sessionId, NAVIGATION_TIMEOUT_SECONDS)
        : Promise.resolve();
      const result = await connection.send('Page.navigate', { url }, sessionId, NAVIGATION_TIMEOUT_SECONDS);
      if (result?.errorText) throw new Error(`navigating to ${url} failed: ${result.errorText}`);
      await loaded;
      if (settleMs > 0) await new Promise((resolve) => { setTimeout(resolve, settleMs); });
      return result;
    },
    async send(method, params, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
      return connection.send(method, params, sessionId, timeoutSeconds);
    },
    async release() {
      try {
        await connection.send('Target.closeTarget', { targetId });
      } catch {
        // The tab is already gone, or the browser went away first.
      }
      connection.close();
    },
  };
}

/** A tab inside the broker's single connection, shared by the whole session. */
async function brokerBackend(options) {
  const state = await ensureBroker(options);
  const { pageId, sessionId } = await callBroker(state, '/page/open');

  return {
    async goto(url, { waitUntil, settleMs }) {
      const { result } = await callBroker(state, '/page/goto', {
        sessionId, url, waitUntil, settleMs, timeoutSeconds: NAVIGATION_TIMEOUT_SECONDS,
      });
      return result;
    },
    async send(method, params, timeoutSeconds = COMMAND_TIMEOUT_SECONDS) {
      const { result } = await callBroker(state, '/session/send', {
        method, params, sessionId, timeoutSeconds,
      });
      return result;
    },
    async release() {
      try {
        await callBroker(state, '/page/close', { pageId });
      } catch {
        // The broker went away or already closed the tab; the connection it
        // holds is not this command's to clean up either way.
      }
    },
  };
}

export function brokerEnabled() {
  return String(process.env.AVITO_BROKER ?? '').toLowerCase() !== 'off';
}

/**
 * A tab is created per call rather than reused, so no command inherits another's
 * page. The connection is what survives a command, not the tab.
 *
 * Which browser gets talked to is settled here, once, before either backend
 * sees it: both would otherwise resolve it separately and could disagree.
 */
export async function openBrowserContext(options = {}) {
  const target = resolveBrowserOptions(options);
  const backend = brokerEnabled() ? await brokerBackend(target) : await directBackend(target);
  return {
    page: new PageContext(backend),
    release: () => backend.release(),
  };
}
