/**
 * `avito get-filters` — the node half, which is nearly all of it.
 *
 * The rule that shapes the file: **a filter is returned ⇔ `apply-filters` can set the
 * key.** Everything `filtersV2` carries for Avito's own rendering — section
 * codes, attrIds, nesting, API type names, suggest flags, hidden route
 * constraints — is resolved here and never reaches the caller (D-037). The one
 * flag that survives is `updatesForm`, because it is not about rendering: it is
 * the only warning that this answer is incomplete for the state the caller is
 * about to create (D-078).
 *
 * Dropping the inapplicable is not tolerance for drift. What *is* returned is
 * decoded strictly: an option with no value, a filter with no stable name, an
 * undecoded API type and one value under two names all stop the run.
 */

import {
  CommandExecutionError,
  EmptyResultError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { searchUrl, text, z } from '../runtime/schema.mjs';
import { FILTER_STATE } from '../schemas/filters.mjs';
import { filterOptions, flattenFilters } from '../site/filters.mjs';
import { primeOrigin, readDocument } from '../site/carriers.mjs';
import { answeredUrl, requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito get-filters';
// What a caller may write as the value of a key. `valueSyntaxFor` returns one
// of these or `null` for "not applicable", and the `valueSyntax` field accepts
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
// Implausibility guards, not a policy on size — trimming a vocabulary would be the silent
// clamp this command exists to avoid. Truck parts name 12150 manufacturers in one
// `multiselect`, all unique and well formed (F-067).
const MAX_OPTIONS_PER_FILTER = 20000;
const MAX_TOTAL_OPTIONS = 40000;
const MAX_LABEL_LENGTH = 300;
const MAX_OPTION_VALUE_LENGTH = 300;
const MAX_CURRENT_VALUE_LENGTH = 2000;

// `String({})` is `[object Object]`, which is non-empty and passes every check
// downstream, so a structure where a value belongs stops the call instead of
// being returned (src/runtime/schema.mjs). It reaches here from a filter whose
// type says list and whose currentValue is a range — the schema allows both,
// because on a range filter that object is the answer.
function scalarOrNull(value, subject = 'Avito filter schema') {
  if (value == null || value === '') return null;
  if (typeof value === 'object') {
    throw new CommandExecutionError(`${subject} carries a non-scalar value`);
  }
  return String(value);
}

// Avito answers `0` for a short-key switch nobody touched. That resting value is not a
// selection and is not among the key's options, so it reads as nothing applied. `sort` has
// no such value — its "по умолчанию" is an ordinary Avito option and stays visible (D-032).
function selectionOrNull(value, restingValue = null) {
  const scalar = scalarOrNull(value);
  return scalar === null || scalar === restingValue ? null : scalar;
}

function rangeOrNull(from, to) {
  const low = scalarOrNull(from);
  const high = scalarOrNull(to);
  if (low === null && high === null) return null;
  return `${low ?? ''}..${high ?? ''}`;
}

// Derived from what `apply-filters` serializes, not from the filter type alone. `null` here
// means the key cannot be applied, so it is not returned at all.
//
// Both ranges share `<from>..<to>`; the `options` field is what separates them — empty
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
// A range filter answering with a bare value instead is the one drift left for this
// function: `RANGE_VALUE` proved the object, not that the filter sent one.
function appliedRangeValue(rawValue, key) {
  if (rawValue == null) return null;
  if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    throw new CommandExecutionError(`Avito filter ${key} has an implausible currentValue`);
  }
  const bound = (value) => {
    const scalar = scalarOrNull(value, `Avito filter ${key}`);
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
    .map((entry) => scalarOrNull(entry, `Avito filter ${key}`))
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
  const declaredValues = rawFilter.values ?? [];
  if (declaredValues.length > MAX_OPTIONS_PER_FILTER) {
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

/**
 * A filter is here if and only if `apply-filters` can set the key, so `key` and
 * `valueSyntax` are never null: a filter that cannot be applied is not returned.
 * `options` is empty for a range with plain numeric bounds and for a keyword
 * field, which is what separates those from an enum (F-063, F-064).
 *
 * `changesFiltersOnSelect` is the one field that is not about this filter's own
 * value: it says the *set* of filters may be different once this one carries a
 * value, so the answer holding it is a snapshot of one state and not of the
 * route (F-097).
 */
const OUTPUT = z.strictObject({
  searchUrl: searchUrl(),
  filters: z.array(z.strictObject({
    key: z.string().regex(FILTER_KEY_PATTERN, 'must be params[<attrId>] or a short key'),
    name: text().max(MAX_LABEL_LENGTH),
    unit: text().max(MAX_LABEL_LENGTH).nullable(),
    valueSyntax: VALUE_SYNTAX,
    currentValue: text().max(MAX_CURRENT_VALUE_LENGTH).nullable(),
    changesFiltersOnSelect: z.boolean(),
    options: z.record(text().max(MAX_OPTION_VALUE_LENGTH), text().max(MAX_LABEL_LENGTH)),
  })),
});

const OUTPUT_TYPE = `type Output = {
  searchUrl: string;       // the URL these filters belong to; they change with the category
  filters: Filter[];       // every filter apply-filters can set here, and nothing else
};

type Filter = {
  key: string;             // params[<attrId>] or a short key — pass it verbatim to apply-filters
  name: string;
  unit: string | null;     // «₽», «км»
  valueSyntax: "<value>" | "<value>[,<value>]" | "<text>[,<text>]" | "<from>..<to>" | "1";
  currentValue: string | null;  // what is applied to this URL now; null means nothing is
  // true: applying a value here rebuilds the form — another filter may appear, vanish or
  // change its options, so re-read get-filters afterwards to see the new set
  changesFiltersOnSelect: boolean;
  options: Record<string, string>;  // value → visible name; empty means a free numeric range
};`;

export default defineCommand({
  name: 'get-filters',
  description: 'Get every filter you can apply to a search URL, with the values it accepts and what is already applied to this URL. Pass key and value straight into avito apply-filters',
  access: 'read',
  example: 'avito get-filters <searchUrl>',
  domain: 'www.avito.ru',
  args: [
    { name: 'searchUrl', type: 'string', required: true, positional: true, help: 'Search URL from avito search, apply-filters, move-category or get-page' },
  ],
  output: OUTPUT,
  type: OUTPUT_TYPE,
  run: async (page, args) => {
    const requestedUrl = requestedSearchUrl(args.searchUrl);

    await primeOrigin(page, COMMAND);
    const { state, responseUrl } = await readDocument(page, {
      requestUrl: requestedUrl,
      stage: 'schema',
      keep: ['url', 'searchCore', 'filtersV2'],
      schema: FILTER_STATE,
      subject: 'Avito SSR filter state',
      command: COMMAND,
    });

    const sections = state.filtersV2?.Sections ?? [];
    if (sections.length === 0) {
      throw new EmptyResultError(COMMAND, 'This Avito page has no filtersV2 sections');
    }

    // A nested filter belongs to the caller as much as a top-level one, and its
    // parent may well be a constraint this command skips, so flattening happens
    // before anything is judged.
    const rawFilters = flattenFilters(sections);

    const searchCore = state.searchCore;
    const filters = [];
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
      filters.push({
        key: filterKey,
        name: filterName,
        unit: cleanLabel(rawFilter.dimension) || null,
        valueSyntax,
        currentValue: shortKey
          ? shortKey.currentValue(searchCore)
          : (normalizedType === 'range'
            ? appliedRangeValue(rawFilter.currentValue, filterKey)
            : appliedParamsValue(rawFilter.currentValue, filterKey)),
        // Avito's `updatesForm`, renamed to what it does for the caller. Absent is the
        // ordinary case and means no: most filters narrow the listing and leave the form
        // alone (D-078).
        changesFiltersOnSelect: rawFilter.updatesForm === true,
        options: Object.fromEntries(options.map((option) => [option.optionValue, option.optionName])),
      });
    }

    if (filters.length === 0) {
      throw new EmptyResultError(COMMAND, 'This Avito route has no filter this command can apply');
    }
    return {
      searchUrl: answeredUrl(responseUrl, 'Avito filter state URL', requestedUrl).href,
      filters,
    };
  },
});
