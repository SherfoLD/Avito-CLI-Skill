/**
 * One same-origin JSON GET, reported rather than judged.
 *
 * The challenge check has to happen here because it needs the raw body. A
 * challenge arrives three ways — a `429`, one of three JSON flags, or an HTML
 * page where JSON was expected — and only the last is still visible before the
 * text is thrown away. It is applied to this response and never to a primed
 * origin: `robots.txt` lists `captcha` in its own `Clean-param` directives and
 * would match every time (F-044).
 *
 * A transport failure returns `{ requestError }` alone, with no
 * `responseStatus` to mistake for a zero.
 */

import { looksLikeChallenge } from './document.mjs';

export async function readJsonResponse(input, env) {
  const { requestUrl } = input;

  let response;
  try {
    response = await env.fetch(requestUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return { requestError: error instanceof Error ? error.message : String(error) };
  }

  const responseContentType = response.headers.get('content-type') || '';
  const responseText = await response.text();
  let payload = null;
  let responseParseError = false;
  try {
    payload = JSON.parse(responseText);
  } catch {
    responseParseError = true;
  }

  return {
    responseStatus: response.status,
    responseContentType,
    responseParseError,
    accessChallenge: response.status === 429
      || Boolean(payload?.['too-many-requests'] || payload?.firewallCaptcha || payload?.captcha)
      || (responseParseError && looksLikeChallenge(responseText.slice(0, 4000))),
    payload,
  };
}
