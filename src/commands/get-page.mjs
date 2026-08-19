/**
 * `avito get-page` — another result page of a search URL.
 *
 * It applies no filter, chooses no region and constructs no route: every one of
 * those decisions is already inside the URL it was handed, and re-deciding any
 * of them would silently change the search the caller is paging through.
 *
 * The document is what proves the page. Avito canonicalizes the URL it is given,
 * and a search URL that quietly lost a filter still returns fifty perfectly
 * plausible listings — nothing in the listings would show it. So the canonical URL
 * is compared pair by pair against the requested one with `p` excluded, and
 * `searchCore.page` must be the requested number rather than merely a number.
 *
 * The listings come from the items API, which the document's own `searchCore` and
 * `context` address: the SSR catalog carries only its first twenty cards in
 * full, and the same page through the API is complete on all fifty (F-089).
 */

import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { CATALOG_DOCUMENT } from '../schemas/document.mjs';
import { LISTING_ITEM, LISTING_ITEM_TYPE, applyReservedFilter, listingItems } from '../site/listing.mjs';
import { catalogItems } from '../site/card.mjs';
import {
  CATALOG_KEYS,
  primeOrigin,
  readCatalogPage,
  readDocument,
} from '../site/carriers.mjs';
import {
  PRESERVED_CORE_FIELDS,
  addItemsApiPage,
  carrySearchCore,
  coreParamEntries,
  itemsApiUrl,
  itemsApiUrlPage,
  preservedCoreDrift,
  preservedParamsDrift,
  sealItemsApiUrl,
} from '../site/items.mjs';
import { idString, searchUrl as searchUrlField, text, z } from '../runtime/schema.mjs';
import { cleanText, comparableText } from '../site/text.mjs';
import { answeredUrl, requestedSearchUrl } from '../site/url.mjs';

const COMMAND = 'avito get-page';

function normalizePage(value) {
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page <= 0) {
    throw new ArgumentError('page must be a positive safe integer');
  }
  return page;
}

