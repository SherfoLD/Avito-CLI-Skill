/**
 * `/web/1/js/items` — the response the four catalog commands read their listings
 * from.
 *
 * Four carriers travel in it and every one of them is read: `searchCore` proves
 * nothing about the search changed, `filtersV2` confirms a selection, `url` is
 * Avito's own server-generated address of the answer, and `catalog` holds the
 * cards. A response missing any of them is not a page.
 */

import { z } from '../runtime/schema.mjs';
import { SEARCH_CORE } from './search-core.mjs';
import { FILTER_SECTION } from './filters.mjs';

export const ITEMS_API_RESPONSE = z.looseObject({
  searchCore: SEARCH_CORE,
  catalog: z.looseObject({}),
  filtersV2: z.looseObject({
    Sections: z.array(FILTER_SECTION),
  }),
  url: z.string().min(1),
  // Avito spells the size of the whole result set two ways and sends whichever
  // the route uses. Both absent reads as nought, which is the one place a
  // command cannot tell "nothing matches" from "the count went missing".
  count: z.number().int().nonnegative().nullish(),
  totalCount: z.number().int().nonnegative().nullish(),
});
