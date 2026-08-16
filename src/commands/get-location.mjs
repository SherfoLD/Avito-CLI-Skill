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
  decode,
  idString,
  optionalText,
  rank,
  requiredText,
  text,
  z,
} from '../runtime/schema.mjs';
import {
  AVITO_BASE_URL,
  fetchAvitoJson,
  geoDirectory,
  locationDescriptor,
} from '../site/geo.mjs';
import { readAccessState } from '../browser/commands/get-location.mjs';

const SUGGEST_LIMIT = 10;
const GEO_LIMIT = 400;
// The two tabs of Avito's geo filter. The argument, the column and the
// directory call all read this one enum.
const GEO_MODE = z.enum(['metro', 'districts']);

/** An Avito directory ID as it arrives: a positive integer, before we stringify it. */
const DIRECTORY_ID = z.number().int().positive();

/**
 * `/web/1/slocations`. `names['1']` is Avito's own name-form index; the parent
 * region is what separates two cities of the same name, so it is read but never
 * required — a top-level region has no parent.
 */
const SUGGESTIONS_PAYLOAD = z.object({
  result: z.object({
    locations: z.array(z.object({
      id: DIRECTORY_ID,
      names: z.object({ 1: requiredText() }),
      parent: z.object({ names: z.object({ 1: optionalText() }).optional() }).nullish(),
    })),
  }),
});

/** `/web/2/locations/metro`. A station belongs to one or more named lines. */
const METRO_PAYLOAD = z.object({
  lines: z.array(z.object({ id: DIRECTORY_ID, name: requiredText() })),
  stations: z.array(z.object({
    id: DIRECTORY_ID,
    name: requiredText(),
    lineIds: z.array(DIRECTORY_ID).default([]),
  })),
});

/** `/web/2/locations/districts`. Districts carry their group the other way round. */
const DISTRICTS_PAYLOAD = z.object({
  districts: z.array(z.object({ id: DIRECTORY_ID, name: requiredText() })),
  regions: z.array(z.object({
    shortName: optionalText(),
    fullName: optionalText(),
    districtIds: z.array(DIRECTORY_ID).default([]),
  })).default([]),
});

/** What `search` and this command both need a location to tell them about itself. */
const CAPABILITIES = z.object({ hasMetro: z.boolean(), hasDistricts: z.boolean() });

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
  const mode = GEO_MODE.safeParse(String(value).trim().toLowerCase());
  if (!mode.success) {
    throw new ArgumentError(`geo must be ${GEO_MODE.options.map((option) => `"${option}"`).join(' or ')}`);
  }
  return mode.data;
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

function decodeSuggestions(payload, query) {
  const { result } = decode(SUGGESTIONS_PAYLOAD, payload, 'Avito locations response');
  if (result.locations.length === 0) {
    throw new EmptyResultError('avito get-location', `No locations matched "${query}"`);
  }

  // The `suggested*` prefix marks these as the decoder's own shape, the way
  // `api*` does in the card decoder: a suggestion is not a row, and it carries
  // one field — the label with its parent region — that no column has.
  return result.locations.map((entry) => {
    const name = entry.names[1];
    const parentName = entry.parent?.names?.[1] ?? null;
    return {
      suggestedId: String(entry.id),
      suggestedName: name,
      suggestedLabel: parentName ? `${name}, ${parentName}` : name,
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
  return decode(
    CAPABILITIES,
    locationDescriptor(payload, locationId),
    'Avito location capabilities',
  );
}

// A station belongs to one or more lines, and the line names are the group a caller reads
// to tell two stations of the same name apart.
function decodeMetro(payload) {
  const { lines, stations } = decode(METRO_PAYLOAD, payload, 'Avito metro response');
  const lineNameById = new Map(lines.map((line) => [line.id, line.name]));

  return stations.map((station) => {
    const groupNames = station.lineIds
      .map((lineId) => lineNameById.get(lineId))
      .filter(Boolean);
    return {
      geoId: String(station.id),
      geoName: station.name,
      geoGroup: groupNames.length ? groupNames.join(', ') : null,
    };
  });
}

// Districts carry their group the other way round: the region lists the districts it holds.
function decodeDistricts(payload) {
  const { districts, regions } = decode(DISTRICTS_PAYLOAD, payload, 'Avito districts response');

  const groupNameByDistrictId = new Map();
  for (const region of regions) {
    const groupName = region.shortName ?? region.fullName;
    if (!groupName) continue;
    for (const districtId of region.districtIds) {
      groupNameByDistrictId.set(districtId, groupName);
    }
  }

  return districts.map((district) => ({
    geoId: String(district.id),
    geoName: district.name,
    geoGroup: groupNameByDistrictId.get(district.id) ?? null,
  }));
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
  // `locationName` always means a city or a region and `geoName` always means a
  // station or a district, in both modes. In suggestion mode the four geo
  // columns are null together; in geo mode none of them is.
  row: z.strictObject({
    rank: rank(),
    locationId: idString(),
    locationName: text(),
    geoMode: GEO_MODE.nullable(),
    geoId: idString().nullable(),
    geoName: text().nullable(),
    geoGroup: text().nullable(),
  }),
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
