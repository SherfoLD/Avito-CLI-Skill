/**
 * The browser half of `avito search`: two document hops, the guards on the
 * canonical target, the items API request a geo refinement costs, and the
 * postconditions on what came back.
 */

import { fail } from '../prelude/refusal.mjs';
import { decodeCatalogRows } from '../prelude/card.mjs';
import { normalizeSearchUrl, readDocument } from '../prelude/document.mjs';
import {
  addParamValues,
  addScalar,
  cleanText,
  comparableText,
  normalizeValues,
  sameParamValue,
  sameValues,
} from '../prelude/text.mjs';

export async function searchContext(input, env) {
  const {
    queryUrl,
    query,
    refinement,
    MAX_PARAMS,
    MAX_PARAM_VALUES,
    forceFreshSchema,
  } = input;

  // Hop one: Avito answers the public ?q= route with a redirect payload that names
  // the canonical target itself, so no region slug or category route is constructed.
  const entry = await readDocument(queryUrl, 'submit', env, { forceFresh: forceFreshSchema });
  if (entry.failure) return entry.failure;
  if (!entry.payload) {
    if (entry.challenge) {
      return fail('submit', 'access', entry.documentTitle || 'Avito access challenge', { status: entry.status });
    }
    return fail('submit', entry.parseErrors ? 'parse' : 'missing', 'Avito query response has no bootstrap state');
  }
  const entryData = entry.payload.data;
  let canonicalUrl;
  try {
    const target = typeof entry.payload.redirect === 'string' && entry.payload.redirect
      ? entry.payload.redirect
      : entryData?.url;
    if (entryData?.searchCore && entryData?.filtersV2?.Sections) {
      canonicalUrl = normalizeSearchUrl(entry.responseUrl, env);
    } else if (typeof target === 'string' && target) {
      canonicalUrl = normalizeSearchUrl(new URL(target, env.location.origin).href, env);
    } else {
      return fail('submit', 'missing', 'Avito did not report a canonical target for the query');
    }
  } catch (error) {
    return fail('submit', 'shape', String(error?.message || error));
  }

  // The homepage is never a result, and a surviving q must be exactly the requested
  // one. A query that Avito absorbs into a category route drops q and is accepted.
  const canonical = new URL(canonicalUrl);
  const canonicalQuery = canonical.searchParams.get('q');
  if (canonicalQuery != null && comparableText(canonicalQuery) !== comparableText(query)) {
    return fail('submit', 'drift', 'Avito answered with a different query than the requested one');
  }
  if (canonical.pathname === '/') {
    return fail('submit', 'drift', 'Avito did not canonicalize the requested query into a search URL');
  }

  // Hop two: the canonical catalog document carries searchCore, filtersV2 and the
  // rendered catalog, so it serves both the postconditions and the returned rows.
  const schema = await readDocument(canonicalUrl, 'schema', env, { forceFresh: forceFreshSchema });
  if (schema.failure) return schema.failure;
  const loaderState = schema.payload?.data?.searchCore && schema.payload?.data?.filtersV2?.Sections
    ? schema.payload.data
    : null;
  const schemaResponseUrl = schema.responseUrl;
  if (!loaderState) {
    if (schema.challenge) {
      return fail('schema', 'access', schema.documentTitle || 'Avito access challenge', { status: schema.status });
    }
    return fail(
      'schema',
      schema.parseErrors ? 'parse' : 'missing',
      'Avito SSR search bootstrap has no complete search/filter state',
    );
  }

  const sourceCore = loaderState.searchCore;
  const sourceSections = loaderState.filtersV2.Sections;
  if (!sourceCore || typeof sourceCore !== 'object' || !Array.isArray(sourceSections)) {
    return fail('schema', 'shape', 'Avito SSR search/filter state is malformed');
  }
  if (Number(sourceCore.page) !== 1) {
    return fail('schema', 'shape', 'Avito initial search did not resolve to page 1');
  }

  const sourceSearchLocation = cleanText(sourceCore.locationName);
  if (!sourceSearchLocation) {
    return fail('schema', 'shape', 'Avito SSR search state has unsupported effective context');
  }

  if (!refinement.apply) {
    if (!loaderState.catalog || typeof loaderState.catalog !== 'object') {
      return fail('schema', 'shape', 'Avito SSR search state has no catalog');
    }
    const sourceItems = decodeCatalogRows(loaderState.catalog, env);
    if (sourceItems.failure) return sourceItems.failure;
    if (sourceItems.rows.length === 0) {
      return fail('catalog', 'empty', 'No listings match the requested query');
    }
    return {
      success: true,
      refined: false,
      resultSearchLocation: sourceSearchLocation,
      resultSearchUrl: normalizeSearchUrl(schemaResponseUrl, env),
      contextLocationId: sourceCore.locationId ?? null,
      contextPage: sourceCore.page ?? null,
      resultRows: sourceItems.rows,
    };
  }

  const sourceParams = sourceCore.params;
  if (!sourceParams || typeof sourceParams !== 'object' || Array.isArray(sourceParams)) {
    return fail('schema', 'shape', 'Avito searchCore params are malformed');
  }
  const sourceParamEntries = Object.entries(sourceParams);
  if (sourceParamEntries.length > MAX_PARAMS) {
    return fail('schema', 'shape', 'Avito searchCore has an implausible params count');
  }

  const apiUrl = new URL('/web/1/js/items', env.location.origin);
  try {
    addScalar(apiUrl, 'categoryId', sourceCore.categoryId);
    addScalar(apiUrl, 'locationId', refinement.locationRequested ? refinement.locationId : sourceCore.locationId);
    if (refinement.geoMode) {
      refinement.geoIds.forEach((geoId, index) => {
        apiUrl.searchParams.append(refinement.geoMode + '[' + index + ']', geoId);
      });
    }
    addScalar(apiUrl, 'name', sourceCore.query);
    // A radius without a point is silently dropped, so the two always travel together.
    if (refinement.radiusRequested) {
      addScalar(apiUrl, 'geoCoords', refinement.coords);
      addScalar(apiUrl, 'radius', refinement.radius);
    } else if (Array.isArray(sourceCore.geoCoords) && sourceCore.geoCoords.length === 2) {
      addScalar(apiUrl, 'geoCoords', sourceCore.geoCoords.join(','));
    }
    addScalar(apiUrl, 'cd', sourceCore.correctorMode ?? 0);
    for (const [attrId, value] of sourceParamEntries) addParamValues(apiUrl, attrId, value, MAX_PARAM_VALUES);
    addScalar(apiUrl, 'verticalCategoryId', sourceCore.verticalCategoryId);
    addScalar(apiUrl, 'rootCategoryId', sourceCore.rootCategoryId);
    // The catalog filters of this route are carried unchanged: this command only
    // creates the context, and every refinement of it lives in avito apply-filters.
    addScalar(apiUrl, 'localPriority', sourceCore.localPriority);
    addScalar(apiUrl, 'pmin', sourceCore.priceMin);
    addScalar(apiUrl, 'pmax', sourceCore.priceMax);
    addScalar(apiUrl, 'user', sourceCore.owner);
    addScalar(apiUrl, 'd', sourceCore.withDeliveryOnly);
    addScalar(apiUrl, 's', sourceCore.sort);

    const subscription = loaderState.subscription;
    if (subscription && typeof subscription === 'object' && !Array.isArray(subscription)) {
      for (const key of ['visible', 'isShowSavedTooltip', 'isErrorSaved', 'isAuthenticated']) {
        if (subscription[key] != null) addScalar(apiUrl, 'subscription[' + key + ']', subscription[key]);
      }
    }
    addScalar(apiUrl, 'proprofile', loaderState.meta?.proprofile);
    apiUrl.searchParams.set('useReload', 'true');
    apiUrl.searchParams.set('spaFlow', 'true');
    if (typeof loaderState.context !== 'string' || !loaderState.context || loaderState.context.length > 10000) {
      throw new Error('Avito SSR state has no usable opaque context');
    }
    apiUrl.searchParams.set('context', loaderState.context);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const apiController = new AbortController();
  const apiTimer = setTimeout(() => apiController.abort(), 20000);
  let apiResponse;
  let data;
  try {
    apiResponse = await env.fetch(apiUrl.href, {
      credentials: 'include',
      referrer: schemaResponseUrl,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Source': 'client-browser',
      },
      signal: apiController.signal,
    });
    const text = await apiResponse.text();
    try {
      data = JSON.parse(text);
    } catch {
      return fail('api', 'parse', 'Avito items API returned malformed JSON', { status: apiResponse.status });
    }
  } catch (error) {
    return fail('api', 'transport', String(error?.message || error));
  } finally {
    clearTimeout(apiTimer);
  }

  if (apiResponse.status === 429 || data?.['too-many-requests'] || data?.firewallCaptcha || data?.captcha) {
    return fail('api', 'access', 'Avito rate limit or access challenge', { status: apiResponse.status });
  }
  if (!apiResponse.ok || apiResponse.status !== 200) {
    return fail('api', 'http', 'Avito items API request failed', { status: apiResponse.status });
  }
  if (!(apiResponse.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    return fail('api', 'content_type', 'Avito items API response is not JSON');
  }

  const resultCore = data?.searchCore;
  const resultCatalog = data?.catalog;
  const resultSections = data?.filtersV2?.Sections;
  if (
    !resultCore || typeof resultCore !== 'object'
    || !resultCatalog || typeof resultCatalog !== 'object'
    || !Array.isArray(resultSections)
    || typeof data?.url !== 'string'
  ) {
    return fail('api', 'shape', 'Avito items API response is missing required state');
  }

  const alwaysPreserved = [
    'verticalCategoryId', 'rootCategoryId', 'categoryId', 'query',
    'priceMin', 'priceMax', 'owner', 'withDeliveryOnly', 'localPriority', 'sort',
  ];
  for (const field of alwaysPreserved) {
    if (!sameValues(sourceCore[field], resultCore[field])) {
      return fail('postcondition', 'drift', 'Avito changed preserved search field ' + field);
    }
  }
  if (!refinement.locationRequested && !sameValues(sourceCore.locationId, resultCore.locationId)) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field locationId');
  }
  if (Number(resultCore.page) !== 1) {
    return fail('postcondition', 'drift', 'Avito returned an unexpected page');
  }
  if (refinement.locationRequested && !sameValues(resultCore.locationId, refinement.locationId)) {
    return fail('postcondition', 'drift', 'Avito did not apply the requested location');
  }
  if (refinement.geoMode) {
    // Avito answers 200 with an empty set for an unknown ID and accepts a foreign one,
    // so the applied set must match exactly and the other geo mode must stay empty.
    const appliedGeo = refinement.geoMode === 'metro' ? resultCore.metroId : resultCore.districtId;
    if (!sameValues(appliedGeo, refinement.geoIds)) {
      return fail('postcondition', 'drift', 'Avito did not apply the requested ' + refinement.geoMode);
    }
    const otherGeo = refinement.geoMode === 'metro' ? resultCore.districtId : resultCore.metroId;
    if (normalizeValues(otherGeo).length !== 0) {
      return fail('postcondition', 'drift', 'Avito returned a second active geo mode');
    }
  }
  if (refinement.radiusRequested) {
    // An ignored radius comes back as searchRadius null rather than as an error, and
    // the point is only honoured together with it, so both are confirmed exactly.
    // Coordinates are compared numerically because the response returns them as
    // numbers while the argument arrives as text.
    if (!sameValues(resultCore.searchRadius, refinement.radius)) {
      return fail('postcondition', 'drift', 'Avito did not apply the requested radius');
    }
    const appliedCoords = normalizeValues(resultCore.geoCoords).map(Number);
    if (
      appliedCoords.length !== 2
      || appliedCoords[0] !== Number(refinement.latitude)
      || appliedCoords[1] !== Number(refinement.longitude)
    ) {
      return fail('postcondition', 'drift', 'Avito did not apply the requested coordinates');
    }
  }
  const resultParams = resultCore.params;
  if (!resultParams || typeof resultParams !== 'object' || Array.isArray(resultParams)) {
    return fail('postcondition', 'shape', 'Avito response searchCore params are malformed');
  }
  for (const [attrId, value] of sourceParamEntries) {
    if (!sameParamValue(value, resultParams[attrId])) {
      return fail('postcondition', 'drift', 'Avito changed preserved params[' + attrId + ']');
    }
  }

  let resultSearchUrl;
  try {
    resultSearchUrl = normalizeSearchUrl(data.url, env);
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }
  const resultSearchLocation = cleanText(resultCore.locationName);
  if (!resultSearchLocation) {
    return fail('postcondition', 'shape', 'Avito returned unsupported effective search context');
  }

  const decodedItems = decodeCatalogRows(resultCatalog, env);
  if (decodedItems.failure) return decodedItems.failure;
  if (decodedItems.rows.length === 0) {
    const count = Number(data.count ?? data.totalCount ?? 0);
    if (Number.isFinite(count) && count === 0) {
      return fail('catalog', 'empty', 'No listings match the requested query in this location');
    }
    return fail('catalog', 'shape', 'Avito returned no catalog items with a non-zero result count');
  }

  return {
    success: true,
    refined: true,
    resultSearchLocation,
    resultSearchUrl,
    contextLocationId: resultCore.locationId ?? null,
    contextPage: resultCore.page ?? null,
    resultRows: decodedItems.rows,
  };
}
