/**
 * `avito search` — start a search and return its first page.
 *
 * Two document hops and one items API call. Avito answers the public `?q=` route
 * with a payload that names the canonical target itself, so no region slug or
 * category route is ever constructed; the canonical catalog document then
 * carries the `searchCore` the API request is built from, and the API answers
 * with all fifty cards where the SSR catalog is complete only in its first
 * twenty (F-089).
 *
 * The directory calls come first on purpose. Avito accepts geo values it does
 * not apply, so a check made after the search would be checking the wrong thing
 * (F-037).
 */

import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { CATALOG_DOCUMENT, QUERY_DOCUMENT } from '../schemas/document.mjs';
import { LISTING_ROW, applyReservedFilter, listingRows } from '../site/listing.mjs';
import { catalogRows } from '../site/card.mjs';
import {
  CATALOG_KEYS,
  primeOrigin,
  readCatalogPage,
  readDocument,
  resultCount,
} from '../site/carriers.mjs';
import {
  PRESERVED_CORE_FIELDS,
  carrySearchCore,
  coreParamEntries,
  itemsApiUrl,
  preservedCoreDrift,
  preservedParamsDrift,
  sealItemsApiUrl,
} from '../site/items.mjs';
import {
  addScalar,
  cleanText,
  normalizeValues,
  sameValues,
} from '../site/text.mjs';
import { AVITO_ORIGIN, answeredUrl } from '../site/url.mjs';
import {
  capabilityParameter,
  fetchAvitoJson,
  geoDirectory,
  locationDescriptor,
  locationDisplayName,
} from '../site/geo.mjs';

const COMMAND = 'avito search';
const MAX_GEO_VALUES = 50;

function normalizeLocationId(value) {
  if (value == null || value === '') return null;
  const locationId = Number(value);
  if (!Number.isSafeInteger(locationId) || locationId <= 0) {
    throw new ArgumentError('location-id must be a positive integer returned by `avito get-location`');
  }
  return String(locationId);
}

function normalizeGeoIds(value, label) {
  if (value == null || value === '') return null;
  const requested = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (requested.length === 0) {
    throw new ArgumentError(`${label} must contain at least one ID`);
  }
  if (requested.length > MAX_GEO_VALUES) {
    throw new ArgumentError(`${label} accepts at most ${MAX_GEO_VALUES} IDs`);
  }
  const unique = [];
  for (const entry of requested) {
    if (!/^\d+$/.test(entry) || Number(entry) <= 0) {
      throw new ArgumentError(
        `${label} must contain positive integer IDs returned by \`avito get-location --geo\``,
      );
    }
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique;
}

// The pair is kept as the exact text Avito returned in `avito get-coords`, because the request
// parameter and the `searchCore.geoCoords` postcondition are compared on that same text.
function normalizeCoords(value) {
  if (value == null || value === '') return null;
  const parts = cleanText(value).split(',').map((entry) => entry.trim());
  if (parts.length !== 2) {
    throw new ArgumentError('coords must be "<latitude>,<longitude>" from `avito get-coords`');
  }
  const [latitude, longitude] = parts;
  if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(latitude) || !/^-?\d{1,3}(\.\d{1,8})?$/.test(longitude)) {
    throw new ArgumentError('coords must be two decimal numbers from `avito get-coords`');
  }
  const latitudeValue = Number(latitude);
  const longitudeValue = Number(longitude);
  if (!Number.isFinite(latitudeValue) || latitudeValue < -90 || latitudeValue > 90) {
    throw new ArgumentError('coords latitude must be between -90 and 90');
  }
  if (!Number.isFinite(longitudeValue) || longitudeValue < -180 || longitudeValue > 180) {
    throw new ArgumentError('coords longitude must be between -180 and 180');
  }
  return { serialized: `${latitude},${longitude}`, latitude, longitude };
}

function normalizeRadius(value) {
  if (value == null || value === '') return null;
  const radius = Number(value);
  if (!Number.isInteger(radius) || radius <= 0) {
    throw new ArgumentError('radius must be a positive integer number of kilometres');
  }
  return String(radius);
}

