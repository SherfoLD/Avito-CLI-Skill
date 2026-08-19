// The prelude is the one place where the same code exists twice at runtime:
// imported in Node, inlined in the page. These checks exist so the two copies
// cannot drift apart silently — shared code that works here and throws a
// ReferenceError in the browser would leave every offline suite green.
import { runner } from './harness.mjs';
import { browserPreludeSource } from '../src/runtime/browser-prelude.mjs';
import { readDocument } from '../src/browser/prelude/document.mjs';
import { readJsonResponse } from '../src/browser/prelude/json.mjs';
import {
  DOMParser, FILTERS, ORIGIN, bootstrapHtml, makeFetch, searchCore,
} from './carrier.mjs';

const { check, assert, run } = runner();

const PRELUDE = await browserPreludeSource();

/** Evaluate an expression in a scope that has only the prelude, as the page does. */
function inPreludeScope(expression) {
  return new Function(`${PRELUDE}\nreturn (${expression});`)();
}

const state = { loaderData: { data: { searchCore: searchCore(), filtersV2: FILTERS } } };
const env = (routes) => {
  const { fetch, calls } = makeFetch(routes);
  return { env: { DOMParser, fetch, location: { origin: ORIGIN, href: `${ORIGIN}/` } }, calls };
};

check('the prelude assembles and every shared name resolves in one scope', () => {
  const names = inPreludeScope(`[
    typeof fail, typeof readDocument, typeof looksLikeChallenge, typeof readJsonResponse
  ]`);
  assert(names.every((kind) => kind === 'function'), `missing from the prelude: ${JSON.stringify(names)}`);
});

// Cross-module calls are the reason the whole prelude ships at once: reading a
// document reaches into the refusal envelope, and picking dependencies by hand
// is exactly the mistake that would only show up in the browser.
check('a document read inlined into the prelude behaves like the imported one', async () => {
  const routes = [{ match: ORIGIN, body: bootstrapHtml(state) }];
  const url = `${ORIGIN}/moskva?q=ddr5`;
  const inlined = await inPreludeScope('readDocument')(url, 'schema', env(routes).env);
  const imported = await readDocument(url, 'schema', env(routes).env);
  assert(inlined.state?.searchCore?.categoryId === 101, `the state did not survive: ${JSON.stringify(inlined)}`);
  assert(JSON.stringify(inlined) === JSON.stringify(imported), 'the two copies read the document differently');
});

// A refusal has to keep travelling as a value across the inlined boundary, not
// become a thrown error: the node half dispatches on stage and code.
check('a refusal from an inlined reader is still a value', async () => {
  const routes = [{ match: ORIGIN, status: 429, body: '<html><title>Доступ ограничен</title></html>' }];
  const inlined = await inPreludeScope('readDocument')(`${ORIGIN}/moskva`, 'schema', env(routes).env);
  const imported = await readDocument(`${ORIGIN}/moskva`, 'schema', env(routes).env);
  assert(inlined.failure?.stage === 'schema' && inlined.failure?.code === 'access',
    `a 429 must return a refusal, got ${JSON.stringify(inlined)}`);
  assert(JSON.stringify(inlined) === JSON.stringify(imported),
    'the inlined reader and the imported one refused differently');
});

// json.mjs reaches into document.mjs for the challenge detector, which is the
// second cross-module edge left in the page.
check('a JSON read inlined into the prelude sees the same challenge', async () => {
  const routes = [{ match: ORIGIN, contentType: 'text/html', body: '<html><body>Доступ ограничен</body></html>' }];
  const input = { requestUrl: `${ORIGIN}/web/1/x` };
  const inlined = await inPreludeScope('readJsonResponse')(input, env(routes).env);
  const imported = await readJsonResponse(input, env(routes).env);
  assert(inlined.accessChallenge === true, `the challenge was not seen: ${JSON.stringify(inlined)}`);
  assert(JSON.stringify(inlined) === JSON.stringify(imported), 'the two copies classified it differently');
});

check('a value export survives as a constant', () => {
  assert(inPreludeScope('DOCUMENT_TIMEOUT_MS') === 20000, 'the document timeout did not survive inlining');
});

export default await run('browser prelude');
