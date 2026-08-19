/**
 * Avito's own markup, turned into text.
 *
 * A browser puts a bare fragment into `<body>`; linkedom returns a document
 * without one and `documentElement` comes back null, so what Avito sent gets the
 * wrapper a browser would have added around it.
 */

import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('<html></html>');

export function parseFragment(markup) {
  const document = new DOMParser().parseFromString(
    `<!doctype html><html><body>${markup}</body></html>`,
    'text/html',
  );
  return document.body;
}