function normalizeBoolean(value, label) {
  if (value == null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new ArgumentError(`${label} must be a boolean flag`);
}

// Avito answers `https://www.avito.ru/?q=<query>` from the bare origin, keeps the session
// region and reports the canonical target itself, so the search is one deterministic
// navigation instead of a visible form submit.
export function buildQueryUrl(query) {
  const requestUrl = new URL('/', AVITO_ORIGIN);
  requestUrl.searchParams.set('q', query);
  return requestUrl.href;
}

// Avito canonicalizes every `?q=` request into a category route and keeps `q` only for
// part of them: `ddr5 32gb` stays a text search, while `iphone` is absorbed into the Apple
// category and `iphone 13 pro max 256` into a model route with an opaque structured filter.
// An absorbed query is a real Avito answer, so it is accepted; a preserved `q` must still
// be exactly the requested one, and the bare homepage is never a search result.
export function decodeLandedSearch(href, query) {
  const landed = answeredUrl(href, 'search result URL');
  const landedQuery = landed.searchParams.get('q');
  if (landedQuery != null && cleanText(landedQuery) !== cleanText(query)) {
    return { accepted: false, reason: 'query' };
  }
  if (landed.pathname === '/') {
    return { accepted: false, reason: 'homepage' };
  }
  return { accepted: true, landedUrl: landed.href, queryPreserved: landedQuery != null };
}

/** The one message a rejected landing gets, wherever it was rejected. */
function landingError(reason) {
  return new CommandExecutionError(
    reason === 'query'
      ? 'Avito answered with a different query than the requested one'
      : 'Avito did not canonicalize the requested query into a search URL',
  );
}

function decodeGeoDirectoryIds(payload, mode) {
  const entries = payload?.[geoDirectory(mode).collection];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new CommandExecutionError(`Avito ${mode} directory response has an unexpected shape`);
  }
  const known = new Map();
  for (const entry of entries) {
    const name = cleanText(entry?.name);
    if (!Number.isInteger(entry?.id) || entry.id <= 0 || !name) {
      throw new CommandExecutionError(`Avito ${mode} directory contains a malformed entry`);
    }
    known.set(String(entry.id), name);
  }
  return known;
}

// Avito silently drops an unknown geo ID and silently accepts one that belongs to a
// different city, so membership in the target location's fresh directory is checked here
// before any search request is made.
async function validateGeoSelection(page, locationId, mode, geoIds) {
  const capabilities = await fetchAvitoJson(
    page,
    '/web/1/search/locations',
    { locationId },
    'requesting Avito location capabilities',
  );

  const descriptor = locationDescriptor(capabilities, locationId);
  const locationName = locationDisplayName(descriptor, locationId);
  const capability = descriptor[geoDirectory(mode).capability];
  if (typeof capability !== 'boolean') {
    throw new CommandExecutionError(`Avito location capabilities are missing the ${mode} flag`);
  }
  if (!capability) {
    throw new ArgumentError(`Avito location "${locationName}" (${locationId}) has no ${mode}`);
  }

  const known = decodeGeoDirectoryIds(
    await fetchAvitoJson(
      page,
      geoDirectory(mode).path,
      { locationId },
      `requesting Avito ${mode} directory`,
    ),
    mode,
  );
  const unknown = geoIds.filter((geoId) => !known.has(geoId));
  if (unknown.length > 0) {
    throw new ArgumentError(
      `${mode} ID ${unknown.join(', ')} does not belong to "${locationName}" (${locationId}). `
      + 'Use `avito get-location <query> --geo` to list valid IDs.',
    );
  }
  return { locationName, selected: geoIds.map((geoId) => known.get(geoId)) };
}

