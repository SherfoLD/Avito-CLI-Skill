// The prelude is the one place where the same code exists twice at runtime:
// imported in Node, inlined in the page. These checks exist so the two copies
// cannot drift apart silently — a shared decoder that works here and throws a
// ReferenceError in the browser would leave every offline suite green.
import { runner } from './harness.mjs';
import { browserPreludeSource } from '../src/runtime/browser-prelude.mjs';
import { decodeCatalogRows } from '../src/browser/prelude/card.mjs';
import { DOMParser, ORIGIN, cardPhoto, item } from './carrier.mjs';

const { check, assert, run } = runner();

const PRELUDE = await browserPreludeSource();
const env = { DOMParser, location: { origin: ORIGIN, href: `${ORIGIN}/` } };

/** Evaluate an expression in a scope that has only the prelude, as the page does. */
function inPreludeScope(expression) {
  return new Function('env', `${PRELUDE}\nreturn (${expression});`)(env);
}

check('the prelude assembles and every shared name resolves in one scope', () => {
  const names = inPreludeScope(`[
    typeof cleanText, typeof sameParamValue, typeof addParamValues,
    typeof fail, typeof readDocument, typeof looksLikeChallenge,
    typeof decodeCatalogRows, typeof itemPrice, typeof itemSeller
  ]`);
  assert(names.every((kind) => kind === 'function'), `missing from the prelude: ${JSON.stringify(names)}`);
});

// Cross-module calls are the reason the whole prelude ships at once: decoding a
// catalog reaches into three other files, and picking dependencies by hand is
// exactly the mistake that would only show up in the browser.
check('a decoder inlined into the prelude behaves like the imported one', () => {
  const catalog = {
    items: [
      item(),
      item({ id: '8290916337', visiblePrice: null, geoReference: null, locationName: 'Казань' }),
      item({ id: '8226762910', sellerInfo: false, rating: { score: 4.8, summary: '19 отзывов' } }),
    ],
  };
  const inlined = inPreludeScope('decodeCatalogRows')(catalog, env);
  const imported = decodeCatalogRows(catalog, env);
  assert(inlined.failure === undefined, `inlined decoder refused: ${JSON.stringify(inlined.failure)}`);
  assert(
    JSON.stringify(inlined.rows) === JSON.stringify(imported.rows),
    'the inlined decoder and the imported one returned different rows',
  );
  assert(inlined.rows[0].apiPrice === 43691, 'the visible price did not survive inlining');
  assert(inlined.rows[2].apiSeller.name === null && inlined.rows[2].apiSeller.rating === 4.8,
    'the anonymous-seller path did not survive inlining');
});

// A refusal has to keep travelling as a value across the inlined boundary, not
// become a thrown error: the node half dispatches on stage and code.
check('a refusal from an inlined decoder is still a value', () => {
  const broken = { items: [{ ...item(), images: [{ thumb: `https://50.img.avito.st/image/1/x.jpg` }] }] };
  let thrown = null;
  try {
    inPreludeScope('decodeCatalogRows')(broken, env);
  } catch (error) {
    thrown = error;
  }
  assert(thrown != null && /recognizable size variant/.test(thrown.message),
    'a photo with no size variant must fail closed inside the prelude too');

  const malformed = inPreludeScope('decodeCatalogRows')({ items: [{ type: 'item', id: 'x', title: 'y' }] }, env);
  assert(malformed.failure?.stage === 'catalog' && malformed.failure?.code === 'shape',
    `a malformed item must return a refusal, got ${JSON.stringify(malformed)}`);
});

check('a value export survives as a constant', () => {
  assert(inPreludeScope('DOCUMENT_TIMEOUT_MS') === 20000, 'the document timeout did not survive inlining');
});

// Photos are the case where inlining could plausibly change behaviour: the
// decoder compares size keys it has never been told the names of.
check('the largest photo variant is chosen the same way inside the prelude', () => {
  const largest = inPreludeScope('largestImageVariant')(cardPhoto('one'));
  assert(largest.endsWith('one-636.jpg'), `expected the largest variant, got ${largest}`);
});

export default await run('browser prelude');
