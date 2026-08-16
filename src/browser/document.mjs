/**
 * Reading an Avito SSR document, and the guards around a search URL.
 *
 * Every command that needs schema, filters or a catalog reads it the same way:
 * one same-origin `fetch`, parse the HTML, pull `loaderData` out of the state
 * script. The catalog is never rendered — after hydration the live DOM carries
 * neither `script[data-mfe-state]` nor `searchCore`.
 */

import { fail } from './refusal.mjs';

export const DOCUMENT_TIMEOUT_MS = 20000;

/**
 * Text that means Avito is asking for a human rather than answering.
 *
 * Never run this over a primed origin: `robots.txt` contains the word `captcha`
 * in its own `Clean-param` directives, so it matches every time (F-044). It
 * belongs on a response to a request for data and on a rendered page, nowhere
 * else.
 */
export function looksLikeChallenge(text) {
  return /captcha|доступ ограничен|провер.{0,3}что вы человек|проблема с ip|слишком много запросов/i
    .test(String(text ?? ''));
}

export function normalizeSearchUrl(value, env) {
  const parsed = new URL(String(value || ''), env.location.origin);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.avito.ru') {
    throw new Error('result URL is outside www.avito.ru');
  }
  parsed.hash = '';
  return parsed.href;
}

/**
 * Fetch one document and report what came back without deciding what it means:
 * `{ failure }`, or the bootstrap payload plus what the caller needs to classify
 * a missing one — whether the body reads as a challenge, how many state scripts
 * failed to parse, the status, and the URL the response came from.
 *
 * `forceFresh` bypasses the HTTP cache for the single bounded
 * bootstrap-recovery retry and for nothing else.
 */
export async function readDocument(url, stage, env, { forceFresh = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCUMENT_TIMEOUT_MS);
  let response;
  let html;
  try {
    response = await env.fetch(url, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
      cache: forceFresh ? 'reload' : 'default',
      signal: controller.signal,
    });
    html = await response.text();
  } catch (error) {
    return { failure: fail(stage, 'transport', String(error?.message || error)) };
  } finally {
    clearTimeout(timer);
  }

  const parsed = new env.DOMParser().parseFromString(html, 'text/html');
  const text = [parsed.title, parsed.body?.innerText || ''].join('\n');
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

  let payload = null;
  let parseErrors = 0;
  for (const script of [...parsed.querySelectorAll('script[data-mfe-state="true"]')]
    .filter((script) => script.type === 'mime/invalid')) {
    try {
      const candidate = JSON.parse(script.textContent || '')?.loaderData;
      if (candidate) {
        payload = candidate;
        break;
      }
    } catch {
      parseErrors += 1;
    }
  }
  return {
    payload,
    parseErrors,
    challenge: looksLikeChallenge(text),
    documentTitle: parsed.title,
    status: response.status,
    responseUrl: response.url || url,
  };
}
