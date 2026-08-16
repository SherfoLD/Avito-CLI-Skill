/**
 * `avito get-categories` — the node half, which is all of the decoding. It
 * returns Avito's category sidebar as rows, in the order Avito drew it, so a
 * `name` can be fed straight into `move-category`.
 *
 * The two columns that are not a copy of the node:
 *
 *   `role`           `expanded`, `option`, `current` (the node's `type`, see
 *                    `src/browser/rubricator.mjs`) or `back`, the way up
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
import { isNavigableSidebarNode, sidebarRole } from '../browser/rubricator.mjs';
import { readCategoryState } from '../decoders/get-categories.mjs';

// Origin priming only: the body is never read. Rendering the catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);
const MAX_SIDE_NODES = 200;
const MAX_DEPTH = 20;
const MAX_NAME_LENGTH = 300;

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

function cleanName(value, label) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new CommandExecutionError(`Avito ${label} has a malformed name`);
  }
  return name;
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
  columns: [
    'rank',
    'role',
    'name',
    'depth',
    'current',
    'hasChildren',
    'navigable',
    'preservesQuery',
    'searchUrl',
  ],
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

    const searchCore = observed.searchCore;
    if (!searchCore || typeof searchCore !== 'object' || Array.isArray(searchCore)) {
      throw new CommandExecutionError('Avito category navigation state has no valid searchCore');
    }
    if (typeof searchCore.query !== 'string') {
      throw new CommandExecutionError('Avito category navigation state has a malformed query');
    }
    if (!Number.isSafeInteger(searchCore.locationId) || searchCore.locationId <= 0) {
      throw new CommandExecutionError('Avito category navigation state has a malformed location ID');
    }

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
        if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
          throw new CommandExecutionError('Avito category sidebar contains a malformed node');
        }
        if (decodedSideNodes.length >= MAX_SIDE_NODES) {
          throw new CommandExecutionError('Avito category sidebar contains implausibly many nodes');
        }
        if (!Number.isSafeInteger(rawNode.id) || rawNode.id <= 0 || seenSideIds.has(rawNode.id)) {
          throw new CommandExecutionError('Avito category sidebar contains an invalid or duplicate node ID');
        }
        const role = sidebarRole(rawNode.type);
        if (role === null) {
          throw new CommandExecutionError(`Avito category sidebar node ${rawNode.id} has unsupported type`);
        }
        if (!Array.isArray(rawNode.children)) {
          throw new CommandExecutionError(`Avito category sidebar node ${rawNode.id} has malformed children`);
        }
        if (
          typeof rawNode.isCurrent !== 'boolean'
          || typeof rawNode.isOpened !== 'boolean'
          || typeof rawNode.hasBack !== 'boolean'
        ) {
          throw new CommandExecutionError(`Avito category sidebar node ${rawNode.id} has malformed state`);
        }
        if (
          (role === 'expanded' && (!rawNode.isOpened || rawNode.children.length === 0))
          || (role === 'option' && rawNode.isCurrent)
          || (role === 'current' && !rawNode.isCurrent)
        ) {
          throw new CommandExecutionError(`Avito category sidebar node ${rawNode.id} has inconsistent type/state`);
        }

        seenSideIds.add(rawNode.id);
        const navigable = isNavigableSidebarNode(rawNode.type);
        const targetUrl = navigable
          ? normalizeResultUrl(rawNode.url, responseUrl.href, `category sidebar node ${rawNode.id}`)
          : null;
        // The current row's URL is checked and then dropped: it is never a
        // `searchUrl` in the output, because moving to where you already are is
        // not a move. A malformed one still means this is not the sidebar of
        // this search, so it is not passed over in silence.
        if (rawNode.isCurrent) {
          normalizeResultUrl(rawNode.url, responseUrl.href, `current category sidebar node ${rawNode.id}`);
        }
        decodedSideNodes.push({
          decodedNodeId: rawNode.id,
          decodedName: cleanName(rawNode.name, `category sidebar node ${rawNode.id}`),
          decodedDepth: depth,
          decodedCurrent: rawNode.isCurrent,
          decodedHasChildren: rawNode.children.length > 0,
          decodedNavigable: navigable,
          decodedRole: rawNode.hasBack ? 'back' : role,
          decodedTargetUrl: targetUrl,
        });
        decodeSideNodes(rawNode.children, depth + 1);
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
