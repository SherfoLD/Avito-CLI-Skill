/**
 * The two reads every catalog command makes, and the whole of what runs in the
 * page for them.
 *
 * One fetches an Avito document and hands over the state that was inside it;
 * the other fetches one URL the node half built and hands over the JSON. Neither
 * chooses, checks or decodes anything: what a carrier means is decided in Node,
 * against a schema (D-069).
 *
 * Both are serialized on their own, so neither may reach for a constant in this
 * file — only the prelude crosses with them.
 */

import { fail } from '../prelude/refusal.mjs';
import { readDocument } from '../prelude/document.mjs';

/**
 * `keep` is the list of top-level state keys the caller wants; without it the
 * whole state crosses. Naming them is how a command that reads filters avoids
 * paying for a catalog it will not look at — the choice is the node half's, and
 * nothing here interprets the keys.
 */
export async function readDocumentState(input, env) {
  const { requestUrl, stage, keep } = input;

  const document = await readDocument(requestUrl, stage || 'document', env);
  if (document.failure) return document.failure;

  const state = Array.isArray(keep)
    ? Object.fromEntries(keep.map((key) => [key, document.state[key]]))
    : document.state;

  return {
    success: true,
    responseUrl: document.responseUrl,
    // Avito answers the public `?q=` route with a redirect payload that names
    // the canonical target beside the state rather than inside it. An empty one
    // names nothing, and the caller has a second carrier to fall through to.
    redirect: typeof document.bootstrap.redirect === 'string' && document.bootstrap.redirect
      ? document.bootstrap.redirect
      : null,
    state,
  };
}

/** One request to a URL Node built. A refusal or `{ data }`; never retried. */
export async function readItemsApi(input, env) {
  const { requestUrl, referrer } = input;

  if (new URL(requestUrl).origin !== env.location.origin) {
    return fail('api', 'shape', 'the items API request is not same-origin');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  let data;
  try {
    response = await env.fetch(requestUrl, {
      credentials: 'include',
      referrer,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Source': 'client-browser',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      return fail('api', 'parse', 'Avito items API returned malformed JSON', { status: response.status });
    }
  } catch (error) {
    return fail('api', 'transport', String(error?.message || error));
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429 || data?.['too-many-requests'] || data?.firewallCaptcha || data?.captcha) {
    return fail('api', 'access', 'Avito rate limit or access challenge', { status: response.status });
  }
  if (!response.ok || response.status !== 200) {
    return fail('api', 'http', 'Avito items API request failed', { status: response.status });
  }
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    return fail('api', 'content_type', 'Avito items API response is not JSON');
  }
  return { success: true, data };
}
