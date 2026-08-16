/**
 * The browser halves of `avito get-item`.
 *
 * This is the one command that renders a page, and it does so only after the
 * item API has failed. Two functions, in the order they are tried:
 *
 *   readItemApi    one same-origin JSON read of /items/ads{pathname}
 *   readItemPage   the rendered listing, read twice over: first the hydration
 *                  state it still carries, then the visible DOM
 *
 * Neither throws for something Avito is allowed to answer. `readItemApi`
 * reports what came back and lets the node half decide; the shared decoder
 * returns `null` for an item it cannot trust, which is this command's way of
 * saying "fall through to the page" rather than "stop".
 *
 * The primed origin is never scanned for challenge text: `robots.txt` lists
 * `captcha` in its own `Clean-param` directives, so a detector run against it
 * reports a challenge that is not there (F-044). Challenge text is read where
 * it is real — in the API response, and in the rendered page.
 */

import { decodeBuyerItemInBrowser } from '../browser/item.mjs';
import { looksLikeChallenge } from '../browser/document.mjs';

export async function readItemApi(input, env) {
  const { requestUrl, expectedItemId } = input;

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
    decodedBuyerItem: decodeBuyerItemInBrowser(payload?.buyerItem, expectedItemId, env),
  };
}

export function readItemPage(input, env) {
  const { expectedItemId } = input;
  const { document } = env;
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const pageText = document.title + '\n' + document.body.innerText;
  const itemTitleNode = document.querySelector('h1');
  // The marked node holds exactly the number the page prints; its own content
  // attribute carries the base price, so only its text is read. The surrounding
  // container stays a fallback and may hold more than one number.
  const itemPriceNode = document.querySelector('[data-marker="item-view/item-price"]')
    || document.querySelector('#bx_item-price-value');
  const itemDescriptionNode = document.querySelector('#bx_item-description');
  // The page prints the same string the item API ships, prefixed with a middot.
  const itemDateNode = document.querySelector('[data-marker="item-view/item-date"]');
  const itemAddressNode = document.querySelector('#item-view-address');
  const attributePairs = {};

  for (const paragraph of document.querySelectorAll('#bx_item-params li p')) {
    const labelNode = paragraph.querySelector(':scope > span');
    const attributeLabel = clean(labelNode?.textContent).replace(/:\s*$/, '');
    if (!attributeLabel) continue;

    const clone = paragraph.cloneNode(true);
    clone.querySelector(':scope > span')?.remove();
    const attributeValue = clean(clone.textContent);
    if (attributeValue && !(attributeLabel in attributePairs)) {
      attributePairs[attributeLabel] = attributeValue;
    }
  }

  const descriptionParts = itemDescriptionNode
    ? [...itemDescriptionNode.querySelectorAll('p')].map((node) => clean(node.textContent)).filter(Boolean)
    : [];
  const observedLocationText = itemAddressNode
    ? [...itemAddressNode.querySelectorAll('p span')]
      .map((node) => clean(node.textContent))
      .find(Boolean) || null
    : null;
  const hydrationBuyerItem = env.window.__staticRouterHydrationData
    ?.loaderData?.['catalog-or-main-or-item']?.buyerItem;

  return {
    accessBlocked: looksLikeChallenge(pageText),
    itemUnavailable: /объявление (?:снято|удалено|заблокировано)|страница не найдена|такой страницы нет/i.test(pageText),
    observedDocumentTitle: document.title,
    decodedHydrationItem: decodeBuyerItemInBrowser(hydrationBuyerItem, expectedItemId, env),
    domObservedTitle: clean(itemTitleNode?.textContent),
    domPriceContainerPresent: !!itemPriceNode,
    domObservedPriceText: clean(itemPriceNode?.textContent),
    domObservedLocation: observedLocationText,
    domObservedDescription: descriptionParts.join('\n') || null,
    domObservedAttributes: attributePairs,
    domObservedPublishedText: clean(itemDateNode?.textContent).replace(/^[·•]\s*/, '') || null,
  };
}
