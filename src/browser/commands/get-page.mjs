/**
 * The browser half of `avito get-page`: two carriers, and the postconditions
 * that tie them to one another.
 *
 * The document is what proves the page. Avito canonicalizes the URL it is given,
 * and a search URL that quietly lost a filter still returns fifty perfectly
 * plausible listings — nothing in the rows would show it. So the canonical URL
 * is compared pair by pair against the requested one with `p` excluded, and
 * `searchCore.page` must be the requested number rather than merely a number.
 *
 * The rows come from the items API, which the document's own `searchCore` and
 * `context` address: the SSR catalog carries only its first twenty cards in
 * full, and the same page through the API is complete on all fifty (F-089).
 */

import { fail } from '../prelude/refusal.mjs';
import { decodeCatalogRows } from '../prelude/card.mjs';
import { readDocument } from '../prelude/document.mjs';
import { flattenFilters } from '../prelude/filters.mjs';
import {
  ITEMS_API_PATH,
  PRESERVED_CORE_FIELDS,
  addItemsApiPage,
  carrySearchCore,
  itemsApiState,
  itemsApiUrlPage,
  preservedCoreDrift,
  preservedParamsDrift,
  readItemsApi,
  sealItemsApiUrl,
} from '../prelude/items.mjs';
import { cleanText, comparableText, normalizeScalar } from '../prelude/text.mjs';

export async function paginate(input, env) {
  const {
    requestedUrl, requestedPage, MAX_FILTERS, MAX_PARAMS, MAX_PARAM_VALUES,
  } = input;

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

  const documentCore = loaderState.searchCore;
  const documentSections = loaderState.filtersV2.Sections;
  if (
    !documentCore || typeof documentCore !== 'object'
    || !loaderState.catalog || typeof loaderState.catalog !== 'object'
    || !Array.isArray(documentSections)
  ) {
    return fail('schema', 'shape', 'Avito SSR page state is malformed');
  }
  if (Number(documentCore.page) !== requestedPage) {
    return fail('postcondition', 'drift', 'Avito searchCore returned an unexpected page');
  }

  const locationId = Number(documentCore.locationId);
  const searchLocation = cleanText(documentCore.locationName);
  if (!Number.isInteger(locationId) || locationId <= 0 || !searchLocation) {
    return fail('schema', 'shape', 'Avito searchCore has an invalid location');
  }
  const requestedQuery = sourceUrl.searchParams.get('q');
  if (requestedQuery != null && comparableText(documentCore.query) !== comparableText(requestedQuery)) {
    return fail('postcondition', 'drift', 'Avito changed the preserved search query');
  }
  if (!documentCore.params || typeof documentCore.params !== 'object' || Array.isArray(documentCore.params)) {
    return fail('schema', 'shape', 'Avito searchCore params are malformed');
  }
  const documentParamEntries = Object.entries(documentCore.params);
  if (documentParamEntries.length > MAX_PARAMS) {
    return fail('schema', 'shape', 'Avito searchCore has an implausible params count');
  }
  for (const [attrId, value] of documentParamEntries) {
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
    flattenFilters(documentSections, MAX_FILTERS);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const apiUrl = new URL(ITEMS_API_PATH, env.location.origin);
  try {
    carrySearchCore(apiUrl, documentCore, MAX_PARAM_VALUES, null);
    addItemsApiPage(apiUrl, requestedPage);
    // Page 1 ships a context and a missing one there is drift; a deeper document
    // has no such key at all (F-092).
    sealItemsApiUrl(apiUrl, loaderState, requestedPage === 1);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const api = await readItemsApi(apiUrl, document.responseUrl, env);
  if (api.failure) return api.failure;
  const apiState = itemsApiState(api.data);
  if (apiState.failure) return apiState.failure;

  // Nothing about the page may change on the way to the second carrier: the
  // document already named the search, and the API is being asked for its rows.
  const driftedField = preservedCoreDrift(documentCore, apiState.core, [
    ...PRESERVED_CORE_FIELDS, 'locationId', 'metroId', 'districtId',
  ]);
  if (driftedField) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field ' + driftedField);
  }
  if (Number(apiState.core.page) !== requestedPage) {
    return fail('postcondition', 'drift', 'Avito items API returned an unexpected page');
  }
  if (!apiState.core.params || typeof apiState.core.params !== 'object' || Array.isArray(apiState.core.params)) {
    return fail('postcondition', 'shape', 'Avito items API searchCore params are malformed');
  }
  const driftedParam = preservedParamsDrift(documentParamEntries, apiState.core.params);
  if (driftedParam) {
    return fail('postcondition', 'drift', 'Avito changed preserved params[' + driftedParam + ']');
  }

  let apiPathname;
  let apiPage;
  try {
    const parsed = new URL(apiState.url, env.location.origin);
    apiPathname = parsed.pathname;
    apiPage = itemsApiUrlPage(apiState.url, env);
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }
  if (apiPathname !== sourceUrl.pathname) {
    return fail('postcondition', 'drift', 'Avito items API answered on a different route');
  }
  if (apiPage !== requestedPage) {
    return fail('postcondition', 'drift', 'Avito items API returned an unexpected page number in its URL');
  }

  const decodedItems = decodeCatalogRows(apiState.catalog, env);
  if (decodedItems.failure) return decodedItems.failure;
  if (decodedItems.rows.length === 0) {
    return fail('catalog', 'empty', 'The requested Avito result page has no listings');
  }

  return {
    success: true,
    resultSearchLocation: searchLocation,
    // The document's canonical URL, not the API's: this is the URL the next
    // command pages, and the API answers about a route rather than to one.
    resultSearchUrl: resultUrl.href,
    resultRows: decodedItems.rows,
  };
}
