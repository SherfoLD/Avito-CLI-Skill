/**
 * `avito get-categories` — the node half, which is all of the decoding. It
 * returns Avito's category sidebar as rows, in the order Avito drew it, so a
 * `name` can be fed straight into `move-category`.
 *
 * The two columns that are not a copy of the node:
 *
 *   `role`           `expanded`, `option`, `current` (the node's `type`, see
 *                    `src/browser/prelude/rubricator.mjs`) or `back`, the way up
 *   `preservesQuery` whether following this row keeps the text query. One that
 *                    drops it does not widen the search — it replaces it with a
 *                    plain category browse, which `move-category` refuses
 *
 * A node is validated strictly even though nothing is followed here: describing
 * a sidebar wrongly would send `move-category` at the wrong route.
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
import { isNavigableSidebarNode, sidebarRole } from '../browser/prelude/rubricator.mjs';
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
const SIDEBAR_ROLE = z.enum(['expanded', 'option', 'current', 'back']);

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
  description: 'Get the category Avito auto-detected for a search URL and the other categories reachable from it. Feed a name column value into avito move-category',
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
  // `preservesQuery` and `searchUrl` are null together and only for a row that
  // cannot be followed: an expanded branch is a control, and the current
  // category is where the search already is.
  row: z.strictObject({
    rank: rank(),
    role: SIDEBAR_ROLE,
    name: text().max(MAX_NAME_LENGTH),
    depth: z.number().int().nonnegative().max(MAX_DEPTH),
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

    const decodedSideNodes = [];
    const seenSideIds = new Set();
    const decodeSideNodes = (nodes, depth = 0) => {
      if (!Array.isArray(nodes) || depth > MAX_DEPTH) {
        throw new CommandExecutionError('Avito category sidebar exceeds its supported nesting depth');
      }

      for (const rawNode of nodes) {
        if (decodedSideNodes.length >= MAX_SIDE_NODES) {
          throw new CommandExecutionError('Avito category sidebar contains implausibly many nodes');
        }
        const node = decode(
          SIDEBAR_NODE,
          rawNode,
          `Avito category sidebar node at position ${decodedSideNodes.length}`,
        );
        if (seenSideIds.has(node.id)) {
          throw new CommandExecutionError(`Avito category sidebar repeats node ID ${node.id}`);
        }
        const role = sidebarRole(node.type);
        if (role === null) {
          throw new CommandExecutionError(`Avito category sidebar node ${node.id} has unsupported type`);
        }
        if (
          (role === 'expanded' && (!node.isOpened || node.children.length === 0))
          || (role === 'option' && node.isCurrent)
          || (role === 'current' && !node.isCurrent)
        ) {
          throw new CommandExecutionError(`Avito category sidebar node ${node.id} has inconsistent type/state`);
        }

        seenSideIds.add(node.id);
        const navigable = isNavigableSidebarNode(node.type);
        const targetUrl = navigable
          ? normalizeResultUrl(node.url, responseUrl.href, `category sidebar node ${node.id}`)
          : null;
        // The current row's URL is checked and then dropped: it is never a
        // `searchUrl` in the output, because moving to where you already are is
        // not a move. A malformed one still means this is not the sidebar of
        // this search, so it is not passed over in silence.
        if (node.isCurrent) {
          normalizeResultUrl(node.url, responseUrl.href, `current category sidebar node ${node.id}`);
        }
        decodedSideNodes.push({
          decodedNodeId: node.id,
          decodedName: node.name,
          decodedDepth: depth,
          decodedCurrent: node.isCurrent,
          decodedHasChildren: node.children.length > 0,
          decodedNavigable: navigable,
          decodedRole: node.hasBack ? 'back' : role,
          decodedTargetUrl: targetUrl,
        });
        decodeSideNodes(node.children, depth + 1);
      }
    };
    decodeSideNodes(rawSideNodes);

    const currentSideNodes = decodedSideNodes.filter((node) => node.decodedCurrent);
    if (currentSideNodes.length > 1) {
      throw new CommandExecutionError('Avito category sidebar contains multiple current categories');
    }

    if (decodedSideNodes.length === 0) {
      throw new EmptyResultError('avito get-categories', 'This Avito search has no category navigation');
    }

    const rows = [];
    for (const node of decodedSideNodes) {
      rows.push({
        rank: rows.length + 1,
        role: node.decodedRole,
        name: node.decodedName,
        depth: node.decodedDepth,
        current: node.decodedCurrent,
        hasChildren: node.decodedHasChildren,
        navigable: node.decodedNavigable,
        preservesQuery: node.decodedNavigable
          ? targetPreservesQuery(node.decodedTargetUrl, searchCore.query)
          : null,
        searchUrl: node.decodedNavigable ? node.decodedTargetUrl.href : null,
      });
    }

    return rows;
  },
});