function normalizeBoolean(value, label) {
  if (value == null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new ArgumentError(`${label} must be a boolean flag`);
}

// A pair list of everything except the page number, so the comparison is about
// the search and not about the hop. The NUL join keeps `a=b&c` from comparing
// equal to `a=b&c=` and the sort makes the order Avito's business.
function queryPairsWithoutPage(url) {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== 'p')
    .map(([key, value]) => `${key}\u0000${value}`)
    .sort();
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const OUTPUT = z.strictObject({
  query: text().nullable(),
  locationId: idString(),
  locationName: text(),
  page: z.number().int().positive(),
  searchUrl: searchUrlField(),
  items: z.array(LISTING_ITEM),
});

const OUTPUT_TYPE = `type Output = {
  query: string | null;   // the search this page belongs to; null on a plain category browse
  locationId: string;     // digits only
  locationName: string;
  page: number;           // the page Avito served, proved against its own state before decoding
  searchUrl: string;      // canonical URL of this page
  items: Item[];
};

${LISTING_ITEM_TYPE}`;

export default defineCommand({
  name: 'get-page',
  description: 'Get another result page of a search URL. Returns the same listing fields as avito search',
  access: 'read',
  example: 'avito get-page <searchUrl> --page 2',
  domain: 'www.avito.ru',
  args: [
    { name: 'searchUrl', type: 'string', required: true, positional: true, help: 'Search URL from avito search, apply-filters or move-category, with every filter already applied to it' },
    { name: 'page', type: 'int', required: true, help: 'Positive result-page number' },
    { name: 'remove-reserved', type: 'bool', default: false, help: 'Drop the listings Avito marks as reserved; Avito has no server-side filter for them, so the page comes back shorter' },
  ],
  output: OUTPUT,
  type: OUTPUT_TYPE,
  run: async (page, args) => {
    const sourceUrl = new URL(requestedSearchUrl(args.searchUrl));
    const requestedPage = normalizePage(args.page);
    const removeReserved = normalizeBoolean(args['remove-reserved'], 'remove-reserved');

    const targetUrl = new URL(sourceUrl.href);
    // Page 1 is the URL without `p` — asking for `p=1` is a different URL that
    // Avito canonicalizes back, so the postcondition below would fail on a page
    // that was in fact correct.
    if (requestedPage === 1) targetUrl.searchParams.delete('p');
    else targetUrl.searchParams.set('p', String(requestedPage));

    await primeOrigin(page, COMMAND);

    const document = await readDocument(page, {
      requestUrl: targetUrl.href,
      stage: 'document',
      keep: CATALOG_KEYS,
      schema: CATALOG_DOCUMENT,
      subject: 'Avito SSR page state',
      command: COMMAND,
    });

    const resultUrl = answeredUrl(document.responseUrl, 'canonical page URL');
    if (resultUrl.pathname !== sourceUrl.pathname) {
      throw new CommandExecutionError('Avito changed the preserved search pathname');
    }
    if (!sameList(queryPairsWithoutPage(sourceUrl), queryPairsWithoutPage(resultUrl))) {
      throw new CommandExecutionError('Avito changed preserved search query parameters');
    }
    if (requestedPage === 1 && resultUrl.searchParams.has('p')) {
      throw new CommandExecutionError('Avito did not canonicalize page 1 without p');
    }
    if (requestedPage > 1 && resultUrl.searchParams.get('p') !== String(requestedPage)) {
      throw new CommandExecutionError('Avito returned an unexpected canonical page number');
    }

    const documentCore = document.state.searchCore;
    if (Number(documentCore.page) !== requestedPage) {
      throw new CommandExecutionError('Avito searchCore returned an unexpected page');
    }
    const locationId = Number(documentCore.locationId);
    const searchLocation = cleanText(documentCore.locationName);
    if (!Number.isInteger(locationId) || locationId <= 0 || !searchLocation) {
      throw new CommandExecutionError('Avito searchCore has an invalid location');
    }
    const requestedQuery = sourceUrl.searchParams.get('q');
    if (requestedQuery != null && comparableText(documentCore.query) !== comparableText(requestedQuery)) {
      throw new CommandExecutionError('Avito changed the preserved search query');
    }
    const documentParamEntries = coreParamEntries(documentCore, 'Avito SSR searchCore');

    const apiUrl = itemsApiUrl();
    carrySearchCore(apiUrl, documentCore);
    addItemsApiPage(apiUrl, requestedPage);
    // Page 1 ships a context and a missing one there is drift; a deeper document
    // has no such key at all (F-092).
    sealItemsApiUrl(apiUrl, document.state, requestedPage === 1);

    const api = await readCatalogPage(page, apiUrl, document.responseUrl, COMMAND);

    // Nothing about the page may change on the way to the second carrier: the
    // document already named the search, and the API is being asked for its listings.
    const driftedField = preservedCoreDrift(documentCore, api.searchCore, [
      ...PRESERVED_CORE_FIELDS, 'locationId', 'metroId', 'districtId',
    ]);
    if (driftedField) {
      throw new CommandExecutionError(`Avito changed preserved search field ${driftedField}`);
    }
    if (Number(api.searchCore.page) !== requestedPage) {
      throw new CommandExecutionError('Avito items API returned an unexpected page');
    }
    const driftedParam = preservedParamsDrift(documentParamEntries, api.searchCore.params);
    if (driftedParam) {
      throw new CommandExecutionError(`Avito changed preserved params[${driftedParam}]`);
    }

    const apiAnsweredUrl = answeredUrl(api.url, 'items API URL');
    if (apiAnsweredUrl.pathname !== sourceUrl.pathname) {
      throw new CommandExecutionError('Avito items API answered on a different route');
    }
    if (itemsApiUrlPage(apiAnsweredUrl) !== requestedPage) {
      throw new CommandExecutionError('Avito items API returned an unexpected page number in its URL');
    }

    const decoded = catalogItems(api.catalog);
    if (decoded.length === 0) {
      throw new EmptyResultError(COMMAND, 'The requested Avito result page has no listings');
    }

    // The document's canonical URL, not the API's: this is the URL the next
    // command pages, and the API answers about a route rather than to one.
    return {
      query: cleanText(documentCore.query) || null,
      locationId: String(locationId),
      locationName: searchLocation,
      page: requestedPage,
      searchUrl: resultUrl.href,
      items: listingItems(applyReservedFilter(decoded, removeReserved, COMMAND)),
    };
  },
});
