/**
 * `avito get-categories` — the node half, which is all of the decoding. It
 * returns Avito's category sidebar as rows, in the order Avito drew it, so a
 * `name` can be fed straight into `move-category`.
 *
 * The columns that are not a copy of the node:
 *
 *   `role`           `branch`, `option`, `current` (the node's `type`, see
 *                    `src/site/rubricator.mjs`) or `back`, the way up
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

import { CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import {
  decode,
  rank,
  searchUrl,
  text,
  z,
} from '../runtime/schema.mjs';
import { SIDEBAR_DOCUMENT } from '../schemas/document.mjs';
import { MAX_NAME_LENGTH, SIDEBAR_NODE } from '../schemas/rubricator.mjs';
import { isFollowableNode, sidebarRole } from '../site/rubricator.mjs';
import { primeOrigin, readDocument } from '../site/carriers.mjs';
import { requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito get-categories';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const MAX_SIDE_NODES = 200;
const MAX_DEPTH = 20;

// Avito's three node kinds (`src/site/rubricator.mjs`) plus the one this command
// adds: `back`, the row that leads up out of the current category.
const SIDEBAR_ROLE = z.enum(['branch', 'option', 'current', 'back']);

/** The search this sidebar belongs to. An empty query is a category browse. */
const CATEGORY_CONTEXT = z.object({
  query: z.string(),
  locationId: z.number().int().positive(),
});

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
    const requestedUrl = requestedSearchUrl(args.searchUrl);

    await primeOrigin(page, COMMAND);
    const observed = await readDocument(page, {
      requestUrl: requestedUrl,
      stage: 'schema',
      keep: ['url', 'searchCore', 'rubricators'],
      schema: SIDEBAR_DOCUMENT,
      subject: 'Avito category navigation state',
      command: COMMAND,
    });

    const responseUrl = normalizeResultUrl(
      observed.responseUrl,
      requestedUrl,
      'category navigation response',
    );
    const payloadUrl = normalizeResultUrl(
      observed.state.url,
      responseUrl.href,
      'category navigation state',
    );
    if (payloadUrl.pathname !== responseUrl.pathname) {
      throw new CommandExecutionError('Avito category navigation state changed the search pathname');
    }

    const searchCore = decode(
      CATEGORY_CONTEXT,
      observed.state.searchCore,
      'Avito category navigation state',
    );

    const rawSideNodes = observed.state.rubricators?.side?.nodes;
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