// Avito accepts any radius value and silently ignores the ones it does not offer, so the
// requested distance is checked against the visible km list of the target location first.
async function validateRadiusSelection(page, locationId, radius) {
  const capabilities = await fetchAvitoJson(
    page,
    '/web/1/search/locations',
    { locationId },
    'requesting Avito location capabilities',
  );

  const descriptor = locationDescriptor(capabilities, locationId);
  const locationName = locationDisplayName(descriptor, locationId);
  const radiusParameter = capabilityParameter(capabilities, 'smallRadius');

  const offered = Array.isArray(radiusParameter?.values) ? radiusParameter.values : null;
  if (!offered || offered.length === 0) {
    throw new CommandExecutionError('Avito location capabilities carry no visible radius list');
  }
  const available = [];
  for (const entry of offered) {
    if (!Number.isInteger(entry?.radiusValue) || entry.radiusValue <= 0) {
      throw new CommandExecutionError('Avito radius list contains a malformed entry');
    }
    const value = String(entry.radiusValue);
    if (!available.includes(value)) available.push(value);
  }
  if (!available.includes(radius)) {
    throw new ArgumentError(
      `Avito does not offer radius ${radius} km in "${locationName}" (${locationId}). `
      + `Visible values: ${available.join(', ')}.`,
    );
  }
  return { locationName };
}

/** Hop one: the canonical route Avito names for this query, in its own words. */
async function resolveCanonicalUrl(page, query) {
  const entry = await readDocument(page, {
    requestUrl: buildQueryUrl(query),
    stage: 'submit',
    keep: CATALOG_KEYS,
    schema: QUERY_DOCUMENT,
    subject: 'Avito SSR query state',
    command: COMMAND,
  });

  const state = entry.state;
  const named = entry.redirect ?? state.url;
  const answered = state.searchCore && state.filtersV2?.Sections
    ? entry.responseUrl
    : (named == null || named === '' ? null : String(named));
  if (answered === null) {
    throw new CommandExecutionError('Avito did not report a canonical target for the query');
  }

  const canonical = answeredUrl(answered, 'search result URL');
  const landed = decodeLandedSearch(canonical.href, query);
  if (!landed.accepted) throw landingError(landed.reason);
  return canonical.href;
}

/**
 * The catalog filters of the landed route are carried unchanged: this command
 * only creates the context, and every refinement of it lives in
 * `avito apply-filters`. Geo is the exception, because it is the one thing a URL
 * cannot apply.
 */
function buildSearchRequest(state, refinement) {
  const apiUrl = itemsApiUrl();
  carrySearchCore(apiUrl, state.searchCore);

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
      apiUrl.searchParams.append(`${refinement.geoMode}[${index}]`, geoId);
    });
  }
  // A radius without a point is silently dropped, so the two always travel together.
  if (refinement.radiusRequested) {
    addScalar(apiUrl, 'geoCoords', refinement.coords);
    addScalar(apiUrl, 'radius', refinement.radius);
  }
  sealItemsApiUrl(apiUrl, state, true);
  return apiUrl;
}

/** What the answer has to show before its rows mean anything. */
function assertSearchApplied(sourceCore, resultCore, refinement) {
  const driftedField = preservedCoreDrift(sourceCore, resultCore, PRESERVED_CORE_FIELDS);
  if (driftedField) {
    throw new CommandExecutionError(`Avito changed preserved search field ${driftedField}`);
  }
  if (!refinement.locationRequested && !sameValues(sourceCore.locationId, resultCore.locationId)) {
    throw new CommandExecutionError('Avito changed preserved search field locationId');
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
      throw new CommandExecutionError('Avito changed the preserved geo selection');
    }
    if (
      !refinement.radiusRequested
      && !(sameValues(sourceCore.geoCoords, resultCore.geoCoords)
        && sameValues(sourceCore.searchRadius, resultCore.searchRadius))
    ) {
      throw new CommandExecutionError('Avito changed the preserved search point');
    }
  }
  if (Number(resultCore.page) !== 1) {
    throw new CommandExecutionError('Avito returned an unexpected page');
  }
  if (refinement.locationRequested && !sameValues(resultCore.locationId, refinement.locationId)) {
    throw new CommandExecutionError('Avito did not apply the requested location');
  }
  if (refinement.geoMode) {
    // Avito answers 200 with an empty set for an unknown ID and accepts a foreign one,
    // so the applied set must match exactly and the other geo mode must stay empty.
    const appliedGeo = refinement.geoMode === 'metro' ? resultCore.metroId : resultCore.districtId;
    if (!sameValues(appliedGeo, refinement.geoIds)) {
      throw new CommandExecutionError(`Avito did not apply the requested ${refinement.geoMode}`);
    }
    const otherGeo = refinement.geoMode === 'metro' ? resultCore.districtId : resultCore.metroId;
    if (normalizeValues(otherGeo).length !== 0) {
      throw new CommandExecutionError('Avito returned a second active geo mode');
    }
  }
  if (refinement.radiusRequested) {
    // An ignored radius comes back as searchRadius null rather than as an error, and
    // the point is only honoured together with it, so both are confirmed exactly.
    // Coordinates are compared numerically because the response returns them as
    // numbers while the argument arrives as text.
    if (!sameValues(resultCore.searchRadius, refinement.radius)) {
      throw new CommandExecutionError('Avito did not apply the requested radius');
    }
    const appliedCoords = normalizeValues(resultCore.geoCoords).map(Number);
    if (
      appliedCoords.length !== 2
      || appliedCoords[0] !== Number(refinement.latitude)
      || appliedCoords[1] !== Number(refinement.longitude)
    ) {
      throw new CommandExecutionError('Avito did not apply the requested coordinates');
    }
  }
}

