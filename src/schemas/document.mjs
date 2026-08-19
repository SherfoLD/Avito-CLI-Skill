/**
 * The SSR state of one Avito document — `loaderData.data`, as the page hands it
 * over.
 *
 * A catalog document is read for two things at once: the search it describes,
 * and the four keys that turn that search into an items API request. `context`
 * is the opaque string Avito issues per page-1 document (F-092); it is declared
 * as a bounded string here so a carrier that stopped being one fails before it
 * is put on a URL.
 */

import { z } from '../runtime/schema.mjs';
import { SCALAR, SEARCH_CORE } from './search-core.mjs';
import { FILTER_SECTION } from './filters.mjs';

export const CATALOG_DOCUMENT = z.looseObject({
  url: SCALAR.nullish(),
  context: z.string().min(1).max(10000).nullish(),
  subscription: z.looseObject({
    visible: SCALAR.nullish(),
    isShowSavedTooltip: SCALAR.nullish(),
    isErrorSaved: SCALAR.nullish(),
    isAuthenticated: SCALAR.nullish(),
  }).nullish(),
  meta: z.looseObject({ proprofile: SCALAR.nullish() }).nullish(),
  searchCore: SEARCH_CORE,
  filtersV2: z.looseObject({
    Sections: z.array(FILTER_SECTION).nullish(),
  }).nullish(),
});

/** The same document, read for the category sidebar rather than for the filters. */
export const SIDEBAR_DOCUMENT = CATALOG_DOCUMENT.extend({
  rubricators: z.looseObject({
    side: z.looseObject({ nodes: z.array(z.unknown()) }).nullish(),
  }).nullish(),
});

/**
 * The `?q=` hop. Avito answers it either with the catalog itself or with a
 * payload that only names the canonical target, so the search state is the one
 * thing this document may not have.
 */
export const QUERY_DOCUMENT = CATALOG_DOCUMENT.extend({
  searchCore: SEARCH_CORE.nullish(),
});
