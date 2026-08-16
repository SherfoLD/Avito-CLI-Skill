/**
 * The browser half of `avito get-page`, which is the postconditions.
 *
 * Avito canonicalizes the URL it is given, and a search URL that quietly lost a
 * filter still returns fifty perfectly plausible listings — nothing in the rows
 * would show it. So the canonical URL is compared pair by pair against the
 * requested one with `p` excluded, and `searchCore.page` must be the requested
 * number rather than merely a number.
 */

import { fail } from '../browser/refusal.mjs';
import { decodeCatalogRows } from '../browser/card.mjs';
import { readDocument } from '../browser/document.mjs';
import { flattenFilters } from '../browser/filters.mjs';
import { cleanText, comparableText, normalizeScalar } from '../browser/text.mjs';

export async function paginate(input, env) {
  const { requestedUrl, requestedPage, MAX_FILTERS, MAX_PARAMS } = input;

  // A pair list of everything except the page number, so the comparison below
  // is about the search and not about the hop. The NUL join keeps `a=b&c` from
  // comparing equal to `a=b&c=` and the sort makes the order Avito's business.
  const queryPairsWithoutPage = (url) => [...url.searchParams.entries()]
    .filter(([key]) => key !== 'p')
    .map(([key, value]) => key + '\u0000' + value)
    .sort();
  const sameList = (left, right) => (
    left.length === right.length && left.every((value, index) => value === right[index])
  );

  const sourceUrl = new URL(requestedUrl);
  const targetUrl = new URL(requestedUrl);
  // Page 1 is the URL without `p` — asking for `p=1` is a different URL that
  // Avito canonicalizes back, so the postcondition below would fail on a page
  // that was in fact correct.
  if (requestedPage === 1) targetUrl.searchParams.delete('p');
  else targetUrl.searchParams.set('p', String(requestedPage));

  const document = await readDocument(targetUrl.href, 'document', env);
  if (document.failure) return document.failure;

  let resultUrl;
  try {
    resultUrl = new URL(document.responseUrl);
  } catch {
    return fail('postcondition', 'shape', 'Avito returned an invalid canonical page URL');
  }
  if (resultUrl.protocol !== 'https:' || resultUrl.hostname !== 'www.avito.ru') {
    return fail('postcondition', 'shape', 'Avito returned a canonical page URL outside www.avito.ru');
  }
  resultUrl.hash = '';
  if (resultUrl.pathname !== sourceUrl.pathname) {
    return fail('postcondition', 'drift', 'Avito changed the preserved search pathname');
  }
  if (!sameList(queryPairsWithoutPage(sourceUrl), queryPairsWithoutPage(resultUrl))) {
    return fail('postcondition', 'drift', 'Avito changed preserved search query parameters');
  }
  if (requestedPage === 1 && resultUrl.searchParams.has('p')) {
    return fail('postcondition', 'drift', 'Avito did not canonicalize page 1 without p');
  }
  if (requestedPage > 1 && resultUrl.searchParams.get('p') !== String(requestedPage)) {
    return fail('postcondition', 'drift', 'Avito returned an unexpected canonical page number');
  }

  const state = document.payload?.data;
  const loaderState = state?.searchCore && state?.catalog && state?.filtersV2?.Sections ? state : null;
  if (!loaderState) {
    if (document.challenge) {
      return fail('document', 'access', document.documentTitle || 'Avito access challenge', { status: document.status });
    }
    return fail(
      'schema',
      document.parseErrors ? 'parse' : 'missing',
      'Avito SSR bootstrap has no complete page state',
    );
  }

  const resultCore = loaderState.searchCore;
  const resultCatalog = loaderState.catalog;
  const resultSections = loaderState.filtersV2.Sections;
  if (
    !resultCore || typeof resultCore !== 'object'
    || !resultCatalog || typeof resultCatalog !== 'object'
    || !Array.isArray(resultSections)
  ) {
    return fail('schema', 'shape', 'Avito SSR page state is malformed');
  }
  if (Number(resultCore.page) !== requestedPage) {
    return fail('postcondition', 'drift', 'Avito searchCore returned an unexpected page');
  }

  const locationId = Number(resultCore.locationId);
  const searchLocation = cleanText(resultCore.locationName);
  if (!Number.isInteger(locationId) || locationId <= 0 || !searchLocation) {
    return fail('schema', 'shape', 'Avito searchCore has an invalid location');
  }
  const requestedQuery = sourceUrl.searchParams.get('q');
  if (requestedQuery != null && comparableText(resultCore.query) !== comparableText(requestedQuery)) {
    return fail('postcondition', 'drift', 'Avito changed the preserved search query');
  }
  if (!resultCore.params || typeof resultCore.params !== 'object' || Array.isArray(resultCore.params)) {
    return fail('schema', 'shape', 'Avito searchCore params are malformed');
  }
  if (Object.keys(resultCore.params).length > MAX_PARAMS) {
    return fail('schema', 'shape', 'Avito searchCore has an implausible params count');
  }
  for (const [attrId, value] of Object.entries(resultCore.params)) {
    if (!/^\d+$/.test(attrId)) {
      return fail('schema', 'shape', 'Avito searchCore contains a malformed params key');
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some((entry) => normalizeScalar(entry) == null)) {
      return fail('schema', 'shape', 'Avito searchCore contains a malformed params value');
    }
  }

  // Walked only to fail closed on a malformed schema: this command reads no
  // filter, it just pages the URL it was given.
  try {
    flattenFilters(resultSections, MAX_FILTERS);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const decodedItems = decodeCatalogRows(resultCatalog, env);
  if (decodedItems.failure) return decodedItems.failure;
  if (decodedItems.rows.length === 0) {
    return fail('catalog', 'empty', 'The requested Avito result page has no listings');
  }

  return {
    success: true,
    resultSearchLocation: searchLocation,
    resultSearchUrl: resultUrl.href,
    resultRows: decodedItems.rows,
  };
}
