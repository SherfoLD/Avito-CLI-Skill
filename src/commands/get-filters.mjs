/**
 * `avito get-filters` — the node half, which is nearly all of it.
 *
 * The rule that shapes the file: **a row exists ⇔ `apply-filters` can set the
 * key.** Everything `filtersV2` carries for Avito's own rendering — section
 * codes, attrIds, nesting, API type names, suggest and form flags, hidden route
 * constraints — is resolved here and never reaches the caller (D-037).
 *
 * Dropping the inapplicable is not tolerance for drift. What *is* returned is
 * decoded strictly: an option with no value, a filter with no stable name, an
 * undecoded API type and one value under two names all stop the run.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { text, z } from '../runtime/schema.mjs';
import { filterOptions, flattenFilters } from '../browser/prelude/filters.mjs';
import { readFilterState } from '../browser/commands/get-filters.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
// What a caller may write as the value of a key. `valueSyntaxFor` returns one
// of these or `null` for "not applicable", and the `valueSyntax` column accepts
// exactly these.
const SYNTAX = Object.freeze({
  ON: '1',
  VALUE: '<value>',
  VALUES: '<value>[,<value>]',
  TEXT: '<text>[,<text>]',
  RANGE: '<from>..<to>',
});
const VALUE_SYNTAX = z.enum(Object.values(SYNTAX));

const SHORT_KEYS = Object.freeze({
  price: {
    valueSyntax: SYNTAX.RANGE,
    // Short keys read from searchCore: their filtersV2.currentValue is stale or missing even
    // when the server URL proves the value applied. Both carriers ship in the same
    // bootstrap, so the authoritative one is free (F-032).
    currentValue: (core) => rangeOrNull(core.priceMin, core.priceMax),
  },
  user: { valueSyntax: SYNTAX.VALUE, currentValue: (core) => selectionOrNull(core.owner, '0') },
  d: { valueSyntax: SYNTAX.VALUE, currentValue: (core) => selectionOrNull(core.withDeliveryOnly, '0') },
  localPriority: { valueSyntax: SYNTAX.ON, currentValue: (core) => selectionOrNull(core.localPriority, '0') },
  sort: { valueSyntax: SYNTAX.VALUE, currentValue: (core) => selectionOrNull(core.sort) },
});
// A type missing from this map stops the command: it reports that the map is behind Avito,
// which is not a fact about any filter. The three non-obvious entries:
//   slider              a range, not an enum — its ends are option IDs and it carries the
//                       same `inputs` block as numericRange (F-060)
//   bannerCheckBoxWith… a checkbox with a picture: no vocabulary, sends `1` (F-062)
//   garageEntrypoint    holds no value at all; it opens Avito's car picker, which fills the
//                       three ordinary filters it names in `displaying.carInfmParams`. Its
//                       `entrypoint` normalization never yields a syntax (F-066)
const API_TYPE_TO_NORMALIZED = new Map([
  ['bannerCheckBoxWithImage', 'boolean'],
  ['boolean', 'boolean'],
  ['checkboxGroup', 'multi_enum'],
  ['garageEntrypoint', 'entrypoint'],
  ['hidden', 'hidden'],
  ['keywords', 'text'],
  ['multiselect', 'multi_enum'],
  ['numericRange', 'range'],
  ['radioGroup', 'enum'],
  ['sectionedMultiselect', 'multi_enum'],
  ['select', 'enum'],
  ['slider', 'range'],
]);
// What Avito answers for a bound nobody set. A bound of zero is therefore indistinguishable
// from an unset one, and does not need to be — zero is where an unrestricted range starts.
const EMPTY_RANGE_BOUNDS = new Set(['', '0']);
const FILTER_KEY_PATTERN = /^(?:params\[\d+\]|[A-Za-z][A-Za-z0-9]{0,80})$/;
const MAX_FILTERS = 400;
// Implausibility guards, not a policy on size — trimming a vocabulary would be the silent
// clamp this command exists to avoid. Truck parts name 12150 manufacturers in one
// `multiselect`, all unique and well formed (F-067).
const MAX_OPTIONS_PER_FILTER = 20000;
const MAX_TOTAL_OPTIONS = 40000;
const MAX_LABEL_LENGTH = 300;
const MAX_OPTION_VALUE_LENGTH = 300;
const MAX_CURRENT_VALUE_LENGTH = 2000;

function normalizeCatalogUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('url must be a non-empty Avito catalog or search URL');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError('url must be a valid absolute URL');
  }

  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new ArgumentError('url must use https://www.avito.ru');
  }

  parsed.protocol = 'https:';
  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed.toString();
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function scalarOrNull(value, source) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new CommandExecutionError(`Avito ${source} carries a non-scalar value`);
}

// Avito answers `0` for a short-key switch nobody touched. That resting value is not a
// selection and is not among the key's options, so it reads as nothing applied. `sort` has
// no such value — its "по умолчанию" is an ordinary Avito option and stays visible (D-032).
function selectionOrNull(value, restingValue = null) {
  const scalar = scalarOrNull(value, 'searchCore');
  return scalar === null || scalar === restingValue ? null : scalar;
}

function rangeOrNull(from, to) {
  const low = scalarOrNull(from, 'searchCore');
  const high = scalarOrNull(to, 'searchCore');
  if (low === null && high === null) return null;
  return `${low ?? ''}..${high ?? ''}`;
}

// Derived from what `apply-filters` serializes, not from the filter type alone. `null` here
// means the key cannot be applied, so it is not a row at all.
//
// Both ranges share `<from>..<to>`; the `options` column is what separates them — empty
// means the bound is a plain number, non-empty means it is one of those option values
// (F-063). A keyword field also has no vocabulary, so its syntax says so (F-064).
function valueSyntaxFor(filterKey, normalizedType, optionCount) {
  if (Object.hasOwn(SHORT_KEYS, filterKey)) return SHORT_KEYS[filterKey].valueSyntax;
  if (!/^params\[\d+\]$/.test(filterKey)) return null;
  if (normalizedType === 'entrypoint') return null;
  if (normalizedType === 'range') return SYNTAX.RANGE;
  if (normalizedType === 'text') return SYNTAX.TEXT;
  if (normalizedType === 'boolean' && optionCount === 0) return SYNTAX.ON;
  if (optionCount === 0) return null;
  if (normalizedType === 'multi_enum') return SYNTAX.VALUES;
  if (normalizedType === 'enum' || normalizedType === 'boolean') return SYNTAX.VALUE;
  return null;
}

function cleanLabel(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Both carriers of a range arrive as `{from, to}`, written here the way `--set` takes it.
function appliedRangeValue(rawValue, key) {
  if (rawValue == null) return null;
  if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  const unknownSides = Object.keys(rawValue).filter((side) => side !== 'from' && side !== 'to');
  if (unknownSides.length > 0) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  const bound = (value) => {
    const scalar = scalarOrNull(value, `filter ${key}`);
    return scalar === null || EMPTY_RANGE_BOUNDS.has(scalar) ? null : scalar;
  };
  const from = bound(rawValue.from);
  const to = bound(rawValue.to);
  if (from === null && to === null) return null;
  if (from !== null && from.length > MAX_OPTION_VALUE_LENGTH) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  if (to !== null && to.length > MAX_OPTION_VALUE_LENGTH) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  return `${from ?? ''}..${to ?? ''}`;
}

// An empty selection means the filter is free, not that it carries an empty value.
function appliedParamsValue(rawValue, key) {
  const rawValues = rawValue == null ? [] : (Array.isArray(rawValue) ? rawValue : [rawValue]);
  if (rawValues.length > MAX_OPTIONS_PER_FILTER) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  const applied = rawValues
    .map((value) => scalarOrNull(value, `filter ${key}`))
    .filter((value) => value !== null);
  if (applied.some((value) => value.length > MAX_OPTION_VALUE_LENGTH)) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  if (applied.length === 0) return null;
  const serialized = applied.join(',');
  if (serialized.length > MAX_CURRENT_VALUE_LENGTH) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  return serialized;
}

// `filterOptions` resolves Avito's grouping and returns `null` when the flat and sectioned
// forms are mixed. The ceilings stay here: "implausible" is this command's judgement.
function optionsOf(rawFilter, key) {
  const declaredValues = rawFilter.values == null ? [] : rawFilter.values;
  if (!Array.isArray(declaredValues) || declaredValues.length > MAX_OPTIONS_PER_FILTER) {
    throw new CommandExecutionError(`Avito filter ${key} has malformed or implausible values`);
  }
  const flattened = filterOptions(rawFilter);
  if (flattened === null) {
    throw new CommandExecutionError(`Avito filter ${key} mixes sectioned and flat values`);
  }
  if (flattened.length > MAX_OPTIONS_PER_FILTER) {
    throw new CommandExecutionError(`Avito filter ${key} has malformed or implausible values`);
  }
  return flattened;
}

function normalizeOption(rawOption, key) {
  if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) {
    throw new CommandExecutionError(`Avito filter ${key} contains a malformed option`);
  }
  const optionName = cleanLabel(rawOption.name ?? rawOption.title);
  const rawValue = rawOption.value ?? rawOption.id;
  const optionValue = rawValue == null ? '' : String(rawValue);
  if (
    !optionName
    || optionName.length > MAX_LABEL_LENGTH
    || !optionValue
    || optionValue.length > MAX_OPTION_VALUE_LENGTH
  ) {
    throw new CommandExecutionError(`Avito filter ${key} contains a malformed option`);
  }
  return { optionValue, optionName };
}

export default defineCommand({
  name: 'get-filters',
  description: 'Get every filter you can apply to a search URL, with the values it accepts and what is already applied to this URL. Pass key and value straight into avito apply-filters',
  access: 'read',
  example: 'avito get-filters <searchUrl> -f json',
  domain: 'www.avito.ru',
  args: [
    { name: 'searchUrl', type: 'string', required: true, positional: true, help: 'Search URL from avito search, apply-filters, move-category or get-page' },
  ],
  // A row exists if and only if `apply-filters` can set the key, so `key` and
  // `valueSyntax` are never null: a filter that cannot be applied is not a row.
  // `options` is empty for a range with plain numeric bounds and for a keyword
  // field, which is what separates those from an enum (F-063, F-064).
  row: z.strictObject({
    key: z.string().regex(FILTER_KEY_PATTERN, 'must be params[<attrId>] or a short key'),
    name: text().max(MAX_LABEL_LENGTH),
    unit: text().max(MAX_LABEL_LENGTH).nullable(),
    valueSyntax: VALUE_SYNTAX,
    currentValue: text().max(MAX_CURRENT_VALUE_LENGTH).nullable(),
    options: z.record(text().max(MAX_OPTION_VALUE_LENGTH), text().max(MAX_LABEL_LENGTH)),
  }),
  run: async (page, args) => {
    const requestedUrl = normalizeCatalogUrl(args.searchUrl);

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito same-origin context');
    }

    let observed;
    try {
      observed = await page.evaluateWithArgs(readFilterState, { requestUrl: requestedUrl });
    } catch (error) {
      asExecutionError(error, 'fetching Avito SSR filter state');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito SSR filter request returned an invalid result');
    }
    if (observed.success !== true) {
      const message = String(observed.message || 'Avito SSR filter request failed');
      if (observed.code === 'access') {
        throw new CommandExecutionError(`Avito requires human verification (${message})`);
      }
      if (observed.code === 'http') {
        throw new CommandExecutionError(`Avito SSR filter request returned HTTP ${observed.details?.status || 0}`);
      }
      if (observed.code === 'content_type') {
        throw new CommandExecutionError(
          `Avito SSR filter request returned ${observed.details?.contentType || 'an unknown content type'}`,
        );
      }
      if (observed.code === 'parse') {
        throw new CommandExecutionError('Avito SSR bootstrap JSON is malformed');
      }
      if (observed.code === 'missing') {
        throw new EmptyResultError('avito get-filters', 'This Avito page has no SSR filter schema');
      }
      if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
        throw new TimeoutError('Avito SSR filter request', 20);
      }
      throw new CommandExecutionError(`${observed.stage || 'Avito get-filters'} failed: ${message}`);
    }

    if (!observed.searchCore || typeof observed.searchCore !== 'object') {
      throw new CommandExecutionError('Avito SSR filter state has no valid searchCore');
    }

    const sections = observed.filtersV2?.Sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new EmptyResultError('avito get-filters', 'This Avito page has no filtersV2 sections');
    }

    // The walk is the shared one: what a well-formed filter tree is does not differ between
    // the command that reads it and the three that only refuse a malformed one. A nested
    // filter belongs to the caller as much as a top-level one, and its parent may well be a
    // constraint this command skips, so flattening happens before anything is judged.
    let rawFilters;
    try {
      rawFilters = flattenFilters(sections, MAX_FILTERS);
    } catch (error) {
      throw new CommandExecutionError(`Avito filtersV2 is malformed: ${error.message}`);
    }

    const searchCore = observed.searchCore;
    const rows = [];
    const seenKeys = new Set();
    let totalOptionCount = 0;

    for (const rawFilter of rawFilters) {
      const filterKey = cleanLabel(rawFilter.id);
      const apiType = cleanLabel(rawFilter.type);
      const normalizedType = API_TYPE_TO_NORMALIZED.get(apiType);
      if (!FILTER_KEY_PATTERN.test(filterKey) || !normalizedType) {
        throw new CommandExecutionError(`Avito filter schema contains unsupported key/type ${filterKey || '<empty>'}/${apiType || '<empty>'}`);
      }

      const rawValues = optionsOf(rawFilter, filterKey);

      // Everything below this line is only reached by a filter the caller can apply.
      const valueSyntax = valueSyntaxFor(filterKey, normalizedType, rawValues.length);
      if (valueSyntax === null) continue;

      if (seenKeys.has(filterKey)) {
        throw new CommandExecutionError(`Avito filter schema contains duplicate key ${filterKey}`);
      }
      seenKeys.add(filterKey);

      // Avito repeats an option in more than one group of the same control — every brand
      // in "Популярные" is in "Все" as well — so a repeat of the same option is one
      // option, not two. The same value under two different names is the opposite: two
      // meanings behind one value the caller would pass back, and it stops the command.
      const options = [];
      const seenOptionValues = new Map();
      for (const rawOption of rawValues) {
        const option = normalizeOption(rawOption, filterKey);
        const seenName = seenOptionValues.get(option.optionValue);
        if (seenName === undefined) {
          seenOptionValues.set(option.optionValue, option.optionName);
          options.push(option);
        } else if (seenName !== option.optionName) {
          throw new CommandExecutionError(`Avito filter ${filterKey} gives option value ${option.optionValue} two different names`);
        }
      }
      totalOptionCount += options.length;
      if (totalOptionCount > MAX_TOTAL_OPTIONS) {
        throw new CommandExecutionError(`Avito filter schema exceeds maximum option count ${MAX_TOTAL_OPTIONS}`);
      }

      const filterName = cleanLabel(rawFilter.defaultTitle)
        || (options.length === 1 ? options[0].optionName : '');
      if (!filterName || filterName.length > MAX_LABEL_LENGTH) {
        throw new CommandExecutionError(`Avito filter ${filterKey} has no stable name`);
      }

      const shortKey = SHORT_KEYS[filterKey];
      rows.push({
        key: filterKey,
        name: filterName,
        unit: cleanLabel(rawFilter.dimension) || null,
        valueSyntax,
        currentValue: shortKey
          ? shortKey.currentValue(searchCore)
          : (normalizedType === 'range'
            ? appliedRangeValue(rawFilter.currentValue, filterKey)
            : appliedParamsValue(rawFilter.currentValue, filterKey)),
        options: Object.fromEntries(options.map((option) => [option.optionValue, option.optionName])),
      });
    }

    if (rows.length === 0) {
      throw new EmptyResultError('avito get-filters', 'This Avito route has no filter this command can apply');
    }
    return rows;
  },
});
