/**
 * `avito get-categories` — the node half, which is all of the decoding. It
 * returns Avito's category sidebar as rows, in the order Avito drew it, so a
 * `name` can be fed straight into `move-category`.
 *
 * The columns that are not a copy of the node:
 *
 *   `role`           `branch`, `option`, `current` (the node's `type`, see
 *                    `src/browser/prelude/rubricator.mjs`) or `back`, the way up
 *   `parent`         the visible name of the node this one hangs under, so a row
 *                    read on its own still says which branch it is on
 *   `navigable`      whether `move-category` can be pointed at this row: it has
 *                    a route and that route is not the one we are on (D-057)
 *   `preservesQuery` whether following this row keeps the text query. One that
 *                    drops it does not widen the search — it replaces it with a
 *                    plain category browse, which `move-category` refuses
 *
 * The whole tree is returned, every node of it. What a node's state means is
 * Avito's to say, not this command's: a branch that is collapsed and two group
 * heads that are both `isCurrent` are what the page draws on a search Avito
 * could not place in a category (F-084).
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
  rank,
  requiredText,
  searchUrl,
  text,
  z,
} from '../runtime/schema.mjs';
import { isFollowableNode, sidebarRole } from '../browser/prelude/rubricator.mjs';
import { readCategoryState } from '../browser/commands/get-categories.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const MAX_SIDE_NODES = 200;
const MAX_DEPTH = 20;
const MAX_NAME_LENGTH = 300;

// Avito's three node kinds (`src/browser/prelude/rubricator.mjs`) plus the one this
// command adds: `back`, the row that leads up out of the current category.
const SIDEBAR_ROLE = z.enum(['branch', 'option', 'current', 'back']);

/**
 * The part of a sidebar node that is a shape. What a node *means* — whether its
 * type and state agree, whether two nodes claim to be current, where its URL
 * points — is decided below.
 */
const SIDEBAR_NODE = z.object({
  id: z.number().int().positive(),
  type: z.number().int(),
  name: requiredText().pipe(z.string().max(MAX_NAME_LENGTH)),
  children: z.array(z.unknown()),
  isCurrent: z.boolean(),
  isOpened: z.boolean(),
  hasBack: z.boolean(),
  url: z.unknown(),
});

/** The search this sidebar belongs to. An empty query is a category browse. */
const CATEGORY_CONTEXT = z.object({
  query: z.string(),
  locationId: z.number().int().positive(),
});

function normalizeCatalogUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('searchUrl must be a non-empty Avito search URL');

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

function normalizeResultUrl(value, baseUrl, label) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new CommandExecutionError(`Avito ${label} contains a missing URL`);
  }

  let parsed;
  try {
    parsed = new URL(raw, baseUrl);
  } catch {
    throw new CommandExecutionError(`Avito ${label} contains a malformed URL`);
  }

  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new CommandExecutionError(`Avito ${label} points outside https://www.avito.ru`);
  }

  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed;
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, 20);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function normalizeQuery(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
}

function targetPreservesQuery(targetUrl, currentQuery) {
  return normalizeQuery(targetUrl.searchParams.get('q')) === normalizeQuery(currentQuery);
}

