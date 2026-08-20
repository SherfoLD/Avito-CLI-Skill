/**
 * Tabs owned by the session broker.
 *
 * A key is opaque here. The CLI decides that it is a canonical search URL; the
 * broker only guarantees that the same key acquires the same live tab. Tabs
 * without persistent ownership are closed on release.
 */

import { randomUUID } from 'node:crypto';

import { HIDDEN_TAB } from './cdp-connection.mjs';

const PROBE_TIMEOUT_SECONDS = 2;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class PageRegistry {
  constructor(connection) {
    this.connection = connection;
    this.pages = new Map();
    this.pageByKey = new Map();
  }

  get size() {
    return this.pages.size;
  }

  get busySize() {
    return [...this.pages.values()].filter((page) => page.busy).length;
  }

  async create({ persistent, ownerPid }) {
    const { targetId } = await this.connection.send('Target.createTarget', HIDDEN_TAB);
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
    await this.connection.send('Page.enable', {}, sessionId);
    await this.connection.send('Runtime.enable', {}, sessionId);

    const pageId = randomUUID();
    const page = {
      pageId,
      targetId,
      sessionId,
      persistent,
      ownerPid,
      busy: true,
      keys: new Set(),
    };
    this.pages.set(pageId, page);
    return page;
  }

  async isAlive(page) {
    try {
      await this.connection.send(
        'Runtime.evaluate',
        { expression: 'true', returnByValue: true },
        page.sessionId,
        PROBE_TIMEOUT_SECONDS,
      );
      return true;
    } catch {
      return false;
    }
  }

  async acquire({ key = null, persistent = false, ownerPid = null } = {}) {
    if (key != null) {
      const pageId = this.pageByKey.get(key);
      const page = pageId ? this.pages.get(pageId) : null;
      if (page) {
        if (!(await this.isAlive(page))) {
          await this.drop(page.pageId);
        } else if (page.busy) {
          if (processIsAlive(page.ownerPid)) {
            throw new Error('the search tab is already in use by another command');
          }
          await this.drop(page.pageId);
        } else {
          page.busy = true;
          page.ownerPid = ownerPid;
          return { ...page, created: false };
        }
      } else if (pageId) {
        this.pageByKey.delete(key);
      }
    }

    const page = await this.create({ persistent, ownerPid });
    if (key != null) await this.bind(page.pageId, key);
    return { ...page, created: true };
  }

  async bind(pageId, key) {
    const page = this.pages.get(pageId);
    if (!page) throw new Error('the browser tab is no longer available');
    if (typeof key !== 'string' || key === '') throw new Error('a persistent browser tab needs a non-empty key');

    const previousId = this.pageByKey.get(key);
    if (previousId && previousId !== pageId) {
      const previous = this.pages.get(previousId);
      previous?.keys.delete(key);
      if (previous && previous.keys.size === 0 && !previous.busy) await this.drop(previousId);
    }
    this.pageByKey.set(key, pageId);
    page.keys.add(key);
  }

  async release(pageId, { discard = false } = {}) {
    const page = this.pages.get(pageId);
    if (!page) return;
    page.busy = false;
    page.ownerPid = null;
    if (discard || !page.persistent || page.keys.size === 0) await this.drop(pageId);
  }

  async drop(pageId) {
    const page = this.pages.get(pageId);
    if (!page) return;
    this.pages.delete(pageId);
    for (const key of page.keys) {
      if (this.pageByKey.get(key) === pageId) this.pageByKey.delete(key);
    }
    try {
      await this.connection.send('Target.closeTarget', { targetId: page.targetId });
    } catch {
      // A dead tab is already in the state this operation asks for.
    }
  }

  async closeAll() {
    for (const pageId of [...this.pages.keys()]) await this.drop(pageId);
  }
}
