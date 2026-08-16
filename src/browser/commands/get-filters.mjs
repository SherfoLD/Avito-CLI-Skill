/**
 * The browser half of `avito get-filters`: the same-origin fetch and nothing
 * else. The schema *is* the answer, so there is no postcondition to check inside
 * the page; what a filter means is decided in Node.
 */

import { fail } from '../prelude/refusal.mjs';
import { readDocument } from '../prelude/document.mjs';

export async function readFilterState(input, env) {
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
    url: state.url ?? null,
    searchCore: state.searchCore ?? null,
    filtersV2: state.filtersV2 ?? null,
  };
}
