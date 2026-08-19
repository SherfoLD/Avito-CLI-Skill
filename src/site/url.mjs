/**
 * Avito URLs, on the two sides they arrive from.
 *
 * A URL the caller passed is an argument: it may be spelled `avito.ru`, and a
 * bad one is theirs to fix. A URL Avito answered with is data: it has to be the
 * canonical host exactly, and anything else is drift that stops the call. The
 * two are separate functions because they raise separate errors, and mixing
 * them once turned an Avito redirect into an argument error.
 */

import { ArgumentError, CommandExecutionError } from '../runtime/errors.mjs';

export const AVITO_ORIGIN = 'https://www.avito.ru';
const AVITO_HOSTS = new Set(['avito.ru', 'www.avito.ru']);

/** A search URL as an argument, canonicalized to the host the CLI speaks about. */
export function requestedSearchUrl(value, label = 'searchUrl') {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError(`${label} must be a non-empty Avito catalog or search URL`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError(`${label} must be a valid absolute URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new ArgumentError(`${label} must use ${AVITO_ORIGIN}`);
  }

  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed.href;
}

/**
 * A URL Avito answered with, as a `URL`. `base` is the response it was found
 * in, because the category sidebar hangs relative routes off it and writes some
 * of them without the `www`.
 *
 * A port or credentials make it a different origin, and the answer becomes the
 * next call's argument: what `requestedSearchUrl` refuses to take, this refuses
 * to hand over.
 */
export function answeredUrl(value, subject, base = AVITO_ORIGIN) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''), base);
  } catch {
    throw new CommandExecutionError(`Avito returned an invalid ${subject}`);
  }
  if (
    parsed.protocol !== 'https:'
    || !AVITO_HOSTS.has(parsed.hostname)
    || parsed.port
    || parsed.username
    || parsed.password
  ) {
    throw new CommandExecutionError(`Avito returned a ${subject} outside ${AVITO_ORIGIN}`);
  }
  parsed.hostname = 'www.avito.ru';
  parsed.hash = '';
  return parsed;
}
