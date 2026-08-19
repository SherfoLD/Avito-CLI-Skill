/**
 * `filtersV2` — the shape of the filter tree, never the meaning of a value.
 * Which types are ranges, which take several values, which serialize bare is
 * vocabulary, and it belongs to the command applying them.
 *
 * The tree is recursive: a filter may carry other filters in `content`, and a
 * nested one is as applicable as a top-level one. Depth and width are not
 * declared here — a bound on those is a judgement about plausibility, and it
 * lives with the walk that enforces it.
 */

import { z } from '../runtime/schema.mjs';
import { RANGE_VALUE, SCALAR, SEARCH_CORE } from './search-core.mjs';

/**
 * One selectable option. Avito spells both halves of the pair two ways, and
 * which one arrives is the option's business, not a caller's.
 */
export const FILTER_OPTION = z.looseObject({
  name: SCALAR.nullish(),
  title: SCALAR.nullish(),
  value: SCALAR.nullish(),
  id: SCALAR.nullish(),
});

export const FILTER = z.looseObject({
  id: SCALAR.nullish(),
  type: SCALAR.nullish(),
  defaultTitle: SCALAR.nullish(),
  dimension: SCALAR.nullish(),
  // A range answers `{from, to}`, everything else a value or a list of them.
  currentValue: z.union([RANGE_VALUE, SCALAR, z.array(SCALAR)], {
    error: 'must be {from, to}, a value, or a list of values',
  }).nullish(),
  // Either a flat option list or a list of named groups, each holding options.
  // Avito repeats a popular option in more than one group of the same control,
  // so a repeat is one option; the two forms mixed in one array is drift, and
  // that is a rule about the set rather than about an entry (F-060).
  values: z.array(z.union([z.looseObject({ options: z.array(FILTER_OPTION) }), FILTER_OPTION])).nullish(),
  get content() { return z.array(FILTER).nullish(); },
});

export const FILTER_SECTION = z.looseObject({
  Filters: z.array(FILTER),
});

/** What the page hands over for `avito get-filters`. */
export const FILTER_STATE = z.looseObject({
  url: SCALAR.nullish(),
  searchCore: SEARCH_CORE,
  filtersV2: z.looseObject({
    Sections: z.array(FILTER_SECTION).nullish(),
  }).nullish(),
});