export default defineCommand({
  name: 'search',
  description: 'Start an Avito search: returns the first page of listings and the search URL every other command takes. Refine that URL with avito get-filters and avito apply-filters, not here',
  access: 'read',
  // vocabulary-ok: sample argument in help text, not an identifier the command uses
  example: 'avito search <query> --location-id 650400 -f json',
  domain: 'www.avito.ru',
  args: [
    { name: 'query', type: 'string', required: true, positional: true, help: 'Search query' },
    { name: 'location-id', type: 'int', help: 'Avito location ID from `avito get-location` (omit to keep the current region)' },
    { name: 'metro', type: 'string', help: 'Comma-separated metro station IDs from `avito get-location --geo metro`' },
    { name: 'district', type: 'string', help: 'Comma-separated district IDs from `avito get-location --geo districts`' },
    { name: 'coords', type: 'string', help: 'Search centre as "<latitude>,<longitude>" from `avito get-coords` (requires --radius)' },
    { name: 'radius', type: 'int', help: 'Radius in km around --coords, limited to the values Avito offers for the location' },
    { name: 'remove-reserved', type: 'bool', default: false, help: 'Drop the listings Avito marks as reserved; Avito has no server-side filter for them, so the page comes back shorter' },
  ],
  row: LISTING_ROW,
  run: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) {
      throw new ArgumentError('query must be a non-empty string');
    }
    const requestedLocationId = normalizeLocationId(args['location-id']);
    const requestedMetro = normalizeGeoIds(args.metro, 'metro');
    const requestedDistrict = normalizeGeoIds(args.district, 'district');
    if (requestedMetro && requestedDistrict) {
      throw new ArgumentError(
        'metro and district are separate tabs of one Avito geo filter; pass only one of them',
      );
    }
    const geoMode = requestedMetro ? 'metro' : (requestedDistrict ? 'district' : null);
    const geoIds = requestedMetro ?? requestedDistrict;
    if (geoMode && !requestedLocationId) {
      throw new ArgumentError(
        `${geoMode} IDs are only meaningful inside their own location; pass --location-id as well`,
      );
    }
    const requestedCoords = normalizeCoords(args.coords);
    const requestedRadius = normalizeRadius(args.radius);
    // Radius, metro and districts are tabs of one Avito geo filter, and the server accepts
    // them together only because it validates nothing.
    if (requestedCoords || requestedRadius) {
      if (geoMode) {
        throw new ArgumentError(
          `radius and ${geoMode} are separate tabs of one Avito geo filter; pass only one of them`,
        );
      }
      if (!requestedCoords || !requestedRadius) {
        throw new ArgumentError(
          'coords and radius are applied only together: a radius without a point is silently '
          + 'ignored by Avito. Resolve the point with `avito get-coords <address>` first.',
        );
      }
      if (!requestedLocationId) {
        throw new ArgumentError(
          'radius is only meaningful inside a known location; pass --location-id as well',
        );
      }
    }
    // Reservation is not a filter Avito offers: the fresh schema of the searched context
    // never mentions it, so this flag is an explicit local predicate over the page Avito
    // returned, and it deliberately stays out of `refinement` so it can never be mistaken
    // for a server-applied key (F-048, D-024).
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');
    // Only geo refines the initial search. Price, seller, delivery, local priority and sort
    // moved to `avito apply-filters`, where they are ordinary filter keys next to
    // params[...] (D-031).
    const refinement = {
      locationRequested: requestedLocationId != null,
      locationId: requestedLocationId,
      geoMode,
      geoIds,
      radiusRequested: requestedRadius != null,
      radius: requestedRadius,
      coords: requestedCoords?.serialized ?? null,
      latitude: requestedCoords?.latitude ?? null,
      longitude: requestedCoords?.longitude ?? null,
    };

    await primeOrigin(page, COMMAND);

    // Geo IDs are checked against the target location's fresh directory before the search
    // is refined, because Avito silently ignores an unknown ID and silently accepts a
    // foreign one. The same-origin directory calls need the page to be on Avito already.
    if (geoMode) {
      await validateGeoSelection(page, requestedLocationId, geoMode, geoIds);
    }
    if (requestedRadius != null) {
      await validateRadiusSelection(page, requestedLocationId, requestedRadius);
    }

    const canonicalUrl = await resolveCanonicalUrl(page, query);

    // Hop two: the canonical catalog document carries searchCore and filtersV2, so
    // it serves both the postconditions and the request the rows come back on.
    const schema = await readDocument(page, {
      requestUrl: canonicalUrl,
      stage: 'schema',
      keep: CATALOG_KEYS,
      schema: CATALOG_DOCUMENT,
      subject: 'Avito SSR search state',
      command: COMMAND,
    });
    const sourceCore = schema.state.searchCore;
    if (!Array.isArray(schema.state.filtersV2?.Sections)) {
      throw new CommandExecutionError('Avito SSR search state carries no filter schema');
    }
    if (Number(sourceCore.page) !== 1) {
      throw new CommandExecutionError('Avito initial search did not resolve to page 1');
    }
    if (!cleanText(sourceCore.locationName)) {
      throw new CommandExecutionError('Avito SSR search state has unsupported effective context');
    }
    const sourceParamEntries = coreParamEntries(sourceCore, 'Avito SSR searchCore');

    const api = await readCatalogPage(
      page,
      buildSearchRequest(schema.state, refinement),
      schema.responseUrl,
      COMMAND,
    );
    const resultCore = api.searchCore;

    assertSearchApplied(sourceCore, resultCore, refinement);
    const driftedParam = preservedParamsDrift(sourceParamEntries, resultCore.params);
    if (driftedParam) {
      throw new CommandExecutionError(`Avito changed preserved params[${driftedParam}]`);
    }

    const searchLocation = cleanText(resultCore.locationName);
    const searchLocationId = Number(resultCore.locationId);
    if (!searchLocation || !Number.isInteger(searchLocationId) || searchLocationId <= 0) {
      throw new CommandExecutionError('Avito SSR searchCore has an invalid effective location');
    }
    if (requestedLocationId != null && String(searchLocationId) !== requestedLocationId) {
      throw new CommandExecutionError(
        `Avito applied location ${searchLocationId} ("${searchLocation}") instead of ${requestedLocationId}`,
      );
    }

    const searchUrl = answeredUrl(api.url, 'search result URL').href;
    const landed = decodeLandedSearch(searchUrl, query);
    if (!landed.accepted) throw landingError(landed.reason);

    const decodedRows = catalogRows(api.catalog);
    if (decodedRows.length === 0) {
      if (resultCount(api) === 0) {
        throw new EmptyResultError(COMMAND, 'No listings match the requested query in this location');
      }
      throw new CommandExecutionError('Avito returned no catalog items with a non-zero result count');
    }

    return listingRows(
      applyReservedFilter(decodedRows, removeReserved, COMMAND),
      searchUrl,
    );
  },
});
