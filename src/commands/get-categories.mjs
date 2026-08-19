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
import { MAX_NAME_LENGTH } from '../schemas/rubricator.mjs';
import { MAX_DEPTH, isFollowableNode, sidebarWalk } from '../site/rubricator.mjs';
import { primeOrigin, readDocument } from '../site/carriers.mjs';
import { answeredUrl, requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito get-categories';

// Avito's three node kinds (`src/site/rubricator.mjs`) plus the one this command
// adds: `back`, the row that leads up out of the current category.
const SIDEBAR_ROLE = z.enum(['branch', 'option', 'current', 'back']);

/** The search this sidebar belongs to. An empty query is a category browse. */
const CATEGORY_CONTEXT = z.object({
  query: z.string(),
  locationId: z.number().int().positive(),
});

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

    const responseUrl = answeredUrl(observed.responseUrl, 'category navigation response', requestedUrl);
    const payloadUrl = answeredUrl(observed.state.url, 'category navigation state', responseUrl.href);
    if (payloadUrl.pathname !== responseUrl.pathname) {
      throw new CommandExecutionError('Avito category navigation state changed the search pathname');
    }

    const searchCore = decode(
      CATEGORY_CONTEXT,
      observed.state.searchCore,
      'Avito category navigation state',
    );

    const rows = [];
    for (const { node, depth, parent, role, route } of sidebarWalk(
      observed.state.rubricators?.side?.nodes,
      responseUrl,
    )) {
      const navigable = isFollowableNode(role, route, responseUrl.pathname);
      rows.push({
        rank: rows.length + 1,
        role: node.hasBack ? 'back' : role,
        name: node.name,
        depth,
        parent,
        current: node.isCurrent,
        hasChildren: node.children.length > 0,
        navigable,
        preservesQuery: navigable ? targetPreservesQuery(route, searchCore.query) : null,
        searchUrl: navigable ? route.href : null,
      });
    }

    if (rows.length === 0) {
      throw new EmptyResultError('avito get-categories', 'This Avito search has no category navigation');
    }

    return rows;
  },
});
