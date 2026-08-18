/**
 * The browser half of `avito search`: two document hops for the canonical target
 * and its guards, then the items API for the rows. The document names the search
 * and the API answers it — geo is the one thing a URL cannot apply, and the SSR
 * catalog is complete only in its first twenty cards (F-089).
 */

import { fail } from '../prelude/refusal.mjs';
import { decodeCatalogRows } from '../prelude/card.mjs';
import { normalizeSearchUrl, readDocument } from '../prelude/document.mjs';
import {
  ITEMS_API_PATH,
  PRESERVED_CORE_FIELDS,
  carrySearchCore,
  itemsApiState,
  preservedCoreDrift,
  preservedParamsDrift,
  readItemsApi,
  sealItemsApiUrl,
} from '../prelude/items.mjs';
import {
  addScalar,
  cleanText,
  comparableText,
  normalizeValues,
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

  const sourceParams = sourceCore.params;
  if (!sourceParams || typeof sourceParams !== 'object' || Array.isArray(sourceParams)) {
    return fail('schema', 'shape', 'Avito searchCore params are malformed');
  }
  const sourceParamEntries = Object.entries(sourceParams);
  if (sourceParamEntries.length > MAX_PARAMS) {
    return fail('schema', 'shape', 'Avito searchCore has an implausible params count');
  }

  // The catalog filters of this route are carried unchanged: this command only
  // creates the context, and every refinement of it lives in avito apply-filters.
  // Geo is the exception, because it is the one thing a URL cannot apply.
  const apiUrl = new URL(ITEMS_API_PATH, env.location.origin);
  try {
    carrySearchCore(apiUrl, sourceCore, MAX_PARAM_VALUES, null);
    // Geo arrives as indexed keys, so a carried selection and a requested one
    // would stack into one repeated key instead of replacing it.
    const dropCarriedGeoIds = () => {
      for (const key of [...apiUrl.searchParams.keys()]) {
        if (key.startsWith('metro[') || key.startsWith('district[')) apiUrl.searchParams.delete(key);
      }
    };
    if (refinement.locationRequested) {
      addScalar(apiUrl, 'locationId', refinement.locationId);
      // A metro, district or point of the landed route describes nothing in the
      // city the caller just named, and Avito accepts a foreign ID without a word
      // (F-037), so a new city discards the old geo rather than inheriting it.
      dropCarriedGeoIds();
      apiUrl.searchParams.delete('geoCoords');
      apiUrl.searchParams.delete('radius');
    }
    if (refinement.geoMode) {
      dropCarriedGeoIds();
      refinement.geoIds.forEach((geoId, index) => {
        apiUrl.searchParams.append(refinement.geoMode + '[' + index + ']', geoId);
      });
    }
    // A radius without a point is silently dropped, so the two always travel together.
    if (refinement.radiusRequested) {
      addScalar(apiUrl, 'geoCoords', refinement.coords);
      addScalar(apiUrl, 'radius', refinement.radius);
    }
    sealItemsApiUrl(apiUrl, loaderState, true);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const api = await readItemsApi(apiUrl, schemaResponseUrl, env);
  if (api.failure) return api.failure;
  const apiState = itemsApiState(api.data);
  if (apiState.failure) return apiState.failure;
  const data = api.data;
  const resultCore = apiState.core;
  const resultCatalog = apiState.catalog;

  const driftedField = preservedCoreDrift(sourceCore, resultCore, PRESERVED_CORE_FIELDS);
  if (driftedField) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field ' + driftedField);
  }
  if (!refinement.locationRequested && !sameValues(sourceCore.locationId, resultCore.locationId)) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field locationId');
  }
  // Geo the caller did not touch belongs to the route the query landed on and has
  // to survive, the same way it does through avito apply-filters. A requested city
  // is the one case where it is discarded rather than preserved.
  if (!refinement.locationRequested) {
    if (
      !refinement.geoMode
      && !(sameValues(sourceCore.metroId, resultCore.metroId)
        && sameValues(sourceCore.districtId, resultCore.districtId))
    ) {
      return fail('postcondition', 'drift', 'Avito changed the preserved geo selection');
    }
    if (
      !refinement.radiusRequested
      && !(sameValues(sourceCore.geoCoords, resultCore.geoCoords)
        && sameValues(sourceCore.searchRadius, resultCore.searchRadius))
    ) {
      return fail('postcondition', 'drift', 'Avito changed the preserved search point');
    }
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
  const driftedParam = preservedParamsDrift(sourceParamEntries, resultParams);
  if (driftedParam) {
    return fail('postcondition', 'drift', 'Avito changed preserved params[' + driftedParam + ']');
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
    resultSearchLocation,
    resultSearchUrl,
    contextLocationId: resultCore.locationId ?? null,
    contextPage: resultCore.page ?? null,
    resultRows: decodedItems.rows,
  };
}
