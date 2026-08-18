/**
 * The browser half of `avito move-category`. Two documents and one API call: the
 * route the caller passed, read for its category sidebar; the category Avito
 * named there, read for the proof that the move happened; and the items API,
 * addressed by that second document, read for the rows (F-089).
 *
 * No category route is ever built here. The target URL is always one Avito
 * printed in its own navigation state, so a name that is not in that sidebar is
 * refused with the names that are, never turned into a slug and tried.
 *
 * What the postconditions defend: the city and the text query belong to the
 * search and must survive the move; the filters belong to the category and may
 * not. A route that drops the query does not widen the search, it replaces it
 * with a plain category browse — which looks exactly like a legitimately wider
 * page (D-033).
 */

import { fail } from '../prelude/refusal.mjs';
import { decodeCatalogRows } from '../prelude/card.mjs';
import { readDocument } from '../prelude/document.mjs';
import {
  ITEMS_API_PATH,
  PRESERVED_CORE_FIELDS,
  carrySearchCore,
  itemsApiState,
  preservedCoreDrift,
  preservedParamsDrift,
  readItemsApi,
  sealItemsApiUrl,
} from '../prelude/items.mjs';
import { isFollowableNode, sidebarRole } from '../prelude/rubricator.mjs';
import { cleanText, comparableText } from '../prelude/text.mjs';

