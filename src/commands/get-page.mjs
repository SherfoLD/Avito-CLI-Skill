/**
 * `avito get-page` — the node half.
 *
 * It applies no filter, chooses no region and constructs no route: every one of
 * those decisions is already inside the URL it was handed, and re-deciding any
 * of them would silently change the search the caller is paging through.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { paginate } from '../browser/commands/get-page.mjs';
import { LISTING_ROW, applyReservedFilter, listingRows } from '../site/listing.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const MAX_FILTERS = 400;
const MAX_PARAMS = 400;
const MAX_PARAM_VALUES = 2000;

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

  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed.href;
}

function normalizePage(value) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new ArgumentError('page must be a positive safe integer');
  }
  return page;
}

function normalizeBoolean(value, label) {
  if (value == null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new ArgumentError(`${label} must be a boolean flag`);
}

function normalizeResultUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new CommandExecutionError('Avito pagination returned an invalid search URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.avito.ru') {
    throw new CommandExecutionError('Avito pagination returned a search URL outside www.avito.ru');
  }
  parsed.hash = '';
  return parsed.href;
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

export default defineCommand({
  name: 'get-page',
  description: 'Get another result page of a search URL. Returns the same listing columns as avito search',
  access: 'read',
  example: 'avito get-page <searchUrl> --page 2 -f json',
  domain: 'www.avito.ru',
  args: [
    { name: 'searchUrl', type: 'string', required: true, positional: true, help: 'Search URL from avito search, apply-filters or move-category, with every filter already applied to it' },
    { name: 'page', type: 'int', required: true, help: 'Positive result-page number' },
    { name: 'remove-reserved', type: 'bool', default: false, help: 'Drop the listings Avito marks as reserved; Avito has no server-side filter for them, so the page comes back shorter' },
  ],
  row: LISTING_ROW,
  run: async (page, args) => {
    const requestedUrl = normalizeCatalogUrl(args.searchUrl);
    const requestedPage = normalizePage(args.page);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito same-origin pagination context');
    }

    let observed;
    try {
      observed = await page.evaluateWithArgs(paginate, {
        requestedUrl,
        requestedPage,
        MAX_FILTERS,
        MAX_PARAMS,
        MAX_PARAM_VALUES,
      });
    } catch (error) {
      asExecutionError(error, 'reading the Avito result page');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito pagination returned an invalid result');
    }
    if (observed.success !== true) {
      const message = String(observed.message || 'Avito pagination failed');
      if (observed.code === 'empty') {
        throw new EmptyResultError('avito get-page', message);
      }
      if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
        throw new TimeoutError(`Avito page ${observed.stage || 'request'}`, 20);
      }
      if (observed.code === 'access') {
        throw new CommandExecutionError(`Avito requires human verification or a rate-limit cooldown (${message})`);
      }
      throw new CommandExecutionError(`${observed.stage || 'Avito page'} failed: ${message}`);
    }

    if (!Array.isArray(observed.resultRows) || observed.resultRows.length === 0) {
      throw new CommandExecutionError('Avito pagination returned no decoded rows');
    }
    const searchLocation = String(observed.resultSearchLocation || '').trim();
    const searchUrl = normalizeResultUrl(observed.resultSearchUrl);
    if (!searchLocation) {
      throw new CommandExecutionError('Avito pagination returned invalid search metadata');
    }

    return listingRows(
      applyReservedFilter(observed.resultRows, removeReserved, 'avito get-page'),
      searchUrl,
    );
  },
});
