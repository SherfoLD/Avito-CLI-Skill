/**
 * `avito get-location` — the node half, which is all of the decoding.
 *
 * `locationName` always means a city or a region and `geoName` always means a
 * station or a district, in both modes, so a caller never has to know which mode
 * produced a row.
 *
 * Two rules stop a plausible wrong answer:
 *
 * `--geo` needs exactly one *exact* name match among the suggestions. Avito
 * suggests neighbours freely, and taking the first would list the metro of a
 * city nobody asked about while the rows looked perfectly normal.
 *
 * A result larger than `--limit` is refused, never truncated. Moscow has 357
 * stations, and returning 10 with no sign that 347 were dropped is the silent
 * clamp this repository exists to avoid — hence the default of 400 in geo mode.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import {
  AVITO_BASE_URL,
  fetchAvitoJson,
  geoDirectory,
  locationDescriptor,
} from '../site/geo.mjs';
import { readAccessState } from '../decoders/get-location.mjs';

const SUGGEST_LIMIT = 10;
const GEO_LIMIT = 400;
const GEO_MODES = new Set(['metro', 'districts']);

function normalizeLimit(value, maxLimit) {
  if (value === null || value === undefined || value === '') return maxLimit;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ArgumentError('limit must be a positive integer');
  }
  if (limit > maxLimit) {
    throw new ArgumentError(`limit must be <= ${maxLimit}`);
  }
  return limit;
}

function normalizeGeoMode(value) {
  if (value === null || value === undefined || value === '') return null;
  const mode = String(value).trim().toLowerCase();
  if (!GEO_MODES.has(mode)) {
    throw new ArgumentError('geo must be "metro" or "districts"');
  }
  return mode;
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function comparable(value) {
  return cleanText(value).toLocaleLowerCase('ru-RU');
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    throw new TimeoutError(action, 15);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function positiveId(value) {
  return Number.isInteger(value) && value > 0;
}

function decodeSuggestions(payload, query) {
  const rawSuggestions = payload?.result?.locations;
  if (!Array.isArray(rawSuggestions)) {
    throw new CommandExecutionError('Avito locations response has an unexpected shape');
  }
  if (rawSuggestions.length === 0) {
    throw new EmptyResultError('avito get-location', `No locations matched "${query}"`);
  }

  return rawSuggestions.map((entry, index) => {
    const rawId = entry?.id;
    const rawName = entry?.names?.['1'];
    const normalizedName = cleanText(rawName);
    if (!positiveId(rawId) || !normalizedName) {
      throw new CommandExecutionError(
        `Avito locations response contains a malformed row at index ${index}`,
      );
    }
    const parentName = cleanText(entry?.parent?.names?.['1']) || null;
    // The `suggested*` prefix marks these as the decoder's own shape, the way
    // `api*` does in the card decoder: a suggestion is not a row, and it carries
    // one field — the label with its parent region — that no column has.
    return {
      suggestedId: String(rawId),
      suggestedName: normalizedName,
      suggestedLabel: parentName ? `${normalizedName}, ${parentName}` : normalizedName,
    };
  });
}

function resolveExactLocation(suggestions, query) {
  const wanted = comparable(query);
  const exact = suggestions.filter((entry) => comparable(entry.suggestedName) === wanted);
  const visible = suggestions.map((entry) => entry.suggestedLabel).join('; ');

  if (exact.length === 0) {
    throw new ArgumentError(
      `No exact Avito location match for "${cleanText(query)}". Suggestions: ${visible || 'none'}`,
    );
  }
  if (exact.length > 1) {
    const ambiguous = exact.map((entry) => `${entry.suggestedLabel} (${entry.suggestedId})`).join('; ');
    throw new ArgumentError(
      `Avito location "${cleanText(query)}" is ambiguous. Exact matches: ${ambiguous}`,
    );
  }
  return exact[0];
}

function decodeCapabilities(payload, locationId) {
  const descriptor = locationDescriptor(payload, locationId);
  if (typeof descriptor.hasMetro !== 'boolean' || typeof descriptor.hasDistricts !== 'boolean') {
    throw new CommandExecutionError('Avito location capabilities are missing metro/district flags');
  }
  return { hasMetro: descriptor.hasMetro, hasDistricts: descriptor.hasDistricts };
}

// A station belongs to one or more lines, and the line names are the group a caller reads
// to tell two stations of the same name apart.
function decodeMetro(payload) {
  const stations = payload?.stations;
  const lines = payload?.lines;
  if (!Array.isArray(stations) || !Array.isArray(lines)) {
    throw new CommandExecutionError('Avito metro response has an unexpected shape');
  }

  const lineNameById = new Map();
  for (const line of lines) {
    const name = cleanText(line?.name);
    if (!positiveId(line?.id) || !name) {
      throw new CommandExecutionError('Avito metro response contains a malformed line');
    }
    lineNameById.set(line.id, name);
  }

  return stations.map((station, index) => {
    const name = cleanText(station?.name);
    if (!positiveId(station?.id) || !name) {
      throw new CommandExecutionError(
        `Avito metro response contains a malformed station at index ${index}`,
      );
    }
    const lineIds = Array.isArray(station.lineIds) ? station.lineIds : [];
    const groupNames = lineIds
      .map((lineId) => lineNameById.get(lineId))
      .filter((lineName) => typeof lineName === 'string' && lineName);
    return {
      geoId: String(station.id),
      geoName: name,
      geoGroup: groupNames.length ? groupNames.join(', ') : null,
    };
  });
}

// Districts carry their group the other way round: the region lists the districts it holds.
function decodeDistricts(payload) {
  const districts = payload?.districts;
  if (!Array.isArray(districts)) {
    throw new CommandExecutionError('Avito districts response has an unexpected shape');
  }

  const groupNameByDistrictId = new Map();
  const regions = Array.isArray(payload?.regions) ? payload.regions : [];
  for (const region of regions) {
    const groupName = cleanText(region?.shortName) || cleanText(region?.fullName);
    const districtIds = Array.isArray(region?.districtIds) ? region.districtIds : [];
    if (!groupName) continue;
    for (const districtId of districtIds) {
      if (positiveId(districtId)) groupNameByDistrictId.set(districtId, groupName);
    }
  }

  return districts.map((district, index) => {
    const name = cleanText(district?.name);
    if (!positiveId(district?.id) || !name) {
      throw new CommandExecutionError(
        `Avito districts response contains a malformed district at index ${index}`,
      );
    }
    return {
      geoId: String(district.id),
      geoName: name,
      geoGroup: groupNameByDistrictId.get(district.id) ?? null,
    };
  });
}

export default defineCommand({
  name: 'get-location',
  description: 'Resolve a city or region name to the location ID avito search needs, and list the metro and district IDs of that location. Run this before searching in a specific place',
  access: 'read',
  example: 'avito get-location <query> --geo metro --geo-query <text> -f json',
  domain: 'www.avito.ru',
  args: [
    { name: 'query', type: 'string', required: true, positional: true, help: 'City or region name' },
    { name: 'limit', type: 'int', help: 'Maximum rows: 1-10 suggestions, 1-400 geo entries' },
    { name: 'geo', type: 'string', help: 'List geo IDs instead of suggestions: metro or districts' },
    { name: 'geo-query', type: 'string', help: 'Filter geo entries by visible station or district name' },
  ],
  columns: ['rank', 'locationId', 'locationName', 'geoMode', 'geoId', 'geoName', 'geoGroup'],
  run: async (page, args) => {
    const query = cleanText(args.query);
    if (!query) {
      throw new ArgumentError('query must be a non-empty string');
    }
    const geoMode = normalizeGeoMode(args.geo);
    const geoQuery = cleanText(args['geo-query'] ?? args.geoQuery);
    if (!geoMode && geoQuery) {
      throw new ArgumentError('geo-query requires --geo metro or --geo districts');
    }
    const limit = normalizeLimit(args.limit, geoMode ? GEO_LIMIT : SUGGEST_LIMIT);

    // The homepage rather than robots.txt: this command reads directories that are only
    // meaningful for a session Avito is actually serving, and the page it lands on is the
    // one honest place to see a challenge before three reads are made against it.
    try {
      await page.goto(AVITO_BASE_URL, { waitUntil: 'load', settleMs: 500 });
    } catch (error) {
      asExecutionError(error, 'opening Avito');
    }

    const accessState = await page.evaluateWithArgs(readAccessState, {});
    if (accessState?.blocked) {
      throw new CommandExecutionError(
        `Avito requires human verification (${accessState.title || 'access challenge'})`,
      );
    }

    const suggestions = decodeSuggestions(
      await fetchAvitoJson(
        page,
        '/web/1/slocations',
        { limit: geoMode ? SUGGEST_LIMIT : limit, q: query },
        'requesting Avito locations',
      ),
      query,
    );

    if (!geoMode) {
      return suggestions.slice(0, limit).map((entry, index) => ({
        rank: index + 1,
        locationId: entry.suggestedId,
        locationName: entry.suggestedName,
        geoMode: null,
        geoId: null,
        geoName: null,
        geoGroup: null,
      }));
    }

    const location = resolveExactLocation(suggestions, query);

    const capabilities = decodeCapabilities(
      await fetchAvitoJson(
        page,
        '/web/1/search/locations',
        { locationId: location.suggestedId },
        'requesting Avito location capabilities',
      ),
      location.suggestedId,
    );

    const supported = geoMode === 'metro' ? capabilities.hasMetro : capabilities.hasDistricts;
    if (!supported) {
      throw new ArgumentError(
        `Avito location "${location.suggestedLabel}" (${location.suggestedId}) has no ${geoMode}`,
      );
    }

    const payload = await fetchAvitoJson(
      page,
      geoDirectory(geoMode).path,
      { locationId: location.suggestedId },
      `requesting Avito ${geoMode}`,
    );
    const decoded = geoMode === 'metro' ? decodeMetro(payload) : decodeDistricts(payload);

    const wanted = comparable(geoQuery);
    const matched = wanted
      ? decoded.filter((entry) => comparable(entry.geoName).includes(wanted))
      : decoded;

    if (matched.length === 0) {
      throw new EmptyResultError(
        'avito get-location',
        geoQuery
          ? `No ${geoMode} entries in "${location.suggestedName}" matched "${geoQuery}"`
          : `Avito returned no ${geoMode} entries for "${location.suggestedName}"`,
      );
    }
    if (matched.length > limit) {
      throw new ArgumentError(
        `"${location.suggestedName}" has ${matched.length} matching ${geoMode} entries but limit is ${limit}. `
        + 'Narrow the result with --geo-query or raise --limit.',
      );
    }

    const seenIds = new Set();
    for (const entry of matched) {
      if (seenIds.has(entry.geoId)) {
        throw new CommandExecutionError(`Avito ${geoMode} response contains duplicate ID ${entry.geoId}`);
      }
      seenIds.add(entry.geoId);
    }

    return matched.map((entry, index) => ({
      rank: index + 1,
      locationId: location.suggestedId,
      locationName: location.suggestedName,
      geoMode,
      geoId: entry.geoId,
      geoName: entry.geoName,
      geoGroup: entry.geoGroup,
    }));
  },
});
