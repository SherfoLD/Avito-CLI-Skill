/**
 * `avito apply-filters` — the node half, which is almost all one parser.
 *
 * The `--set` grammar exists because chaining cannot express what Avito accepts:
 * a second call for the same key replaces the earlier selection rather than
 * adding to it, so several values and several filters must travel in one call
 * (F-050, D-030).
 *
 * The parser is fail-closed because a malformed entry that got through would not
 * fail — it would reach Avito as a different request and come back as a
 * perfectly ordinary page of listings.
 *
 * What a key *means* is decided in the browser half, against the fresh schema of
 * the search URL. This file only decides what the caller wrote.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { applyFilters } from '../browser/commands/apply-filters.mjs';
import { LISTING_ROW, applyReservedFilter, listingRows } from '../site/listing.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const PARAM_KEY_PATTERN = /^params\[(\d+)\]$/;
const RANGE_PATTERN = /^(\d*)\.\.(\d*)$/;
const MAX_SELECTION_VALUE_LENGTH = 300;
const MAX_SELECTION_VALUES = 50;
const MAX_SELECTIONS = 50;
const MAX_FILTERS = 400;
const MAX_PARAMS = 400;
const MAX_PARAM_VALUES = 2000;

// The short keys are ordinary filter keys for the caller: `avito get-filters` returns them
// in the same rows as `params[...]`, and they are typed here only because their request
// serialization and their authoritative `searchCore` carrier are per-key facts confirmed
// live, not something derivable from the schema. A key outside this table is refused
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

function normalizeCatalogUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('searchUrl must be a non-empty Avito catalog or search URL');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError('searchUrl must be a valid absolute URL');
  }

  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new ArgumentError('searchUrl must use https://www.avito.ru');
  }

  parsed.protocol = 'https:';
  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed.toString();
}

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

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

export default defineCommand({
  name: 'apply-filters',
  description: 'Apply filters to a search URL and return the matching listings plus the new search URL. Takes several filters at once; keys and values come from avito get-filters',
  access: 'read',
  // vocabulary-ok: sample argument in help text, not an identifier the command uses
  example: "avito apply-filters <searchUrl> --set 'price=1000..5000;params[112691]=757883,757884' -f json",
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
  row: LISTING_ROW,
  run: async (page, args) => {
    assertSingleSetOption(process.argv);
    const requestedUrl = normalizeCatalogUrl(args.searchUrl);
    const selections = normalizeSelections(args.set);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito same-origin context');
    }

    let observed;
    try {
      observed = await page.evaluateWithArgs(applyFilters, {
        requestedUrl,
        selections,
        SHORT_KEYS,
        MAX_FILTERS,
        MAX_PARAMS,
        MAX_PARAM_VALUES,
      });
    } catch (error) {
      asExecutionError(error, 'applying the Avito filters');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito filter application returned an invalid result');
    }
    if (observed.success !== true) {
      const message = String(observed.message || 'Avito filter application failed');
      if (observed.code === 'argument') {
        throw new ArgumentError(message);
      }
      if (observed.code === 'empty') {
        throw new EmptyResultError('avito apply-filters', message);
      }
      if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
        throw new TimeoutError(`Avito apply-filters ${observed.stage || 'request'}`, 20);
      }
      if (observed.code === 'access') {
        throw new CommandExecutionError(`Avito requires human verification or a rate-limit cooldown (${message})`);
      }
      throw new CommandExecutionError(`${observed.stage || 'Avito apply-filters'} failed: ${message}`);
    }

    if (!Array.isArray(observed.apiRows) || observed.apiRows.length === 0) {
      throw new CommandExecutionError('Avito filter application returned no decoded rows');
    }
    const searchLocation = String(observed.apiSearchLocation || '').trim();
    const searchUrl = normalizeCatalogUrl(observed.apiSearchUrl);
    if (!searchLocation) {
      throw new CommandExecutionError('Avito filter application returned invalid search metadata');
    }

    return listingRows(
      applyReservedFilter(observed.apiRows, removeReserved, 'avito apply-filters'),
      searchUrl,
    );
  },
});
