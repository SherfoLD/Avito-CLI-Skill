/**
 * Reading an Avito SSR document.
 *
 * Every command that needs schema, filters or a catalog reads it the same way:
 * one same-origin `fetch`, parse the HTML, pull `loaderData` out of the state
 * script. The catalog is never rendered — after hydration the live DOM carries
 * neither `script[data-mfe-state]` nor `searchCore`.
 *
 * The HTML stops here. What crosses to Node is the JSON that was inside it, so
 * there is one HTML parser in this system and it is the browser's own.
 */

import { fail } from './refusal.mjs';

export const DOCUMENT_TIMEOUT_MS = 20000;

/**
 * Text that means Avito is asking for a human rather than answering.
 *
 * Never run this over a primed origin. The `robots.txt` primed with before D-081
 * contains the word `captcha` in its own `Clean-param` directives and matched
 * every time (F-044); the landing page primed with since may genuinely be the
 * block page, and a command that stopped there would never reach the answer that
 * decides. It belongs on a response to a request for data and on a rendered page,
 * nowhere else.
 */
export function looksLikeChallenge(text) {
  return /captcha|доступ ограничен|провер.{0,3}что вы человек|проблема с ip|слишком много запросов/i
    .test(String(text ?? ''));
}

/**
 * Fetch one document and hand over the state that was inside it: `{ failure }`,
 * or `{ status, contentType, responseUrl, title, bootstrap, state }`.
 *
 * A document with no state is a refusal here rather than a value the caller has
 * to classify. Avito serves a verification page as 200 HTML with no state
 * script, which is indistinguishable from a bootstrap that did not arrive — and
 * the two call for the same thing, a person looking at the browser. Nothing
 * reads the page text to tell them apart: the primed origin alone would defeat
 * that (F-044).
 */
export async function readDocument(url, stage, env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);
  let response;
  let html;
  try {
    response = await env.fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    html = await response.text();
  } catch (error) {
    return { failure: fail(stage, 'transport', String(error?.message || error)) };
  } finally {
    clearTimeout(timer);
  }

  const parsed = new env.DOMParser().parseFromString(html, 'text/html');
  if (response.status === 429) {
    return { failure: fail(stage, 'access', parsed.title || 'Avito access challenge', { status: response.status }) };
  }
  if (!response.ok || response.status !== 200) {
    return { failure: fail(stage, 'http', 'Avito SSR request failed', { status: response.status }) };
  }
  // The content type travels in the details because what came back instead of a
  // page is the whole diagnosis.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return { failure: fail(stage, 'content_type', 'Avito SSR response is not HTML', { contentType }) };
  }

  let bootstrap = null;
  let parseErrors = 0;
  for (const script of [...parsed.querySelectorAll('script[data-mfe-state="true"]')]
    .filter((script) => script.type === 'mime/invalid')) {
    try {
      const candidate = JSON.parse(script.textContent || '')?.loaderData;
      if (candidate) {
        bootstrap = candidate;
        break;
      }
    } catch {
      parseErrors += 1;
    }
  }

  const state = bootstrap?.data;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {
      failure: fail(stage, 'no_state', parsed.title || 'Avito answered a page with no state', {
        status: response.status,
        parseErrors,
      }),
    };
  }

  return {
    bootstrap,
    state,
    title: parsed.title,
    contentType,
    status: response.status,
    responseUrl: response.url || url,
  };
}
