/**
 * `searchCore` — the object both catalog carriers echo, and the authoritative
 * carrier for the five short keys.
 *
 * Read loosely on purpose: Avito adds fields to it that nothing here reads, and
 * a strict object would refuse a page over a key we never look at. What is
 * declared is what a command acts on, and every one of those is a scalar —
 * a non-scalar where a value belongs is drift, not a value.
 */

import { z } from '../runtime/schema.mjs';

/** What Avito sends where a single value belongs. */
export const SCALAR = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A range as every carrier spells it: `{from, to}` and nothing else. Strict
 * because a third side would be a bound this reader does not apply — the one
 * shape here where an unexpected key changes what a filter means (F-063).
 */
export const RANGE_VALUE = z.strictObject({
  from: SCALAR.nullish(),
  to: SCALAR.nullish(),
});

export const SEARCH_CORE = z.looseObject({
  page: SCALAR.nullish(),
  query: SCALAR.nullish(),
  locationId: SCALAR.nullish(),
  locationName: SCALAR.nullish(),
  categoryId: SCALAR.nullish(),
  rootCategoryId: SCALAR.nullish(),
  verticalCategoryId: SCALAR.nullish(),
  priceMin: SCALAR.nullish(),
  priceMax: SCALAR.nullish(),
  owner: SCALAR.nullish(),
  withDeliveryOnly: SCALAR.nullish(),
  localPriority: SCALAR.nullish(),
  sort: SCALAR.nullish(),
  // One filter may hold several values, and Avito sends the single-value case
  // bare rather than as a list of one. A range filter answers here with the same
  // `{from, to}` object it answers with in `filtersV2` (F-063).
  params: z.record(z.string(), z.union([RANGE_VALUE, SCALAR, z.array(SCALAR)]).nullish()).nullish(),
});
