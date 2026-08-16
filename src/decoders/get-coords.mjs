/**
 * The browser half of `avito get-coords`: one shared JSON read, plus the one
 * classification only this endpoint makes — Avito saying the address does not
 * exist. That is Avito answering, not failing, and the node half turns it into a
 * typed empty result rather than a nearby city centre.
 */

import { readJsonResponse } from '../browser/json.mjs';

export async function readCoords(input, env) {
  const observed = await readJsonResponse(input, env);
  if (observed.requestError) return observed;
  return {
    ...observed,
    notFound: observed.responseStatus === 404 || String(observed.payload?.status || '') === 'not-found',
  };
}
