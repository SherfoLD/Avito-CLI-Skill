/**
 * `avito search` — the node half: argument validation, the navigation budget,
 * the directory calls that check a geo selection *before* Avito can silently
 * ignore it, and the guards on whatever the browser half returned.
 *
 * The order matters. Avito accepts geo values it does not apply, so a check made
 * after the search would be checking the wrong thing (F-037).
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { searchContext } from '../browser/commands/search.mjs';
import { LISTING_ROW, applyReservedFilter, listingRows } from '../site/listing.mjs';
import {
  AVITO_BASE_URL,
  capabilityParameter,
  fetchAvitoJson,
  geoDirectory,
  locationDescriptor,
  locationDisplayName,
} from '../site/geo.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const MAX_GEO_VALUES = 50;
const MAX_PARAMS = 400;
const MAX_PARAM_VALUES = 2000;
// Backoff before the single bootstrap-recovery retry, so a missing schema is not asked
// for again in the same instant. This is not a courtesy gap between normal requests.
const RECOVERY_BACKOFF_SECONDS = 2;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

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

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    throw new TimeoutError(action, 15);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function normalizeSearchUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new CommandExecutionError('Avito returned an invalid search result URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.avito.ru') {
    throw new CommandExecutionError('Avito returned a search result URL outside www.avito.ru');
  }
  parsed.hash = '';
  return parsed.href;
}

// Avito answers `https://www.avito.ru/?q=<query>` from the bare origin, keeps the session
// region and reports the canonical target itself, so the search is one deterministic
// navigation instead of a visible form submit.
export function buildQueryUrl(query) {
  const requestUrl = new URL('/', AVITO_BASE_URL);
  requestUrl.searchParams.set('q', query);
  return requestUrl.href;
}

// Avito canonicalizes every `?q=` request into a category route and keeps `q` only for
// part of them: `ddr5 32gb` stays a text search, while `iphone` is absorbed into the Apple
// category and `iphone 13 pro max 256` into a model route with an opaque structured filter.
// An absorbed query is a real Avito answer, so it is accepted; a preserved `q` must still
// be exactly the requested one, and the bare homepage is never a search result.
export function decodeLandedSearch(href, query) {
  const landed = new URL(normalizeSearchUrl(href));
  const landedQuery = landed.searchParams.get('q');
  if (landedQuery != null && cleanText(landedQuery) !== cleanText(query)) {
    return { accepted: false, reason: 'query' };
  }
  if (landed.pathname === '/') {
    return { accepted: false, reason: 'homepage' };
  }
  return { accepted: true, landedUrl: landed.href, queryPreserved: landedQuery != null };
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

async function resolveSearchContext(
  page,
  queryUrl,
  query,
  refinement,
  allowSchemaRecovery = true,
) {
  let observed;
  try {
    observed = await page.evaluateWithArgs(searchContext, {
      queryUrl,
      query,
      refinement,
      MAX_PARAMS,
      MAX_PARAM_VALUES,
      forceFreshSchema: !allowSchemaRecovery,
    });
  } catch (error) {
    asExecutionError(error, 'resolving the Avito search context');
  }

  if (!observed || typeof observed !== 'object') {
    throw new CommandExecutionError('Avito search context returned an invalid result');
  }
  if (observed.success !== true) {
    const message = String(observed.message || 'Avito search context resolution failed');
    if (
      allowSchemaRecovery
      && observed.stage === 'schema'
      && observed.code === 'missing'
    ) {
      try {
        await page.wait(RECOVERY_BACKOFF_SECONDS);
      } catch (error) {
        asExecutionError(error, 'waiting for Avito short-key bootstrap recovery');
      }
      return resolveSearchContext(page, queryUrl, query, refinement, false);
    }
    if (observed.code === 'argument') {
      throw new ArgumentError(message);
    }
    if (observed.code === 'empty') {
      throw new EmptyResultError('avito search', message);
    }
    if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
      throw new TimeoutError(`Avito search ${observed.stage || 'request'}`, 20);
    }
    if (observed.code === 'access') {
      throw new CommandExecutionError(`Avito requires human verification or a rate-limit cooldown (${message})`);
    }
    throw new CommandExecutionError(`${observed.stage || 'Avito search'} failed: ${message}`);
  }

  return observed;
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
      apply: requestedLocationId != null || geoMode != null || requestedRadius != null,
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

    const queryUrl = buildQueryUrl(query);

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito same-origin search context');
    }

    // Geo IDs are checked against the target location's fresh directory before the search
    // is refined, because Avito silently ignores an unknown ID and silently accepts a
    // foreign one. The same-origin directory calls need the page to be on Avito already.
    if (geoMode) {
      await validateGeoSelection(page, requestedLocationId, geoMode, geoIds);
    }
    if (requestedRadius != null) {
      await validateRadiusSelection(page, requestedLocationId, requestedRadius);
    }

    const observedContext = await resolveSearchContext(
      page,
      queryUrl,
      query,
      refinement,
      true,
    );
    const searchLocation = cleanText(observedContext.resultSearchLocation);
    const searchLocationId = Number(observedContext.contextLocationId);
    if (
      !searchLocation
      || observedContext.contextLocationId == null
      || !Number.isInteger(searchLocationId)
      || searchLocationId <= 0
    ) {
      throw new CommandExecutionError('Avito SSR searchCore has an invalid effective location');
    }
    if (requestedLocationId != null && String(searchLocationId) !== requestedLocationId) {
      throw new CommandExecutionError(
        `Avito applied location ${searchLocationId} ("${searchLocation}") instead of ${requestedLocationId}`,
      );
    }
    if (Number(observedContext.contextPage) !== 1) {
      throw new CommandExecutionError(`Avito search unexpectedly resolved to page ${observedContext.contextPage}`);
    }

    const searchUrl = normalizeSearchUrl(observedContext.resultSearchUrl);
    const landed = decodeLandedSearch(searchUrl, query);
    if (!landed.accepted) {
      throw new CommandExecutionError(
        landed.reason === 'query'
          ? 'Avito answered with a different query than the requested one'
          : 'Avito did not canonicalize the requested query into a search URL',
      );
    }
    if (!Array.isArray(observedContext.resultRows) || observedContext.resultRows.length === 0) {
      throw new CommandExecutionError('Avito search returned no decoded rows');
    }

    const resultRows = applyReservedFilter(observedContext.resultRows, removeReserved, 'avito search');

    return listingRows(resultRows, searchUrl);
  },
});
