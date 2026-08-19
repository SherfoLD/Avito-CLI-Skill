/**
 * `avito move-category` — widen or narrow the category Avito auto-detected.
 *
 * It takes a visible category name and nothing else: no ID, no slug, no route.
 * The target URL is always one Avito printed in its own navigation state, so a
 * name that is not in that sidebar is refused with the names that are, never
 * turned into a slug and tried. The names come from `get-categories`, which
 * reads the same sidebar, so the two agree by construction.
 *
 * What the postconditions defend: the city and the text query belong to the
 * search and must survive the move; the filters belong to the category and may
 * not. A route that drops the query does not widen the search, it replaces it
 * with a plain category browse — which looks exactly like a legitimately wider
 * page (D-033).
 */

import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { CATALOG_DOCUMENT, SIDEBAR_DOCUMENT } from '../schemas/document.mjs';
import { MAX_NAME_LENGTH } from '../schemas/rubricator.mjs';
import { LISTING_ITEM, LISTING_ITEM_TYPE, applyReservedFilter, listingItems } from '../site/listing.mjs';
import { catalogItems } from '../site/card.mjs';
import {
  CATALOG_KEYS,
  SIDEBAR_KEYS,
  primeOrigin,
  readCatalogPage,
  readDocument,
} from '../site/carriers.mjs';
import {
  PRESERVED_CORE_FIELDS,
  carrySearchCore,
  coreParamEntries,
  itemsApiUrl,
  preservedCoreDrift,
  preservedParamsDrift,
  sealItemsApiUrl,
} from '../site/items.mjs';
import { idString, searchUrl as searchUrlField, text, z } from '../runtime/schema.mjs';
import { isFollowableNode, sidebarWalk } from '../site/rubricator.mjs';
import { cleanText, comparableText } from '../site/text.mjs';
import { answeredUrl, requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito move-category';
const VISIBLE_NAMES = 40;

// Whitespace is normalized because the name is matched against what Avito rendered, and a
// name copied out of a terminal carries whatever spacing the terminal gave it. Nothing else
// about the name is touched: a partial name must not resolve.
function normalizeTargetName(value) {
  const name = cleanText(value);
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

/**
 * Every sidebar entry of the source document, split into the ones this search can
 * be moved to and the ones it cannot, with the reason.
 *
 * The sidebar has never been observed dropping the query; `dropsQuery` stays
 * because the day it does, the answer would look like a legitimately wider page.
 */
function collectSidebar(nodes, sourceUrl, sourceQuery) {
  const candidates = [];
  const blocked = [];

  for (const { node, role, route } of sidebarWalk(nodes, sourceUrl)) {
    if (!isFollowableNode(role, route, sourceUrl.pathname)) {
      blocked.push({
        categoryName: node.name,
        reason: route === null ? 'routeless' : 'current',
        hasChildren: node.children.length > 0,
      });
    } else if (sourceQuery !== '' && cleanText(route.searchParams.get('q')) !== sourceQuery) {
      blocked.push({ categoryName: node.name, reason: 'dropsQuery' });
    } else {
      candidates.push({ categoryName: node.name, categoryUrl: route.href });
    }
  }

  return { candidates, blocked };
}

/**
 * The one route the requested name resolves to, or an argument error naming what
 * is there. The name comes back as Avito rendered it, not as it was typed.
 */
function resolveTarget({ candidates, blocked }, target, sourceQuery) {
  const visibleNames = [...new Set(candidates.map((entry) => entry.categoryName))];
  const printable = visibleNames.slice(0, VISIBLE_NAMES).join(', ') || 'none';
  const matches = candidates.filter((entry) => comparableText(entry.categoryName) === comparableText(target));

  if (matches.length === 0) {
    const blockedMatch = blocked.find((entry) => comparableText(entry.categoryName) === comparableText(target));
    if (blockedMatch) {
      const reason = blockedMatch.reason === 'current'
        ? 'is the route this search is already on; moving there is not a move'
        : blockedMatch.reason === 'routeless'
          ? `is a sidebar entry Avito hangs no route on${blockedMatch.hasChildren ? '; move to one of its children instead' : ''}`
          : `is reachable only through a route that drops the search query "${sourceQuery}",`
            + ' which would return an unrelated category listing instead of this search.'
            + ` Categories that keep the query: ${printable}`;
      throw new ArgumentError(`category "${blockedMatch.categoryName}" ${reason}`);
    }
    throw new ArgumentError(
      `category "${target}" is not reachable from this search URL. Visible categories: ${printable}`
      + (visibleNames.length > VISIBLE_NAMES ? ', …' : ''),
    );
  }

  const targets = [...new Set(matches.map((entry) => entry.categoryUrl))];
  if (targets.length !== 1) {
    throw new ArgumentError(
      `category "${target}" matches ${targets.length} different Avito routes on this page; no route is chosen for you`,
    );
  }
  return { targetUrl: new URL(targets[0]), categoryName: matches[0].categoryName };
}

const OUTPUT = z.strictObject({
  query: text().nullable(),
  category: text().max(MAX_NAME_LENGTH),
  locationId: idString(),
  locationName: text(),
  searchUrl: searchUrlField(),
  items: z.array(LISTING_ITEM),
});

const OUTPUT_TYPE = `type Output = {
  query: string | null;   // the query that survived the move; a move that drops it is refused
  category: string;       // the category moved into, spelled as Avito renders it
  locationId: string;     // digits only — the move never changes the region
  locationName: string;
  searchUrl: string;      // the new URL; the previous category's filter keys no longer apply to it
  items: Item[];          // page 1 of the new category
};

${LISTING_ITEM_TYPE}`;

export default defineCommand({
  name: 'move-category',
  description: 'Widen or narrow the category Avito auto-detected for a search URL. This changes which filters exist and which listings come back, so re-read avito get-filters afterwards',
  access: 'read',
  example: "avito move-category <searchUrl> --to 'Телефоны'",
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
      help: 'Target category, exactly the visible name from the name field of avito get-categories; only names it marks preservesQuery are accepted for a search that has a text query',
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
    const requestedUrl = requestedSearchUrl(args.searchUrl);
    const requestedName = normalizeTargetName(args.to);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    await primeOrigin(page, COMMAND);

    // Hop one: the category navigation of the URL the caller passed. The target is
    // resolved from the state Avito itself rendered, so no category route is built.
    const source = await readDocument(page, {
      requestUrl: requestedUrl,
      stage: 'source',
      keep: SIDEBAR_KEYS,
      schema: SIDEBAR_DOCUMENT,
      subject: 'Avito SSR category state',
      command: COMMAND,
    });
    const sourceCore = source.state.searchCore;
    if (Number(sourceCore.page) !== 1) {
      throw new ArgumentError('avito move-category accepts page-1 search URLs');
    }
    const sourceUrl = answeredUrl(source.responseUrl, 'category URL');
    const sourceQuery = cleanText(sourceCore.query);
    const { targetUrl, categoryName } = resolveTarget(
      collectSidebar(source.state.rubricators?.side?.nodes, sourceUrl, sourceQuery),
      requestedName,
      sourceQuery,
    );

    // Hop two: the category Avito named. Its own SSR state carries the postconditions,
    // so nothing about the move is assumed.
    const moved = await readDocument(page, {
      requestUrl: targetUrl.href,
      stage: 'target',
      keep: CATALOG_KEYS,
      schema: CATALOG_DOCUMENT,
      subject: 'Avito SSR state of the target category',
      command: COMMAND,
    });
    const resultCore = moved.state.searchCore;
    if (!Array.isArray(moved.state.filtersV2?.Sections)) {
      throw new CommandExecutionError('Avito SSR state of the target category carries no filter schema');
    }

    const resultUrl = answeredUrl(moved.responseUrl, 'category URL');
    if (resultUrl.pathname !== targetUrl.pathname) {
      throw new CommandExecutionError('Avito answered the category move with a different route');
    }
    if (Number(resultCore.page) !== 1) {
      throw new CommandExecutionError('Avito returned an unexpected page for the target category');
    }
    const locationId = Number(resultCore.locationId);
    const searchLocation = cleanText(resultCore.locationName);
    if (!Number.isInteger(locationId) || locationId <= 0 || !searchLocation) {
      throw new CommandExecutionError('Avito searchCore has an invalid location after the move');
    }
    // The city and the text query belong to the search, not to the category, so both must
    // survive a move; the filters deliberately may not, they are owned by the category.
    if (cleanText(resultCore.query) !== sourceQuery) {
      throw new CommandExecutionError(
        'Avito dropped the search query while moving the category, which would return an unrelated listing',
      );
    }
    if (Number(sourceCore.locationId) !== locationId) {
      throw new CommandExecutionError('Avito changed the location while moving the category');
    }
    const resultParamEntries = coreParamEntries(resultCore, 'Avito searchCore after the move');

    // The move is proved; the listings are asked for separately, because the SSR
    // catalog of the target route ships only its first twenty cards in full (F-089).
    const apiUrl = itemsApiUrl();
    carrySearchCore(apiUrl, resultCore);
    sealItemsApiUrl(apiUrl, moved.state, true);

    const api = await readCatalogPage(page, apiUrl, moved.responseUrl, COMMAND);

    const driftedField = preservedCoreDrift(resultCore, api.searchCore, [
      ...PRESERVED_CORE_FIELDS, 'locationId', 'metroId', 'districtId',
    ]);
    if (driftedField) {
      throw new CommandExecutionError(`Avito changed preserved search field ${driftedField}`);
    }
    if (Number(api.searchCore.page) !== 1) {
      throw new CommandExecutionError('Avito items API returned an unexpected page');
    }
    const driftedParam = preservedParamsDrift(resultParamEntries, api.searchCore.params);
    if (driftedParam) {
      throw new CommandExecutionError(`Avito changed preserved params[${driftedParam}]`);
    }
    if (answeredUrl(api.url, 'items API URL').pathname !== targetUrl.pathname) {
      throw new CommandExecutionError('Avito items API answered on a different route');
    }

    const decoded = catalogItems(api.catalog);
    if (decoded.length === 0) {
      throw new EmptyResultError(COMMAND, 'The target Avito category has no listings');
    }

    return {
      query: sourceQuery || null,
      category: categoryName,
      locationId: String(locationId),
      locationName: searchLocation,
      searchUrl: resultUrl.href,
      items: listingItems(applyReservedFilter(decoded, removeReserved, COMMAND)),
    };
  },
});
