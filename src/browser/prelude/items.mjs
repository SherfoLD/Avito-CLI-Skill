/**
 * The items API, `/web/1/js/items`, shared by the four commands that return a
 * catalog page.
 *
 * It is not addressable on its own: a call carries a whole `searchCore`, which
 * only an SSR document has, so a document read always comes first and the API
 * answers about the state that document was in (F-090). What the second request
 * buys is a complete page — the SSR catalog ships only its first twenty cards in
 * full, and the API all fifty (F-089).
 */

import { fail } from './refusal.mjs';
import {
  addParamValues,
  addScalar,
  normalizeValues,
  sameParamValue,
  sameValues,
} from './text.mjs';

export const ITEMS_API_PATH = '/web/1/js/items';

export const ITEMS_API_TIMEOUT_MS = 20000;

/**
 * The fields that describe the search rather than the request that carried it.
 * `locationId` is not among them: it is preserved for three commands and
 * requested anew by the fourth, so each caller names it or does not.
 */
export const PRESERVED_CORE_FIELDS = [
  'verticalCategoryId', 'rootCategoryId', 'categoryId', 'query',
  'priceMin', 'priceMax', 'owner', 'withDeliveryOnly', 'localPriority', 'sort',
];

/**
 * Carry a `searchCore` onto a request URL unchanged. `skipParamIds` belongs to
 * the caller that replaces a `params[...]` entry instead of preserving it;
 * everyone else passes null and carries the lot.
 */
export function carrySearchCore(apiUrl, sourceCore, maxParamValues, skipParamIds) {
  addScalar(apiUrl, 'categoryId', sourceCore.categoryId);
  addScalar(apiUrl, 'locationId', sourceCore.locationId);
  addScalar(apiUrl, 'name', sourceCore.query);
  normalizeValues(sourceCore.metroId).forEach((entry, index) => {
    apiUrl.searchParams.append('metro[' + index + ']', entry);
  });
  normalizeValues(sourceCore.districtId).forEach((entry, index) => {
    apiUrl.searchParams.append('district[' + index + ']', entry);
  });
  // A radius without a point is silently dropped, so the two always travel together.
  if (Array.isArray(sourceCore.geoCoords) && sourceCore.geoCoords.length === 2) {
    addScalar(apiUrl, 'geoCoords', sourceCore.geoCoords.join(','));
    addScalar(apiUrl, 'radius', sourceCore.searchRadius);
  }
  addScalar(apiUrl, 'cd', sourceCore.correctorMode ?? 0);
  for (const [attrId, value] of Object.entries(sourceCore.params ?? {})) {
    if (skipParamIds && skipParamIds.has(attrId)) continue;
    addParamValues(apiUrl, attrId, value, maxParamValues);
  }
  addScalar(apiUrl, 'verticalCategoryId', sourceCore.verticalCategoryId);
  addScalar(apiUrl, 'rootCategoryId', sourceCore.rootCategoryId);
  addScalar(apiUrl, 'localPriority', sourceCore.localPriority);
  addScalar(apiUrl, 'pmin', sourceCore.priceMin);
  addScalar(apiUrl, 'pmax', sourceCore.priceMax);
  addScalar(apiUrl, 'user', sourceCore.owner);
  addScalar(apiUrl, 'd', sourceCore.withDeliveryOnly);
  addScalar(apiUrl, 's', sourceCore.sort);
}

/**
 * Avito's page number, on the carrier that has one. Page 1 is the request
 * without the key, exactly as it is the URL without `p`; both spellings the
 * server accepts come back normalized to `p` in the URL it returns (F-091).
 */
export function addItemsApiPage(apiUrl, page) {
  if (page > 1) apiUrl.searchParams.set('p', String(page));
}

/**
 * The keys that make the request a page load.
 *
 * `context` is the opaque string of the document being carried over, and only a
 * page-1 document ships one: past page 1 the SSR bootstrap has no `context` key
 * at all, and the API answers the same page without it (F-092). So a caller
 * reading a deep document passes `requireContext` false, and one reading page 1
 * passes true, where a missing context is drift rather than an absent key.
 */
export function sealItemsApiUrl(apiUrl, loaderState, requireContext) {
  const subscription = loaderState.subscription;
  if (subscription && typeof subscription === 'object' && !Array.isArray(subscription)) {
    for (const key of ['visible', 'isShowSavedTooltip', 'isErrorSaved', 'isAuthenticated']) {
      if (subscription[key] != null) addScalar(apiUrl, 'subscription[' + key + ']', subscription[key]);
    }
  }
  addScalar(apiUrl, 'proprofile', loaderState.meta?.proprofile);
  apiUrl.searchParams.set('useReload', 'true');
  apiUrl.searchParams.set('spaFlow', 'true');
  const context = loaderState.context;
  if (context == null && !requireContext) return;
  if (typeof context !== 'string' || !context || context.length > 10000) {
    throw new Error('Avito SSR state has no usable opaque context');
  }
  apiUrl.searchParams.set('context', context);
}

/** One request. Returns `{ failure }` or `{ data }`; the API is never retried. */
export async function readItemsApi(apiUrl, referrer, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ITEMS_API_TIMEOUT_MS);
  let response;
  let data;
  try {
    response = await env.fetch(apiUrl.href, {
      credentials: 'include',
      referrer,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Source': 'client-browser',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      return { failure: fail('api', 'parse', 'Avito items API returned malformed JSON', { status: response.status }) };
    }
  } catch (error) {
    return { failure: fail('api', 'transport', String(error?.message || error)) };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429 || data?.['too-many-requests'] || data?.firewallCaptcha || data?.captcha) {
    return { failure: fail('api', 'access', 'Avito rate limit or access challenge', { status: response.status }) };
  }
  if (!response.ok || response.status !== 200) {
    return { failure: fail('api', 'http', 'Avito items API request failed', { status: response.status }) };
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    return { failure: fail('api', 'content_type', 'Avito items API response is not JSON') };
  }
  return { data };
}

/** The four carriers every caller needs out of a response, or `{ failure }`. */
export function itemsApiState(data) {
  const core = data?.searchCore;
  const catalog = data?.catalog;
  const sections = data?.filtersV2?.Sections;
  if (
    !core || typeof core !== 'object'
    || !catalog || typeof catalog !== 'object'
    || !Array.isArray(sections)
    || typeof data?.url !== 'string'
  ) {
    return { failure: fail('api', 'shape', 'Avito items API response is missing required state') };
  }
  return {
    core, catalog, sections, url: data.url,
  };
}

/** The name of the first preserved field the response changed, or null. */
export function preservedCoreDrift(sourceCore, resultCore, fields) {
  for (const field of fields) {
    if (!sameValues(sourceCore[field], resultCore[field])) return field;
  }
  return null;
}

/** The ID of the first `params[...]` entry the response changed, or null. */
export function preservedParamsDrift(sourceParamEntries, resultParams) {
  for (const [attrId, value] of sourceParamEntries) {
    if (!sameParamValue(value, resultParams[attrId])) return attrId;
  }
  return null;
}

/**
 * The page number the API wrote into the URL it returned. Read as a second
 * witness beside `searchCore.page`, because the two are produced by different
 * halves of Avito's own response.
 */
export function itemsApiUrlPage(url, env) {
  const parsed = new URL(url, env.location.origin);
  const page = parsed.searchParams.get('p');
  if (page == null) return 1;
  return /^\d+$/.test(page) ? Number(page) : null;
}