export default defineCommand({
  name: 'get-categories',
  description: 'Get the whole Avito category sidebar of a search URL as a tree: where the search sits, and every route it can be moved to. Feed a name column value into avito move-category',
  access: 'read',
  example: 'avito get-categories <searchUrl> -f json',
  domain: 'www.avito.ru',
  args: [
    {
      name: 'searchUrl',
      type: 'string',
      required: true,
      positional: true,
      help: 'Search URL from avito search, apply-filters, move-category or get-page',
    },
  ],
  // `preservesQuery` and `searchUrl` are null together and only where there is
  // no move to make: the route the search is already on, and a node Avito gave
  // no route at all. `parent` is null at the top of the tree and nowhere else.
  row: z.strictObject({
    rank: rank(),
    role: SIDEBAR_ROLE,
    name: text().max(MAX_NAME_LENGTH),
    depth: z.number().int().nonnegative().max(MAX_DEPTH),
    parent: text().max(MAX_NAME_LENGTH).nullable(),
    current: z.boolean(),
    hasChildren: z.boolean(),
    navigable: z.boolean(),
    preservesQuery: z.boolean().nullable(),
    searchUrl: searchUrl().nullable(),
  }),
  run: async (page, args) => {
    const requestedUrl = normalizeCatalogUrl(args.searchUrl);

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito origin');
    }

    let observed;
    try {
      observed = await page.evaluateWithArgs(readCategoryState, { requestUrl: requestedUrl });
    } catch (error) {
      asExecutionError(error, 'fetching Avito category navigation state');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito category navigation request returned an invalid result');
    }
    if (observed.success !== true) {
      const message = String(observed.message || 'Avito category navigation request failed');
      if (observed.code === 'access') {
        throw new CommandExecutionError(`Avito requires human verification (${message})`);
      }
      if (observed.code === 'http') {
        throw new CommandExecutionError(`Avito category navigation request returned HTTP ${observed.details?.status || 0}`);
      }
      if (observed.code === 'content_type') {
        throw new CommandExecutionError(
          `Avito category navigation request returned ${observed.details?.contentType || 'an unknown content type'}`,
        );
      }
      if (observed.code === 'parse') {
        throw new CommandExecutionError('Avito SSR bootstrap JSON is malformed');
      }
      if (observed.code === 'missing') {
        throw new EmptyResultError('avito get-categories', 'This Avito page has no SSR search state');
      }
      if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
        throw new TimeoutError('Avito category navigation request', 20);
      }
      throw new CommandExecutionError(`${observed.stage || 'Avito get-categories'} failed: ${message}`);
    }

    const responseUrl = normalizeResultUrl(
      observed.responseUrl,
      requestedUrl,
      'category navigation response',
    );
    const payloadUrl = normalizeResultUrl(
      observed.url,
      responseUrl.href,
      'category navigation state',
    );
    if (payloadUrl.pathname !== responseUrl.pathname) {
      throw new CommandExecutionError('Avito category navigation state changed the search pathname');
    }

    const searchCore = decode(
      CATEGORY_CONTEXT,
      observed.searchCore,
      'Avito category navigation state',
    );

    const rawSideNodes = observed.sideNodes;
    if (!Array.isArray(rawSideNodes)) {
      throw new CommandExecutionError('Avito category sidebar has an unexpected shape');
    }

    const rows = [];
    const seenSideIds = new Set();
    const decodeSideNodes = (nodes, depth, parent) => {
      if (!Array.isArray(nodes) || depth > MAX_DEPTH) {
        throw new CommandExecutionError('Avito category sidebar exceeds its supported nesting depth');
      }

      for (const rawNode of nodes) {
        if (rows.length >= MAX_SIDE_NODES) {
          throw new CommandExecutionError('Avito category sidebar contains implausibly many nodes');
        }
        const node = decode(
          SIDEBAR_NODE,
          rawNode,
          `Avito category sidebar node at position ${rows.length}`,
        );
        if (seenSideIds.has(node.id)) {
          throw new CommandExecutionError(`Avito category sidebar repeats node ID ${node.id}`);
        }
        const role = sidebarRole(node.type);
        if (role === null) {
          throw new CommandExecutionError(`Avito category sidebar node ${node.id} has unsupported type`);
        }
        seenSideIds.add(node.id);

        // A node Avito hangs no URL on is a row that cannot be followed, not a
        // sidebar this command fails to understand. One that carries a URL
        // pointing off the site is the second thing, and it stops the call.
        const target = String(node.url ?? '').trim() === ''
          ? null
          : normalizeResultUrl(node.url, responseUrl.href, `category sidebar node ${node.id}`);
        const navigable = isFollowableNode(node.type, target, responseUrl.pathname);

        rows.push({
          rank: rows.length + 1,
          role: node.hasBack ? 'back' : role,
          name: node.name,
          depth,
          parent,
          current: node.isCurrent,
          hasChildren: node.children.length > 0,
          navigable,
          preservesQuery: navigable ? targetPreservesQuery(target, searchCore.query) : null,
          searchUrl: navigable ? target.href : null,
        });
        decodeSideNodes(node.children, depth + 1, node.name);
      }
    };
    decodeSideNodes(rawSideNodes, 0, null);

    if (rows.length === 0) {
      throw new EmptyResultError('avito get-categories', 'This Avito search has no category navigation');
    }

    return rows;
  },
});