export async function moveCategory(input, env) {
  const {
    requestedUrl, target, MAX_SIDE_NODES, MAX_DEPTH, MAX_NAME_LENGTH, MAX_PARAMS, MAX_PARAM_VALUES,
  } = input;

  // The sidebar hangs relative URLs off the route that rendered it, and Avito
  // writes some of them without the `www`. Both are the same site; a host that
  // is not the site is not a category.
  const normalizeUrl = (value, base) => {
    const parsed = new URL(String(value || ''), base);
    if (parsed.protocol !== 'https:' || !/^(www\.)?avito\.ru$/.test(parsed.hostname)) {
      throw new Error('category URL is outside www.avito.ru');
    }
    parsed.hostname = 'www.avito.ru';
    parsed.hash = '';
    return parsed;
  };

  // Hop one: the category navigation of the URL the caller passed. The target is
  // resolved from the state Avito itself rendered, so no category route is built.
  const source = await readDocument(requestedUrl, 'source', env);
  if (source.failure) return source.failure;
  const sourceState = source.payload?.data;
  if (!sourceState || typeof sourceState !== 'object') {
    if (source.challenge) {
      return fail('source', 'access', source.documentTitle || 'Avito access challenge', { status: source.status });
    }
    return fail('source', source.parseErrors ? 'parse' : 'missing', 'Avito SSR bootstrap has no search state');
  }

  const sourceCore = sourceState.searchCore;
  if (!sourceCore || typeof sourceCore !== 'object' || Array.isArray(sourceCore)) {
    return fail('source', 'shape', 'Avito SSR state has no valid searchCore');
  }
  if (Number(sourceCore.page) !== 1) {
    return fail('selection', 'argument', 'avito move-category accepts page-1 search URLs');
  }
  const sourceResponseUrl = normalizeUrl(source.responseUrl, env.location.origin);

  const rawSideNodes = sourceState.rubricators?.side?.nodes;
  if (!Array.isArray(rawSideNodes)) {
    return fail('source', 'shape', 'Avito category sidebar has an unexpected shape');
  }

  const candidates = [];
  const blocked = [];
  const sourceQuery = cleanText(sourceCore.query);
  // The sidebar has never been observed dropping the query; the check stays because
  // the day it does, the answer would look like a legitimately wider page.
  const registerCandidate = (name, url) => {
    if (sourceQuery !== '' && cleanText(url.searchParams.get('q')) !== sourceQuery) {
      blocked.push({ categoryName: name, role: 'dropsQuery' });
      return;
    }
    candidates.push({ categoryName: name, categoryUrl: url.href });
  };
  let nodeCount = 0;
  const collectSideNodes = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) {
      throw new Error('Avito category sidebar exceeds its supported nesting depth');
    }
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error('Avito category sidebar contains a malformed node');
      }
      if (++nodeCount > MAX_SIDE_NODES) {
        throw new Error('Avito category sidebar contains implausibly many nodes');
      }
      if (sidebarRole(node.type) === null || !Array.isArray(node.children)) {
        throw new Error('Avito category sidebar node has an unsupported shape');
      }
      const name = cleanText(node.name);
      if (!name || name.length > MAX_NAME_LENGTH) {
        throw new Error('Avito category sidebar node has no usable name');
      }
      // What a node's route is worth is decided the same way in both commands
      // that read this sidebar; see src/browser/prelude/rubricator.mjs.
      const url = String(node.url ?? '').trim();
      const target = url === '' ? null : normalizeUrl(url, sourceResponseUrl.href);
      if (isFollowableNode(node.type, target, sourceResponseUrl.pathname)) {
        registerCandidate(name, target);
      } else {
        blocked.push({
          categoryName: name,
          role: target === null ? 'routeless' : 'current',
          hasChildren: node.children.length > 0,
        });
      }
      collectSideNodes(node.children, depth + 1);
    }
  };

  try {
    collectSideNodes(rawSideNodes, 0);
  } catch (error) {
    return fail('source', 'shape', String(error?.message || error));
  }

  const visibleNames = [...new Set(candidates.map((entry) => entry.categoryName))];
  const matches = candidates.filter((entry) => comparableText(entry.categoryName) === comparableText(target));
  if (matches.length === 0) {
    const blockedMatch = blocked.find((entry) => comparableText(entry.categoryName) === comparableText(target));
    if (blockedMatch) {
      const reason = blockedMatch.role === 'current'
        ? 'is the route this search is already on; moving there is not a move'
        : blockedMatch.role === 'routeless'
          ? 'is a sidebar row Avito hangs no route on'
            + (blockedMatch.hasChildren ? '; move to one of its children instead' : '')
          : 'is reachable only through a route that drops the search query "' + sourceQuery + '",'
            + ' which would return an unrelated category listing instead of this search.'
            + ' Categories that keep the query: '
            + (visibleNames.slice(0, 40).join(', ') || 'none on this route');
      return fail('selection', 'argument', 'category "' + blockedMatch.categoryName + '" ' + reason);
    }
    return fail(
      'selection',
      'argument',
      'category "' + target + '" is not reachable from this search URL. Visible categories: '
      + (visibleNames.slice(0, 40).join(', ') || 'none')
      + (visibleNames.length > 40 ? ', …' : ''),
    );
  }
  const targets = [...new Set(matches.map((entry) => entry.categoryUrl))];
  if (targets.length !== 1) {
    return fail(
      'selection',
      'argument',
      'category "' + target + '" matches ' + targets.length
      + ' different Avito routes on this page; no route is chosen for you',
    );
  }
  const targetUrl = new URL(targets[0]);

  // Hop two: the category Avito named. Its own SSR state carries the postconditions,
  // so nothing about the move is assumed.
  const moved = await readDocument(targetUrl.href, 'target', env);
  if (moved.failure) return moved.failure;
  const movedState = moved.payload?.data;
  if (!movedState || typeof movedState !== 'object') {
    if (moved.challenge) {
      return fail('target', 'access', moved.documentTitle || 'Avito access challenge', { status: moved.status });
    }
    return fail('target', moved.parseErrors ? 'parse' : 'missing', 'Avito SSR bootstrap has no state for the target category');
  }

  const resultCore = movedState.searchCore;
  const resultCatalog = movedState.catalog;
  const resultSections = movedState.filtersV2?.Sections;
  if (
    !resultCore || typeof resultCore !== 'object'
    || !resultCatalog || typeof resultCatalog !== 'object'
    || !Array.isArray(resultSections)
  ) {
    return fail('target', 'shape', 'Avito SSR state of the target category is malformed');
  }

  let resultUrl;
  try {
    resultUrl = normalizeUrl(moved.responseUrl, env.location.origin);
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }
  if (resultUrl.pathname !== targetUrl.pathname) {
    return fail('postcondition', 'drift', 'Avito answered the category move with a different route');
  }
  if (Number(resultCore.page) !== 1) {
    return fail('postcondition', 'drift', 'Avito returned an unexpected page for the target category');
  }
  const locationId = Number(resultCore.locationId);
  const searchLocation = cleanText(resultCore.locationName);
  if (!Number.isInteger(locationId) || locationId <= 0 || !searchLocation) {
    return fail('postcondition', 'shape', 'Avito searchCore has an invalid location after the move');
  }
  // The city and the text query belong to the search, not to the category, so both must
  // survive a move; the filters deliberately may not, they are owned by the category.
  if (cleanText(resultCore.query) !== sourceQuery) {
    return fail(
      'postcondition',
      'drift',
      'Avito dropped the search query while moving the category, which would return an unrelated listing',
    );
  }
  if (!Number.isInteger(Number(sourceCore.locationId)) || Number(sourceCore.locationId) !== locationId) {
    return fail('postcondition', 'drift', 'Avito changed the location while moving the category');
  }
  if (!resultCore.params || typeof resultCore.params !== 'object' || Array.isArray(resultCore.params)) {
    return fail('postcondition', 'shape', 'Avito searchCore params are malformed after the move');
  }
  const resultParamEntries = Object.entries(resultCore.params);
  if (resultParamEntries.length > MAX_PARAMS) {
    return fail('postcondition', 'shape', 'Avito searchCore has an implausible params count');
  }

  // The move is proved; the rows are asked for separately, because the SSR
  // catalog of the target route ships only its first twenty cards in full (F-089).
  const apiUrl = new URL(ITEMS_API_PATH, env.location.origin);
  try {
    carrySearchCore(apiUrl, resultCore, MAX_PARAM_VALUES, null);
    sealItemsApiUrl(apiUrl, movedState, true);
  } catch (error) {
    return fail('target', 'shape', String(error?.message || error));
  }

  const api = await readItemsApi(apiUrl, moved.responseUrl, env);
  if (api.failure) return api.failure;
  const apiState = itemsApiState(api.data);
  if (apiState.failure) return apiState.failure;

  const driftedField = preservedCoreDrift(resultCore, apiState.core, [
    ...PRESERVED_CORE_FIELDS, 'locationId', 'metroId', 'districtId',
  ]);
  if (driftedField) {
    return fail('postcondition', 'drift', 'Avito changed preserved search field ' + driftedField);
  }
  if (Number(apiState.core.page) !== 1) {
    return fail('postcondition', 'drift', 'Avito items API returned an unexpected page');
  }
  if (!apiState.core.params || typeof apiState.core.params !== 'object' || Array.isArray(apiState.core.params)) {
    return fail('postcondition', 'shape', 'Avito items API searchCore params are malformed');
  }
  const driftedParam = preservedParamsDrift(resultParamEntries, apiState.core.params);
  if (driftedParam) {
    return fail('postcondition', 'drift', 'Avito changed preserved params[' + driftedParam + ']');
  }
  let apiPathname;
  try {
    apiPathname = normalizeUrl(apiState.url, env.location.origin).pathname;
  } catch (error) {
    return fail('postcondition', 'shape', String(error?.message || error));
  }
  if (apiPathname !== targetUrl.pathname) {
    return fail('postcondition', 'drift', 'Avito items API answered on a different route');
  }

  const decodedItems = decodeCatalogRows(apiState.catalog, env);
  if (decodedItems.failure) return decodedItems.failure;
  if (decodedItems.rows.length === 0) {
    return fail('catalog', 'empty', 'The target Avito category has no listings');
  }

  return {
    success: true,
    resultSearchLocation: searchLocation,
    resultSearchUrl: resultUrl.href,
    resultRows: decodedItems.rows,
  };
}
