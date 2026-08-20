/**
 * `avito apply-filters` — apply filters to a search URL and return the page.
 *
 * The `--set` grammar exists because chaining cannot express what Avito accepts:
 * a second call for the same key replaces the earlier selection rather than
 * adding to it, so several values and several filters must travel in one call
 * (F-050, D-030). The parser is fail-closed because a malformed entry that got
 * through would not fail — it would reach Avito as a different request and come
 * back as a perfectly ordinary page of listings.
 *
 * Avito also accepts a filter it does not apply: an unknown key is echoed back
 * in `searchCore.params` with an empty `currentValue`, a value from another
 * category is dropped in silence, and both return a full page that answers a
 * different question. Nothing in the listings shows it.
 *
 * So every selection is checked twice, and the checks are not redundant. The
 * first refuses, by name, a key or value the caller could never have seen,
 * against the fresh schema of this very URL and before a request exists (D-031).
 * The second refuses an answer where Avito took the request and did something
 * else with it.
 */

import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { CATALOG_DOCUMENT } from '../schemas/document.mjs';
import {
  LISTING_ITEM,
  LISTING_ITEM_TYPE,
  LISTING_SUMMARY,
  LISTING_SUMMARY_TYPE,
  listingAnswer,
} from '../site/listing.mjs';
import { catalogItems } from '../site/card.mjs';
import {
  CATALOG_KEYS,
  primeOrigin,
  readCatalogPage,
  readDocument,
  resultCount,
} from '../site/carriers.mjs';
import {
  carrySearchCore,
  coreParamEntries,
  itemsApiUrl,
  preservedCoreDrift,
  preservedParamsDrift,
  sealItemsApiUrl,
} from '../site/items.mjs';
import { idString, searchUrl as searchUrlField, text, z } from '../runtime/schema.mjs';
import { filterOptions, flattenFilters } from '../site/filters.mjs';
import {
  addScalar,
  cleanText,
  isCleared,
  sameRange,
  sameValues,
} from '../site/text.mjs';
import { answeredUrl, requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito apply-filters';
const PARAM_KEY_PATTERN = /^params\[(\d+)\]$/;
const RANGE_PATTERN = /^(\d*)\.\.(\d*)$/;
const MAX_SELECTION_VALUE_LENGTH = 300;
const MAX_SELECTION_VALUES = 50;
const MAX_SELECTIONS = 50;

// Avito accepts several words in one keyword field exactly as it accepts several
// options of one enum, and carries them back in the same list (F-064).
const MULTI_VALUE_TYPES = new Set(['checkboxGroup', 'keywords', 'multiselect', 'sectionedMultiselect']);
// Two ranges: numericRange takes plain numbers, slider takes the option values of
// its own two dropdowns. Both serialize into the pair of keys Avito declares in
// their inputs block, so they differ only in what a bound is checked against.
const RANGE_TYPES = new Set(['numericRange', 'slider']);
// A checkbox carries no vocabulary and Avito's own control sends 1 for it.
const CHECKBOX_TYPES = new Set(['bannerCheckBoxWithImage', 'boolean']);
const PARAM_TYPES = new Set([
  'bannerCheckBoxWithImage', 'boolean', 'checkboxGroup', 'keywords', 'multiselect',
  'numericRange', 'radioGroup', 'sectionedMultiselect', 'select', 'slider',
]);

// The short keys are ordinary filter keys for the caller: `avito get-filters` returns them
// beside `params[...]`, and they are typed here only because their request
// serialization and their authoritative `searchCore` carrier are per-key facts confirmed
// live, not something derivable from the schema. A key outside this map is refused
// instead of guessed (D-031, D-032).
export const SHORT_KEYS = Object.freeze({
  price: {
    apiType: 'numericRange',
    kind: 'range',
    coreFrom: 'priceMin',
    coreTo: 'priceMax',
    paramFrom: 'pmin',
    paramTo: 'pmax',
  },
  user: { apiType: 'radioGroup', kind: 'enum', core: 'owner', param: 'user' },
  d: { apiType: 'checkboxGroup', kind: 'enum', core: 'withDeliveryOnly', param: 'd' },
  localPriority: { apiType: 'boolean', kind: 'boolean', core: 'localPriority', param: 'localPriority' },
  sort: { apiType: 'select', kind: 'enum', core: 'sort', param: 's' },
});

function normalizeBoolean(value, label) {
  if (value == null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new ArgumentError(`${label} must be a boolean flag`);
}

function normalizePrice(value, label) {
  if (value === '') return null;
  if (!/^\d+$/.test(value)) {
    throw new ArgumentError(`set ${label} bound must be a non-negative integer`);
  }
  const price = Number(value);
  if (!Number.isSafeInteger(price)) {
    throw new ArgumentError(`set ${label} bound is out of range`);
  }
  return String(price);
}

function normalizeValueList(rawValue, key) {
  if (rawValue.length > MAX_SELECTION_VALUE_LENGTH) {
    throw new ArgumentError(`set value of ${key} must be 1-${MAX_SELECTION_VALUE_LENGTH} characters`);
  }
  // Several values of one filter travel in one call because chaining cannot express them:
  // a second call for the same key replaces the earlier selection instead of adding to it
  // (F-050, D-030).
  const values = rawValue.split(',').map((entry) => entry.trim());
  if (values.some((entry) => !entry)) {
    throw new ArgumentError(`set values of ${key} must be separated by "," with no empty value`);
  }
  if (values.length > MAX_SELECTION_VALUES) {
    throw new ArgumentError(`set must carry 1-${MAX_SELECTION_VALUES} values per filter`);
  }
  if (new Set(values).size !== values.length) {
    throw new ArgumentError(`set must not repeat the same value of ${key}`);
  }
  return values;
}

// `;` separates different filters, `,` separates values of one filter, `..` carries a range
// and an empty value clears the filter (D-032). The separators cannot collide: every option
// value observed so far is `^\d+$` and every key is `params[<digits>]` or plain latin.
export function normalizeSelections(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new ArgumentError('set must carry at least one <key>=<value> selection');
  }
  const chunks = text.split(';').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (chunks.length === 0) {
    throw new ArgumentError('set must carry at least one <key>=<value> selection');
  }
  if (chunks.length > MAX_SELECTIONS) {
    throw new ArgumentError(`set must carry 1-${MAX_SELECTIONS} filters`);
  }

  const selections = [];
  const seenKeys = new Set();
  for (const chunk of chunks) {
    const separator = chunk.indexOf('=');
    if (separator <= 0) {
      throw new ArgumentError(
        `set entry "${chunk}" must use <key>=<value>; separate different filters with ";"`,
      );
    }
    const key = chunk.slice(0, separator).trim();
    const rawValue = chunk.slice(separator + 1).trim();
    const paramMatch = key.match(PARAM_KEY_PATTERN);
    const shortKey = Object.hasOwn(SHORT_KEYS, key) ? SHORT_KEYS[key] : null;
    if (!paramMatch && !shortKey) {
      throw new ArgumentError(
        `set key "${key}" is not applicable. Pass a key exactly as \`avito get-filters\` prints it: `
        + `params[<attrId>] or one of ${Object.keys(SHORT_KEYS).join(', ')}.`,
      );
    }
    if (seenKeys.has(key)) {
      throw new ArgumentError(`set must not repeat filter ${key}; give it all of its values at once`);
    }
    seenKeys.add(key);

    // `..` cannot occur inside a value: every option value observed so far is `^\d+$`, so a
    // `params[...]` selection carrying it is a range and nothing else. Which range it is —
    // plain numbers or the option values of a slider — is decided against the fresh schema,
    // because only Avito knows the type of that key on this route (D-041).
    const clear = rawValue === '';
    const selection = {
      key,
      kind: shortKey ? shortKey.kind : (!clear && RANGE_PATTERN.test(rawValue) ? 'range' : 'params'),
      attrId: paramMatch ? paramMatch[1] : null,
      short: shortKey ? { ...shortKey } : null,
      clear,
      values: [],
      from: null,
      to: null,
    };

    if (!clear) {
      if (selection.kind === 'range') {
        const range = rawValue.match(RANGE_PATTERN);
        if (!range) {
          throw new ArgumentError(
            `set value of ${key} must be a range "<from>..<to>"; either bound may be omitted `
            + `(${key}=1000..5000, ${key}=..30000, ${key}=1000..)`,
          );
        }
        selection.from = normalizePrice(range[1], 'lower');
        selection.to = normalizePrice(range[2], 'upper');
        if (selection.from == null && selection.to == null) {
          throw new ArgumentError(`set value of ${key} must carry at least one bound; use "${key}=" to clear it`);
        }
        // Only a numeric range can be ordered here. The ends of a slider are option values,
        // and their order is the order of the control, not of the numbers behind them, so
        // that check waits until the fresh schema names the type.
        if (
          shortKey
          && selection.from != null
          && selection.to != null
          && Number(selection.from) > Number(selection.to)
        ) {
          throw new ArgumentError(`set lower bound of ${key} must be <= upper bound`);
        }
      } else {
        selection.values = normalizeValueList(rawValue, key);
        if (selection.kind === 'boolean' && (selection.values.length !== 1 || selection.values[0] !== '1')) {
          throw new ArgumentError(`set value of ${key} must be 1; use "${key}=" to clear it`);
        }
        // searchCore carries one scalar for each short key, so a second value could not be
        // confirmed even if Avito accepted it.
        if (selection.short && selection.values.length > 1) {
          throw new ArgumentError(`set filter ${key} takes a single value`);
        }
      }
    }

    selections.push(selection);
  }
  return selections;
}

// A repeated named option silently keeps only the last one, and the other filters never
// reach Avito at all (F-050). That loss is invisible in the output, so it is refused here.
export function assertSingleSetOption(argv) {
  const occurrences = argv.filter((entry) => entry === '--set' || entry.startsWith('--set='));
  if (occurrences.length > 1) {
    throw new ArgumentError(
      'set may be passed once; carry every filter in that one option, separated by ";" '
      + '(--set \'price=1000..5000;params[112691]=757883,757884\')', // vocabulary-ok: sample argument in an error message, not an identifier the command uses
    );
  }
}

/** The one filter of the fresh schema a selection names, refused by name if there is none. */
function sourceFilterOf(selection, sourceFilters) {
  const matches = sourceFilters.filter((filter) => filter?.id === selection.key);
  if (matches.length === 0) {
    throw new ArgumentError(
      `filter ${selection.key} is not available on this search URL; read the current keys with avito get-filters`,
    );
  }
  if (matches.length !== 1) {
    throw new ArgumentError(`filter ${selection.key} is ambiguous in the fresh Avito schema`);
  }
  return matches[0];
}

/** The options of one filter, or a refusal to read a control drawn two ways at once. */
function vocabularyOf(sourceFilter, key) {
  const options = filterOptions(sourceFilter);
  if (options === null) {
    throw new CommandExecutionError(`Avito filter ${key} mixes sectioned and flat values`);
  }
  return options;
}

/**
 * Check every selection against the fresh schema, and record the type it was
 * checked against — the answer is confirmed against that same type later.
 */
export function assertSelectionsApplicable(selections, sourceFilters) {
  for (const selection of selections) {
    const sourceFilter = sourceFilterOf(selection, sourceFilters);
    const apiType = String(sourceFilter.type || '');
    selection.sourceType = apiType;

    if (selection.short) {
      if (apiType !== selection.short.apiType) {
        throw new ArgumentError(
          // Quoted rather than defaulted: a filter that arrives with no type at all
          // reads as the empty string it is, instead of as a word nobody sent.
          `filter ${selection.key} changed its Avito type to "${apiType}"; `
          + `its serialization is confirmed only for ${selection.short.apiType}`,
        );
      }
    } else {
      // What the caller wrote and what the key is must agree before anything is sent:
      // a range where Avito has a list, or a list where Avito has a range, would
      // otherwise be sent as the wrong pair of keys and come back as drift.
      if (selection.kind === 'range' && !RANGE_TYPES.has(apiType)) {
        // A keyword field takes text, and text that reads as two numbers around a
        // dot pair cannot be told from a range by the grammar alone, so it is
        // refused by name instead of being sent as the wrong thing.
        throw new ArgumentError(
          apiType === 'keywords'
            ? `filter ${selection.key} takes text, and a value written as <from>..<to> cannot be passed to it`
            : `filter ${selection.key} is not a range in the fresh Avito schema; pass its values as they come from avito get-filters`,
        );
      }
      if (!selection.clear && selection.kind !== 'range' && RANGE_TYPES.has(apiType)) {
        throw new ArgumentError(
          `filter ${selection.key} is a range; pass it as ${selection.key}=<from>..<to>, either bound may be omitted`,
        );
      }
      if (!selection.clear && CHECKBOX_TYPES.has(apiType)
        && (selection.values.length !== 1 || selection.values[0] !== '1')) {
        throw new ArgumentError(
          `filter ${selection.key} is a checkbox; pass ${selection.key}=1 or "${selection.key}=" to clear it`,
        );
      }
      if (!PARAM_TYPES.has(apiType)) {
        throw new ArgumentError(`filter ${selection.key} has a type this command cannot serialize safely`);
      }
      // Several values are only meaningful where Avito itself accepts several: a
      // single-value control would silently keep one of them and return a page that
      // does not answer the request.
      if (selection.values.length > 1 && !MULTI_VALUE_TYPES.has(apiType)) {
        throw new ArgumentError(`filter ${selection.key} takes a single value in the fresh Avito schema`);
      }
    }

    // The ends of a slider are option values, so they are checked against the same
    // vocabulary as any other value, and their order is the order of that list: the
    // numbers behind the IDs are Avito's business, not a rule this command may lean on.
    if (!selection.clear && selection.kind === 'range' && !selection.short && apiType === 'slider') {
      const options = vocabularyOf(sourceFilter, selection.key);
      const positionOf = (bound) => options.findIndex((option) => String(option?.value ?? option?.id ?? '') === bound);
      const fromPosition = selection.from == null ? -1 : positionOf(selection.from);
      const toPosition = selection.to == null ? -1 : positionOf(selection.to);
      if ((selection.from != null && fromPosition < 0) || (selection.to != null && toPosition < 0)) {
        throw new ArgumentError(
          `filter ${selection.key} is a slider: each bound must be one of the option values avito get-filters prints for it`,
        );
      }
      if (fromPosition >= 0 && toPosition >= 0 && fromPosition > toPosition) {
        throw new ArgumentError(`set lower bound of ${selection.key} must come before the upper bound of this slider`);
      }
    }
    if (!selection.clear && selection.kind === 'range' && !selection.short && apiType === 'numericRange'
      && selection.from != null && selection.to != null && Number(selection.from) > Number(selection.to)) {
      throw new ArgumentError(`set lower bound of ${selection.key} must be <= upper bound`);
    }

    // A keyword field has no vocabulary to look a value up in: what the caller typed
    // is the value, and Avito carries it back unchanged, spaces and case included.
    if (!selection.clear && selection.kind !== 'range' && selection.kind !== 'boolean'
      && apiType !== 'keywords' && !CHECKBOX_TYPES.has(apiType)) {
      const options = vocabularyOf(sourceFilter, selection.key);
      for (const wanted of selection.values) {
        const matchingOptions = options.filter((option) => String(option?.value ?? option?.id ?? '') === wanted);
        // Avito repeats an option in more than one group of the same control, so a
        // repeat is one option. Two names behind one value is the drift this guard
        // is for, and it is refused before anything is sent.
        const matchingNames = new Set(matchingOptions.map((option) => String(option?.name ?? option?.title ?? '')));
        if (matchingOptions.length === 0 || matchingNames.size !== 1) {
          throw new ArgumentError(
            `value ${wanted} of filter ${selection.key} is unavailable or ambiguous in the fresh Avito schema`,
          );
        }
      }
    }
  }
  return selections;
}

/**
 * Geo belongs to `avito search`, but it must survive a refinement of the URL it
 * produced: metro, districts, the point and the radius are carried unchanged and
 * verified as preserved afterwards.
 */
function buildFilterRequest(state, selections, changedParamIds, shortSelections) {
  const sourceCore = state.searchCore;
  const apiUrl = itemsApiUrl();
  carrySearchCore(apiUrl, sourceCore, changedParamIds);

  // A short key this call replaces is set over the carried value, and a cleared
  // one is removed: sending it empty is not the same request as not sending it.
  const replace = (key, value) => {
    if (value == null || value === '') apiUrl.searchParams.delete(key);
    else addScalar(apiUrl, key, value);
  };
  // A short key the call does not touch is carried over from the source state, so a
  // filter applied earlier in the chain survives this call.
  const carried = (key, coreValue) => {
    const selection = shortSelections.get(key);
    if (!selection) return coreValue;
    return selection.clear ? null : selection.values[0];
  };

  for (const selection of selections) {
    if (!selection.attrId || selection.clear) continue;
    if (selection.kind === 'range') {
      // The two keys are Avito's own: its inputs block declares them as
      // params[<attrId>][from] and [to], and an omitted bound is simply not sent.
      if (selection.from != null) apiUrl.searchParams.set(`${selection.key}[from]`, selection.from);
      if (selection.to != null) apiUrl.searchParams.set(`${selection.key}[to]`, selection.to);
      continue;
    }
    // A checkbox has no index because it has no list: the visible control sends the
    // bare key, and that is the form confirmed live (F-062).
    if (CHECKBOX_TYPES.has(selection.sourceType)) {
      apiUrl.searchParams.set(selection.key, selection.values[0]);
      continue;
    }
    selection.values.forEach((entry, index) => {
      apiUrl.searchParams.set(`${selection.key}[${index}]`, entry);
    });
  }

  replace('localPriority', carried('localPriority', sourceCore.localPriority));
  const priceSelection = shortSelections.get('price');
  if (priceSelection) {
    replace('pmin', priceSelection.clear ? null : priceSelection.from);
    replace('pmax', priceSelection.clear ? null : priceSelection.to);
  }
  replace('user', carried('user', sourceCore.owner));
  replace('d', carried('d', sourceCore.withDeliveryOnly));
  replace('s', carried('sort', sourceCore.sort));
  sealItemsApiUrl(apiUrl, state, true);
  return apiUrl;
}

/**
 * Each requested key is confirmed on its own. The `params[...]` keys are read from
 * both carriers, short keys only from `searchCore`: their `filtersV2.currentValue`
 * arrives stale or omitted even when the server URL proves the value was applied,
 * so the result schema is checked as a vocabulary and a shape, never as the answer.
 */
function assertFiltersApplied(selections, resultCore, resultFilters) {
  const resultParams = resultCore.params ?? {};
  for (const selection of selections) {
    const resultMatches = resultFilters.filter((filter) => filter?.id === selection.key);
    if (resultMatches.length > 1) {
      throw new CommandExecutionError(`Avito filtersV2 returned an ambiguous filter ${selection.key}`);
    }
    if (resultMatches.length === 1 && String(resultMatches[0].type || '') !== selection.sourceType) {
      throw new CommandExecutionError(`Avito changed the type of filter ${selection.key}`);
    }

    if (selection.attrId && selection.kind === 'range' && !selection.clear) {
      // Both carriers answer with the same object, so both are read the same way. The
      // schema is what separates an applied range from an echoed one: Avito repeats an
      // unknown key in searchCore.params and leaves currentValue empty (F-062).
      if (!sameRange(resultParams[selection.attrId], selection.from, selection.to)) {
        throw new CommandExecutionError(`Avito did not apply the requested range of ${selection.key}`);
      }
      if (resultMatches.length === 1
        && !sameRange(resultMatches[0].currentValue, selection.from, selection.to)) {
        throw new CommandExecutionError(`Avito filtersV2 did not confirm filter ${selection.key}`);
      }
      continue;
    }

    if (selection.attrId) {
      const applied = resultParams[selection.attrId];
      if (selection.clear) {
        if (!isCleared(applied)) {
          throw new CommandExecutionError(`Avito did not clear filter ${selection.key}`);
        }
      } else if (!sameValues(applied, selection.values)) {
        throw new CommandExecutionError(`Avito did not apply every requested value of ${selection.key}`);
      }
      if (resultMatches.length === 1) {
        const confirmed = resultMatches[0].currentValue;
        const matchesSchema = selection.clear ? isCleared(confirmed) : sameValues(confirmed, selection.values);
        if (!matchesSchema) {
          throw new CommandExecutionError(`Avito filtersV2 did not confirm filter ${selection.key}`);
        }
      }
      continue;
    }

    const descriptor = selection.short;
    if (descriptor.kind === 'range') {
      const appliedFrom = resultCore[descriptor.coreFrom];
      const appliedTo = resultCore[descriptor.coreTo];
      if (selection.clear) {
        if (!isCleared(appliedFrom) || !isCleared(appliedTo)) {
          throw new CommandExecutionError(`Avito did not clear filter ${selection.key}`);
        }
      } else if (!sameValues(appliedFrom, selection.from) || !sameValues(appliedTo, selection.to)) {
        throw new CommandExecutionError(`Avito did not apply the requested range of ${selection.key}`);
      }
      continue;
    }

    const applied = resultCore[descriptor.core];
    if (selection.clear) {
      if (!isCleared(applied)) {
        throw new CommandExecutionError(
          `Avito did not clear filter ${selection.key}`
          + '; if it has an explicit "no restriction" option, apply that option instead',
        );
      }
    } else if (!sameValues(applied, selection.values)) {
      throw new CommandExecutionError(`Avito did not apply the requested value of ${selection.key}`);
    }
  }
}

/** Everything this call did not change, geo included, and the page it stays on. */
function preservedCoreFields(shortSelections) {
  const preserved = [
    'locationId', 'verticalCategoryId', 'rootCategoryId', 'categoryId', 'query',
    'metroId', 'districtId', 'geoCoords', 'searchRadius',
  ];
  for (const [key, descriptor] of Object.entries(SHORT_KEYS)) {
    if (shortSelections.has(key)) continue;
    if (descriptor.kind === 'range') preserved.push(descriptor.coreFrom, descriptor.coreTo);
    else preserved.push(descriptor.core);
  }
  return preserved;
}

const OUTPUT = z.strictObject({
  query: text().nullable(),
  locationId: idString(),
  locationName: text(),
  searchUrl: searchUrlField(),
  ...LISTING_SUMMARY,
  items: z.array(LISTING_ITEM),
});

const OUTPUT_TYPE = `type Output = {
  query: string | null;   // the search the filters were applied to
  locationId: string;     // digits only — filters never move the search, this is the same region
  locationName: string;
  searchUrl: string;      // the narrowed URL; page it with get-page, re-read it with get-filters
${LISTING_SUMMARY_TYPE}
  items: Item[];          // page 1 of the narrowed search
};

${LISTING_ITEM_TYPE}`;

export default defineCommand({
  name: 'apply-filters',
  description: 'Apply filters to a search URL and return the matching listings plus the new search URL. Takes several filters at once; keys and values come from avito get-filters',
  access: 'read',
  browserTab: 'search-url',
  // vocabulary-ok: sample argument in help text, not an identifier the command uses
  example: "avito apply-filters <searchUrl> --set 'price=1000..5000;params[112691]=757883,757884'",
  domain: 'www.avito.ru',
  args: [
    {
      name: 'searchUrl',
      type: 'string',
      required: true,
      positional: true,
      help: 'Search URL from avito search, apply-filters, move-category or get-page',
    },
    {
      name: 'set',
      type: 'string',
      required: true,
      // vocabulary-ok: sample arguments in help text, not identifiers the command uses
      help: 'Filters to apply, keys exactly as avito get-filters prints them: "key=value". Separate different filters with ";", several values of one filter with ",", a range as "from..to", and clear a filter with an empty value. Example: \'price=1000..5000;user=2;params[112691]=757883,757884\'',
    },
    {
      name: 'remove-reserved',
      type: 'bool',
      default: false,
      help: 'Drop the listings Avito marks as reserved; Avito has no server-side filter for them, so the page comes back shorter',
    },
  ],
  output: OUTPUT,
  type: OUTPUT_TYPE,
  run: async (page, args) => {
    assertSingleSetOption(process.argv);
    const requestedUrl = requestedSearchUrl(args.searchUrl);
    const selections = normalizeSelections(args.set);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    await primeOrigin(page, COMMAND);

    const schema = await readDocument(page, {
      requestUrl: requestedUrl,
      stage: 'schema',
      keep: CATALOG_KEYS,
      schema: CATALOG_DOCUMENT,
      subject: 'Avito SSR filter state',
      command: COMMAND,
    });
    const sourceCore = schema.state.searchCore;
    const sourceSections = schema.state.filtersV2?.Sections;
    if (!Array.isArray(sourceSections)) {
      throw new CommandExecutionError('Avito SSR filter state carries no filter schema');
    }
    // A filtered page 2 would be a different page 2 after filtering, so the two
    // operations stay separate rather than one of them guessing the other.
    if (Number(sourceCore.page) !== 1) {
      throw new ArgumentError('avito apply-filters accepts page-1 search URLs; change the page with avito get-page');
    }

    assertSelectionsApplicable(selections, flattenFilters(sourceSections));
    const sourceParamEntries = coreParamEntries(sourceCore, 'Avito SSR searchCore');
    const changedParamIds = new Set(selections.filter((entry) => entry.attrId).map((entry) => entry.attrId));
    const shortSelections = new Map(selections.filter((entry) => entry.short).map((entry) => [entry.key, entry]));

    const api = await readCatalogPage(
      page,
      buildFilterRequest(schema.state, selections, changedParamIds, shortSelections),
      schema.responseUrl,
      COMMAND,
    );
    const resultCore = api.searchCore;

    const driftedField = preservedCoreDrift(sourceCore, resultCore, preservedCoreFields(shortSelections));
    if (driftedField) {
      throw new CommandExecutionError(`Avito changed preserved search field ${driftedField}`);
    }
    if (Number(resultCore.page) !== 1) {
      throw new CommandExecutionError('Avito returned an unexpected page');
    }
    const driftedParam = preservedParamsDrift(
      sourceParamEntries.filter(([attrId]) => !changedParamIds.has(attrId)),
      resultCore.params,
    );
    if (driftedParam) {
      throw new CommandExecutionError(`Avito changed preserved params[${driftedParam}]`);
    }

    assertFiltersApplied(selections, resultCore, flattenFilters(api.filtersV2.Sections));

    const searchLocation = cleanText(resultCore.locationName);
    const searchLocationId = Number(resultCore.locationId);
    if (!searchLocation || !Number.isInteger(searchLocationId) || searchLocationId <= 0) {
      throw new CommandExecutionError('Avito returned unsupported effective search context');
    }
    const resultSearchUrl = answeredUrl(api.url, 'search result URL').href;

    const decoded = catalogItems(api.catalog);
    if (decoded.length === 0) {
      if (resultCount(api) === 0) {
        throw new EmptyResultError(COMMAND, 'No listings match the requested filters');
      }
      throw new CommandExecutionError('Avito returned no catalog items with a non-zero result count');
    }

    return {
      query: cleanText(resultCore.query) || null,
      locationId: String(searchLocationId),
      locationName: searchLocation,
      searchUrl: resultSearchUrl,
      ...listingAnswer(decoded, removeReserved, COMMAND),
    };
  },
});
