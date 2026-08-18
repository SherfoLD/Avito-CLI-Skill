/**
 * `avito move-category` — the node half.
 *
 * It takes a visible category name and nothing else: no ID, no slug, no route.
 * The names come from `get-categories`, which reads the same sidebar, so the two
 * agree by construction — and a name Avito did not print on this route cannot be
 * turned into a URL by anybody here.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { moveCategory } from '../browser/commands/move-category.mjs';
import { LISTING_ROW, applyReservedFilter, listingRows } from '../site/listing.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const MAX_SIDE_NODES = 200;
const MAX_DEPTH = 20;
const MAX_NAME_LENGTH = 300;
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

// Whitespace is normalized because the name is matched against what Avito rendered, and a
// name copied out of a terminal carries whatever spacing the terminal gave it. Nothing else
// about the name is touched: a partial name must not resolve.
function normalizeTargetName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name) {
    throw new ArgumentError('to must be a visible category name from `avito get-categories`');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ArgumentError(`to must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return name;
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
    throw new CommandExecutionError('Avito returned an invalid category URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.avito.ru') {
    throw new CommandExecutionError('Avito returned a category URL outside www.avito.ru');
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
  name: 'move-category',
  description: 'Widen or narrow the category Avito auto-detected for a search URL. This changes which filters exist and which listings come back, so re-read avito get-filters afterwards',
  access: 'read',
  example: "avito move-category <searchUrl> --to 'Телефоны' -f json",
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
      name: 'to',
      type: 'string',
      required: true,
      help: 'Target category, exactly the visible name from the name column of avito get-categories; only names it marks preservesQuery are accepted for a search that has a text query',
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
    const requestedUrl = normalizeCatalogUrl(args.searchUrl);
    const requestedName = normalizeTargetName(args.to);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito same-origin context');
    }

    let observed;
    try {
      observed = await page.evaluateWithArgs(moveCategory, {
        requestedUrl,
        target: requestedName,
        MAX_SIDE_NODES,
        MAX_DEPTH,
        MAX_NAME_LENGTH,
        MAX_PARAMS,
        MAX_PARAM_VALUES,
      });
    } catch (error) {
      asExecutionError(error, 'moving the Avito category');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito category move returned an invalid result');
    }
    if (observed.success !== true) {
      const message = String(observed.message || 'Avito category move failed');
      if (observed.code === 'argument') {
        throw new ArgumentError(message);
      }
      if (observed.code === 'empty') {
        throw new EmptyResultError('avito move-category', message);
      }
      if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
        throw new TimeoutError(`Avito move-category ${observed.stage || 'request'}`, 20);
      }
      if (observed.code === 'access') {
        throw new CommandExecutionError(`Avito requires human verification or a rate-limit cooldown (${message})`);
      }
      throw new CommandExecutionError(`${observed.stage || 'Avito move-category'} failed: ${message}`);
    }

    if (!Array.isArray(observed.resultRows) || observed.resultRows.length === 0) {
      throw new CommandExecutionError('Avito category move returned no decoded rows');
    }
    const searchLocation = String(observed.resultSearchLocation || '').trim();
    const searchUrl = normalizeResultUrl(observed.resultSearchUrl);
    if (!searchLocation) {
      throw new CommandExecutionError('Avito category move returned invalid search metadata');
    }

    return listingRows(
      applyReservedFilter(observed.resultRows, removeReserved, 'avito move-category'),
      searchUrl,
    );
  },
});
