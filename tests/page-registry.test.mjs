import { PageRegistry } from '../src/runtime/page-registry.mjs';
import { runner } from './harness.mjs';

const { check, assert, run } = runner();

function fakeConnection() {
  let nextTarget = 1;
  const closed = [];
  const deadSessions = new Set();
  const calls = [];
  return {
    closed,
    deadSessions,
    calls,
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: `target-${nextTarget++}` };
      if (method === 'Target.attachToTarget') {
        return { sessionId: String(params.targetId).replace('target', 'runtime') };
      }
      if (method === 'Runtime.evaluate' && deadSessions.has(sessionId)) throw new Error('No target with given id');
      if (method === 'Target.closeTarget') {
        closed.push(params.targetId);
        return { success: true };
      }
      return {};
    },
  };
}

check('a search URL reacquires the same live persistent tab', async () => {
  const connection = fakeConnection();
  const registry = new PageRegistry(connection);
  const first = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  await registry.release(first.pageId);
  const second = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });

  assert(first.pageId === second.pageId, 'the search URL opened another tab');
  assert(second.created === false, 'the existing tab was reported as new');
  assert(connection.calls.some((call) => call.method === 'Runtime.evaluate' && call.sessionId === first.sessionId),
    'the existing tab was not checked before reuse');
  await registry.release(second.pageId);
});

check('a URL returned later becomes an alias of the same tab', async () => {
  const registry = new PageRegistry(fakeConnection());
  const page = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  await registry.bind(page.pageId, 'search-a-page-2');
  await registry.release(page.pageId);

  const byResult = await registry.acquire({ key: 'search-a-page-2', persistent: true, ownerPid: process.pid });
  assert(byResult.pageId === page.pageId, 'the derived search URL lost its tab');
  await registry.release(byResult.pageId);
});

check('a new search replaces an identical URL without leaking its unaddressable tab', async () => {
  const connection = fakeConnection();
  const registry = new PageRegistry(connection);
  const oldSearch = await registry.acquire({ persistent: true, ownerPid: process.pid });
  await registry.bind(oldSearch.pageId, 'same-search');
  await registry.release(oldSearch.pageId);

  const newSearch = await registry.acquire({ persistent: true, ownerPid: process.pid });
  await registry.bind(newSearch.pageId, 'same-search');
  await registry.release(newSearch.pageId);

  const acquired = await registry.acquire({ key: 'same-search', persistent: true, ownerPid: process.pid });
  assert(acquired.pageId === newSearch.pageId, 'the identical URL did not select the newest search tab');
  assert(connection.closed.includes(oldSearch.targetId), 'the displaced tab with no remaining URL was left open');
  await registry.release(acquired.pageId);
});

check('a dead persistent tab is replaced before the command receives it', async () => {
  const connection = fakeConnection();
  const registry = new PageRegistry(connection);
  const dead = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  await registry.release(dead.pageId);
  connection.deadSessions.add(dead.sessionId);

  const replacement = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  assert(replacement.created === true && replacement.pageId !== dead.pageId, 'the dead tab was handed back');
  assert(connection.closed.includes(dead.targetId), 'the dead target was not discarded');
  await registry.release(replacement.pageId);
});

check('two live commands cannot navigate one tab concurrently', async () => {
  const registry = new PageRegistry(fakeConnection());
  await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  let failure = null;
  try {
    await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  } catch (error) {
    failure = error;
  }
  assert(failure && /already in use/.test(failure.message), 'the second command acquired a busy tab');
  await registry.closeAll();
});

check('a tab abandoned by a dead command is replaced rather than shared with its pending work', async () => {
  const connection = fakeConnection();
  const registry = new PageRegistry(connection);
  const abandoned = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: 2147483647 });
  const replacement = await registry.acquire({ key: 'search-a', persistent: true, ownerPid: process.pid });
  assert(replacement.created === true && replacement.pageId !== abandoned.pageId,
    'the abandoned busy tab was reused');
  assert(connection.closed.includes(abandoned.targetId), 'the abandoned target remained open');
  await registry.release(replacement.pageId);
});

check('an ephemeral tab still closes when its command releases it', async () => {
  const connection = fakeConnection();
  const registry = new PageRegistry(connection);
  const page = await registry.acquire({ persistent: false, ownerPid: process.pid });
  await registry.release(page.pageId);
  assert(registry.size === 0, 'the ephemeral page remained registered');
  assert(connection.closed.includes(page.targetId), 'the ephemeral target remained open');
});

export default await run('page-registry — persistent search tabs');
