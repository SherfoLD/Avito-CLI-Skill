/**
 * The browser half of `avito get-categories`: one document read, both carriers
 * returned.
 *
 * `searchCore` travels back with the sidebar because `preservesQuery` compares
 * each node's URL against the query of the search that rendered it, and a
 * sidebar without that search cannot answer it.
 */

import { fail } from '../prelude/refusal.mjs';
import { readDocument } from '../prelude/document.mjs';

export async function readCategoryState(input, env) {
  const { requestUrl } = input;

  const document = await readDocument(requestUrl, 'schema', env);
  if (document.failure) return document.failure;

  const state = document.payload?.data;
  if (!state || typeof state !== 'object') {
    if (document.challenge) {
      return fail('schema', 'access', document.documentTitle || 'Avito access challenge', { status: document.status });
    }
    return fail('schema', document.parseErrors ? 'parse' : 'missing', 'Avito SSR bootstrap carries no page state');
  }

  return {
    success: true,
    responseUrl: document.responseUrl,
    url: state.url ?? null,
    searchCore: state.searchCore ?? null,
    sideNodes: state.rubricators?.side?.nodes ?? null,
  };
}
