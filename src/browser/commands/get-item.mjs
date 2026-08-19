/**
 * The browser halves of `avito get-item`.
 *
 * This is the one command that renders a page, and it does so only after the
 * item API has failed. Two functions, in the order they are tried:
 *
 *   readItemApi    one same-origin JSON read of /items/ads{pathname}
 *   readItemPage   the same object out of the hydration state the rendered
 *                  listing still carries
 *
 * Neither throws for something Avito is allowed to answer, and neither decodes:
 * both report what came back and hand the `buyerItem` over as Avito sent it.
 * What the node half makes of it — including `null` for an item it cannot trust,
 * which is this command's way of saying "fall through to the page" — is decided
 * there, against a schema.
 *
 * The primed origin is never scanned for challenge text: `robots.txt` lists
 * `captcha` in its own `Clean-param` directives, so a detector run against it
 * reports a challenge that is not there (F-044). Challenge text is read where
 * it is real — in the API response, and in the rendered page.
 */

import { looksLikeChallenge } from '../prelude/document.mjs';

export async function readItemApi(input, env) {
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
    responseOk: response.ok,
    responseStatus: response.status,
    responseContentType,
    responseParseError,
    accessChallenge: response.status === 429
      || Boolean(payload?.['too-many-requests'] || payload?.firewallCaptcha || payload?.captcha)
      || (responseParseError && looksLikeChallenge(responseText.slice(0, 4000))),
    redirectCode: payload?.redirectCode ?? null,
    redirectUrl: payload?.redirectUrl ?? null,
    buyerItem: payload?.buyerItem ?? null,
  };
}

export function readItemPage(input, env) {
  const { document } = env;
  const pageText = document.title + '\n' + document.body.innerText;
  const hydrationBuyerItem = env.window.__staticRouterHydrationData
    ?.loaderData?.['catalog-or-main-or-item']?.buyerItem;

  return {
    accessBlocked: looksLikeChallenge(pageText),
    itemUnavailable: /объявление (?:снято|удалено|заблокировано)|страница не найдена|такой страницы нет/i.test(pageText),
    observedDocumentTitle: document.title,
    buyerItem: hydrationBuyerItem ?? null,
  };
}
