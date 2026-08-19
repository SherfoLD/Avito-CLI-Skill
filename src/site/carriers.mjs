/**
 * The node side of the two reads a command makes in the page.
 *
 * `src/browser/commands/carriers.mjs` fetches; this decides. A refusal becomes a
 * typed error, a response becomes a decoded value, and the pair that matters
 * most is `access` and `no_state`: a verification page and a document with no
 * state are the same answer — Avito is not serving this session, and a person
 * has to look at the browser.
 */

import {
  AccessError,
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { decode } from '../runtime/schema.mjs';
import { readDocumentState, readItemsApi } from '../browser/commands/carriers.mjs';
import { ITEMS_API_RESPONSE } from '../schemas/items-api.mjs';

// Origin priming only: the body is never read. Rendering a catalog would pull its
// scripts, images and telemetry for the sake of one JSON blob in the markup.
const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';

/** Seconds a page half waits on one request before it aborts. */
const CARRIER_TIMEOUT_SECONDS = 20;

/** The state keys a catalog command reads. What is not named never crosses. */
export const CATALOG_KEYS = ['url', 'context', 'subscription', 'meta', 'searchCore', 'filtersV2'];

/** The same, for the command that reads the category sidebar as well. */
export const SIDEBAR_KEYS = [...CATALOG_KEYS, 'rubricators'];

/** An exception out of the page, which is the transport rather than Avito. */
export function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(action, CARRIER_TIMEOUT_SECONDS);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

export function carrierResult(observed, command) {
  if (!observed || typeof observed !== 'object') {
    throw new CommandExecutionError(`${command} received an invalid result from the page`);
  }
  if (observed.success === true) return observed;

  const message = String(observed.message || `${command} failed`);
  const stage = observed.stage || 'request';
  if (observed.code === 'argument') {
    throw new ArgumentError(message);
  }
  if (observed.code === 'empty') {
    throw new EmptyResultError(command, message);
  }
  if (observed.code === 'transport' && /timed?\s*out|timeout|aborted/i.test(message)) {
    throw new TimeoutError(`${command} ${stage}`, CARRIER_TIMEOUT_SECONDS);
  }
  if (observed.code === 'access' || observed.code === 'no_state') {
    throw new AccessError(`Avito is not answering this session — ${message}`);
  }
  // What came back instead of the answer is the whole diagnosis, so the status
  // and the content type are named rather than folded into the stage.
  if (observed.code === 'http') {
    throw new CommandExecutionError(`${command} ${stage}: Avito answered HTTP ${observed.details?.status ?? 0}`);
  }
  if (observed.code === 'content_type') {
    throw new CommandExecutionError(
      `${command} ${stage}: Avito answered ${observed.details?.contentType || 'an unknown content type'}`,
    );
  }
  throw new CommandExecutionError(`${command} ${stage} failed: ${message}`);
}

/** The same-origin context every read below needs. */
export async function primeOrigin(page, command) {
  try {
    await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
  } catch (error) {
    asExecutionError(error, `opening the Avito same-origin context for ${command}`);
  }
}

/**
 * Read one document and decode the state it carried. Returns the decoded state
 * beside the two things only the response knows: the URL Avito answered on, and
 * the canonical target it names in a redirect payload rather than in the state.
 */
export async function readDocument(page, {
  requestUrl, stage, keep, schema, subject, command,
}) {
  let observed;
  try {
    observed = await page.evaluateWithArgs(readDocumentState, { requestUrl, stage, keep });
  } catch (error) {
    asExecutionError(error, `reading ${subject}`);
  }
  const result = carrierResult(observed, command);
  return {
    responseUrl: result.responseUrl,
    redirect: result.redirect,
    state: decode(schema, result.state, subject),
  };
}

/** Read one items API page, addressed by the document that came before it. */
export async function readCatalogPage(page, apiUrl, referrer, command) {
  let observed;
  try {
    observed = await page.evaluateWithArgs(readItemsApi, { requestUrl: apiUrl.href, referrer });
  } catch (error) {
    asExecutionError(error, 'reading the Avito items API');
  }
  const result = carrierResult(observed, command);
  return decode(ITEMS_API_RESPONSE, result.data, 'Avito items API response');
}

/** The size of the whole result set, however this route spells it. */
export function resultCount(response) {
  return response.count ?? response.totalCount ?? 0;
}
