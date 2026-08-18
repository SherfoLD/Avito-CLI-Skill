/**
 * The browser half of `avito apply-filters`.
 *
 * Avito accepts a filter it does not apply: an unknown key is echoed back in
 * `searchCore.params` with an empty `currentValue`, a value from another
 * category is dropped in silence, and both return a full page of listings that
 * answer a different question. Nothing in the rows shows it.
 *
 * So every selection is checked twice, and the checks are not redundant. The
 * first refuses, by name, a key or value the caller could never have seen, before
 * a request exists. The second refuses an answer where Avito took the request and
 * did something else with it.
 */

import { fail } from '../prelude/refusal.mjs';
import { decodeCatalogRows } from '../prelude/card.mjs';
import { normalizeSearchUrl, readDocument } from '../prelude/document.mjs';
import {
  ITEMS_API_PATH,
  carrySearchCore,
  itemsApiState,
  preservedCoreDrift,
  preservedParamsDrift,
  readItemsApi,
  sealItemsApiUrl,
} from '../prelude/items.mjs';
import { filterOptions, flattenFilters } from '../prelude/filters.mjs';
import {
  addScalar,
  cleanText,
  isCleared,
  sameRange,
  sameValues,
} from '../prelude/text.mjs';

export async function applyFilters(input, env) {
  const {
    requestedUrl,
    selections,
    SHORT_KEYS,
    MAX_FILTERS,
    MAX_PARAMS,
    MAX_PARAM_VALUES,
  } = input;

  const schema = await readDocument(requestedUrl, 'schema', env);
  if (schema.failure) return schema.failure;
  const state = schema.payload?.data;
  const loaderState = state?.searchCore && state?.filtersV2?.Sections ? state : null;
  if (!loaderState) {
    if (schema.challenge) {
      return fail('schema', 'access', schema.documentTitle || 'Avito access challenge', { status: schema.status });
    }
    return fail('schema', schema.parseErrors ? 'parse' : 'missing', 'Avito SSR bootstrap has no complete filter state');
  }

  const sourceCore = loaderState.searchCore;
  const sourceSections = loaderState.filtersV2.Sections;
  if (!sourceCore || typeof sourceCore !== 'object' || !Array.isArray(sourceSections)) {
    return fail('schema', 'shape', 'Avito SSR search/filter state is malformed');
  }
  // A filtered page 2 would be a different page 2 after filtering, so the two
  // operations stay separate rather than one of them guessing the other.
  if (Number(sourceCore.page) !== 1) {
    return fail('selection', 'argument', 'avito apply-filters accepts page-1 search URLs; change the page with avito get-page');
  }

  let sourceFilters;
  try {
    sourceFilters = flattenFilters(sourceSections, MAX_FILTERS);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  // Every requested key is checked against the fresh schema of this very URL before
  // anything is sent. A key that is not there was never visible to the caller either,
  // so it is refused by name instead of being applied in a second round (D-031).
  // Avito accepts several words in one keyword field exactly as it accepts several
  // options of one enum, and carries them back in the same list (F-064).
  const multiValueTypes = new Set(['checkboxGroup', 'keywords', 'multiselect', 'sectionedMultiselect']);
  // Two ranges: numericRange takes plain numbers, slider takes the option values of
  // its own two dropdowns. Both serialize into the pair of keys Avito declares in
  // their inputs block, so they differ only in what a bound is checked against.
  const rangeTypes = new Set(['numericRange', 'slider']);
  // A checkbox carries no vocabulary and Avito's own control sends 1 for it.
  const checkboxTypes = new Set(['bannerCheckBoxWithImage', 'boolean']);
  const paramTypes = new Set([
    'bannerCheckBoxWithImage', 'boolean', 'checkboxGroup', 'keywords', 'multiselect',
    'numericRange', 'radioGroup', 'sectionedMultiselect', 'select', 'slider',
  ]);
  for (const selection of selections) {
    const matches = sourceFilters.filter((filter) => filter?.id === selection.key);
    if (matches.length === 0) {
      return fail(
        'selection',
        'argument',
        'filter ' + selection.key + ' is not available on this search URL; read the current keys with avito get-filters',
      );
    }
    if (matches.length !== 1) {
      return fail('selection', 'argument', 'filter ' + selection.key + ' is ambiguous in the fresh Avito schema');
    }
    const sourceFilter = matches[0];
    const apiType = String(sourceFilter.type || '');
    selection.sourceType = apiType;

    if (selection.short) {
      if (apiType !== selection.short.apiType) {
        return fail(
          'selection',
          'argument',
          // Quoted rather than defaulted: a filter that arrives with no type at all
          // reads as the empty string it is, instead of as a word nobody sent.
          'filter ' + selection.key + ' changed its Avito type to "' + apiType
          + '"; its serialization is confirmed only for ' + selection.short.apiType,
        );
      }
    } else {
      // What the caller wrote and what the key is must agree before anything is sent:
      // a range where Avito has a list, or a list where Avito has a range, would
      // otherwise be sent as the wrong pair of keys and come back as drift.
      if (selection.kind === 'range' && !rangeTypes.has(apiType)) {
        // A keyword field takes text, and text that reads as two numbers around a
        // dot pair cannot be told from a range by the grammar alone, so it is
        // refused by name instead of being sent as the wrong thing.
        return fail(
          'selection',
          'argument',
          apiType === 'keywords'
            ? 'filter ' + selection.key + ' takes text, and a value written as <from>..<to> cannot be passed to it'
            : 'filter ' + selection.key + ' is not a range in the fresh Avito schema; pass its values as they come from avito get-filters',
        );
      }
      if (!selection.clear && selection.kind !== 'range' && rangeTypes.has(apiType)) {
        return fail(
          'selection',
          'argument',
          'filter ' + selection.key + ' is a range; pass it as ' + selection.key + '=<from>..<to>, either bound may be omitted',
        );
      }
      if (!selection.clear && checkboxTypes.has(apiType)
        && (selection.values.length !== 1 || selection.values[0] !== '1')) {
        return fail(
          'selection',
          'argument',
          'filter ' + selection.key + ' is a checkbox; pass ' + selection.key + '=1 or "' + selection.key + '=" to clear it',
        );
      }
      if (!paramTypes.has(apiType)) {
        return fail('selection', 'argument', 'filter ' + selection.key + ' has a type this command cannot serialize safely');
      }
      // Several values are only meaningful where Avito itself accepts several: a
      // single-value control would silently keep one of them and return a page that
      // does not answer the request.
      if (selection.values.length > 1 && !multiValueTypes.has(apiType)) {
        return fail('selection', 'argument', 'filter ' + selection.key + ' takes a single value in the fresh Avito schema');
      }
    }

    // The ends of a slider are option values, so they are checked against the same
    // vocabulary as any other value, and their order is the order of that list: the
    // numbers behind the IDs are Avito's business, not a rule this command may lean on.
    if (!selection.clear && selection.kind === 'range' && !selection.short && apiType === 'slider') {
      const options = filterOptions(sourceFilter);
      if (options === null) {
        return fail('schema', 'shape', 'Avito filter ' + selection.key + ' mixes sectioned and flat values');
      }
      const positionOf = (bound) => options.findIndex((option) => String(option?.value ?? option?.id ?? '') === bound);
      const fromPosition = selection.from == null ? -1 : positionOf(selection.from);
      const toPosition = selection.to == null ? -1 : positionOf(selection.to);
      if ((selection.from != null && fromPosition < 0) || (selection.to != null && toPosition < 0)) {
        return fail(
          'selection',
          'argument',
          'filter ' + selection.key + ' is a slider: each bound must be one of the option values avito get-filters prints for it',
        );
      }
      if (fromPosition >= 0 && toPosition >= 0 && fromPosition > toPosition) {
        return fail('selection', 'argument', 'set lower bound of ' + selection.key + ' must come before the upper bound of this slider');
      }
    }
    if (!selection.clear && selection.kind === 'range' && !selection.short && apiType === 'numericRange'
      && selection.from != null && selection.to != null && Number(selection.from) > Number(selection.to)) {
      return fail('selection', 'argument', 'set lower bound of ' + selection.key + ' must be <= upper bound');
    }

    // A keyword field has no vocabulary to look a value up in: what the caller typed
    // is the value, and Avito carries it back unchanged, spaces and case included.
    if (!selection.clear && selection.kind !== 'range' && selection.kind !== 'boolean'
      && apiType !== 'keywords' && !checkboxTypes.has(apiType)) {
      const options = filterOptions(sourceFilter);
      if (options === null) {
        return fail('schema', 'shape', 'Avito filter ' + selection.key + ' mixes sectioned and flat values');
      }
      for (const wanted of selection.values) {
        const matchingOptions = options.filter((option) => String(option?.value ?? option?.id ?? '') === wanted);
        // Avito repeats an option in more than one group of the same control, so a
        // repeat is one option. Two names behind one value is the drift this guard
        // is for, and it is refused before anything is sent.
        const matchingNames = new Set(matchingOptions.map((option) => String(option?.name ?? option?.title ?? '')));
        if (matchingOptions.length === 0 || matchingNames.size !== 1) {
          return fail(
            'selection',
            'argument',
            'value ' + wanted + ' of filter ' + selection.key + ' is unavailable or ambiguous in the fresh Avito schema',
          );
        }
      }
    }
  }

  const sourceParams = sourceCore.params;
  if (!sourceParams || typeof sourceParams !== 'object' || Array.isArray(sourceParams)) {
    return fail('schema', 'shape', 'Avito searchCore params are malformed');
  }
  const sourceParamEntries = Object.entries(sourceParams);
  if (sourceParamEntries.length > MAX_PARAMS) {
    return fail('schema', 'shape', 'Avito searchCore has an implausible params count');
  }

  const changedParamIds = new Set(selections.filter((entry) => entry.attrId).map((entry) => entry.attrId));
  const shortSelections = new Map(selections.filter((entry) => entry.short).map((entry) => [entry.key, entry]));
  // A short key the call does not touch is carried over from the source state, so a
  // filter applied earlier in the chain survives this call.
  const carried = (key, coreValue) => {
    const selection = shortSelections.get(key);
    if (!selection) return coreValue;
    if (selection.clear) return null;
    return selection.values[0];
  };

  // Geo belongs to avito search, but it must survive a refinement of the URL it
  // produced: metro, districts, the point and the radius are carried unchanged and
  // verified as preserved below.
  const apiUrl = new URL(ITEMS_API_PATH, env.location.origin);
  try {
    carrySearchCore(apiUrl, sourceCore, MAX_PARAM_VALUES, changedParamIds);
    // A short key this call replaces is set over the carried value, and a cleared
    // one is removed: sending it empty is not the same request as not sending it.
    const replace = (key, value) => {
      if (value == null || value === '') apiUrl.searchParams.delete(key);
      else addScalar(apiUrl, key, value);
    };
    for (const selection of selections) {
      if (!selection.attrId || selection.clear) continue;
      if (selection.kind === 'range') {
        // The two keys are Avito's own: its inputs block declares them as
        // params[<attrId>][from] and [to], and an omitted bound is simply not sent.
        if (selection.from != null) apiUrl.searchParams.set(selection.key + '[from]', selection.from);
        if (selection.to != null) apiUrl.searchParams.set(selection.key + '[to]', selection.to);
        continue;
      }
      // A checkbox has no index because it has no list: the visible control sends the
      // bare key, and that is the form confirmed live (F-062).
      if (checkboxTypes.has(selection.sourceType)) {
        apiUrl.searchParams.set(selection.key, selection.values[0]);
        continue;
      }
      selection.values.forEach((entry, index) => {
        apiUrl.searchParams.set(selection.key + '[' + index + ']', entry);
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
    sealItemsApiUrl(apiUrl, loaderState, true);
  } catch (error) {
    return fail('schema', 'shape', String(error?.message || error));
  }

  const api = await readItemsApi(apiUrl, schema.responseUrl, env);
  if (api.failure) return api.failure;
  const apiState = itemsApiState(api.data);
  if (apiState.failure) return apiState.failure;
  const data = api.data;
  const resultCore = apiState.core;
  const resultCatalog = apiState.catalog;
  const resultSections = apiState.sections;

  // Everything the call did not change must come back unchanged, geo included: this
  // command is the refinement step of a URL that avito search may have created with
  // a location, metro, districts or a radius.
  const preservedCore = [
    'locationId', 'verticalCategoryId', 'rootCategoryId', 'categoryId', 'query',
    'metroId', 'districtId', 'geoCoords', 'searchRadius',
  ];
  for (const key of Object.keys(SHORT_KEYS)) {
    if (shortSelections.has(key)) continue;
    const descriptor = SHORT_KEYS[key];
    if (descriptor.kind === 'range') {
      preservedCore.push(descriptor.coreFrom, descriptor.coreTo);
    } else {
      preservedCore.push(descriptor.core);
    }
  }
  const driftedField = preservedCoreDrift(sourceCore, resultCore, preservedCore);
  if (driftedField) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field ' + driftedField);
  }
  if (Number(resultCore.page) !== 1) {
    return fail('postcondition', 'drift', 'Avito returned an unexpected page');
  }

  const resultParams = resultCore.params;
  if (!resultParams || typeof resultParams !== 'object' || Array.isArray(resultParams)) {
    return fail('postcondition', 'shape', 'Avito response searchCore params are malformed');
  }
  const driftedParam = preservedParamsDrift(
    sourceParamEntries.filter(([attrId]) => !changedParamIds.has(attrId)),
    resultParams,
  );
  if (driftedParam) {
    return fail('postcondition', 'drift', 'Avito changed preserved params[' + driftedParam + ']');
  }

  let resultFilters;
  try {
    resultFilters = flattenFilters(resultSections, MAX_FILTERS);
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }

  // Each requested key is confirmed on its own. The params[...] keys are read from both
  // carriers, short keys only from searchCore: their filtersV2.currentValue arrives
  // stale or omitted even when the server URL proves the value was applied, so the
  // result schema is checked as a vocabulary and a shape, never as the answer.
  for (const selection of selections) {
    const resultMatches = resultFilters.filter((filter) => filter?.id === selection.key);
    if (resultMatches.length > 1) {
      return fail('postcondition', 'drift', 'Avito filtersV2 returned an ambiguous filter ' + selection.key);
    }
    if (resultMatches.length === 1 && String(resultMatches[0].type || '') !== selection.sourceType) {
      return fail('postcondition', 'drift', 'Avito changed the type of filter ' + selection.key);
    }

    if (selection.attrId && selection.kind === 'range' && !selection.clear) {
      // Both carriers answer with the same object, so both are read the same way. The
      // schema is what separates an applied range from an echoed one: Avito repeats an
      // unknown key in searchCore.params and leaves currentValue empty (F-062).
      if (!sameRange(resultParams[selection.attrId], selection.from, selection.to)) {
        return fail('postcondition', 'drift', 'Avito did not apply the requested range of ' + selection.key);
      }
      if (resultMatches.length === 1
        && !sameRange(resultMatches[0].currentValue, selection.from, selection.to)) {
        return fail('postcondition', 'drift', 'Avito filtersV2 did not confirm filter ' + selection.key);
      }
      continue;
    }

    if (selection.attrId) {
      const applied = resultParams[selection.attrId];
      if (selection.clear) {
        if (!isCleared(applied)) {
          return fail('postcondition', 'drift', 'Avito did not clear filter ' + selection.key);
        }
      } else if (!sameValues(applied, selection.values)) {
        return fail('postcondition', 'drift', 'Avito did not apply every requested value of ' + selection.key);
      }
      if (resultMatches.length === 1) {
        const confirmed = resultMatches[0].currentValue;
        const matchesSchema = selection.clear ? isCleared(confirmed) : sameValues(confirmed, selection.values);
        if (!matchesSchema) {
          return fail('postcondition', 'drift', 'Avito filtersV2 did not confirm filter ' + selection.key);
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
          return fail('postcondition', 'drift', 'Avito did not clear filter ' + selection.key);
        }
      } else if (!sameValues(appliedFrom, selection.from) || !sameValues(appliedTo, selection.to)) {
        return fail('postcondition', 'drift', 'Avito did not apply the requested range of ' + selection.key);
      }
      continue;
    }

    const applied = resultCore[descriptor.core];
    if (selection.clear) {
      if (!isCleared(applied)) {
        return fail(
          'postcondition',
          'drift',
          'Avito did not clear filter ' + selection.key
          + '; if it has an explicit "no restriction" option, apply that option instead',
        );
      }
    } else if (!sameValues(applied, selection.values)) {
      return fail('postcondition', 'drift', 'Avito did not apply the requested value of ' + selection.key);
    }
  }

  let resultSearchUrl;
  try {
    resultSearchUrl = normalizeSearchUrl(data.url, env);
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }

  const searchLocation = cleanText(resultCore.locationName);
  if (!searchLocation) {
    return fail('postcondition', 'shape', 'Avito returned unsupported effective search context');
  }

  const decodedItems = decodeCatalogRows(resultCatalog, env);
  if (decodedItems.failure) return decodedItems.failure;
  if (decodedItems.rows.length === 0) {
    const count = Number(data.count ?? data.totalCount ?? 0);
    if (Number.isFinite(count) && count === 0) {
      return fail('catalog', 'empty', 'No listings match the requested filters');
    }
    return fail('catalog', 'shape', 'Avito returned no catalog items with a non-zero result count');
  }

  return {
    success: true,
    apiSearchLocation: searchLocation,
    apiSearchUrl: resultSearchUrl,
    apiRows: decodedItems.rows,
  };
}
