import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb'];

// This route has a category, so exactly one entry is it. What the expectation is
// really here for is the pair of rules that let a caller leave: the category we
// are already on is the only one with no route, and the ancestors above it carry
// theirs with the query on it (D-057).
export const output = z.looseObject({
  query: z.literal('ddr5 32gb'),
  categories: z.array(z.looseObject({}))
    .min(2)
    .max(40)
    .refine(
      (decoded) => decoded.filter((entry) => entry.current).length === 1,
      'exactly one entry is the category this search is in',
    )
    .refine(
      (decoded) => decoded.every((entry) => (entry.targetUrl === null) === entry.current),
      'the current category carries no route, and every other one carries one',
    )
    .refine(
      (decoded) => decoded.some((entry) => entry.role === 'branch' && entry.navigable),
      'the branch above this category can be moved to',
    )
    .refine(
      (decoded) => decoded.every((entry) => entry.preservesQuery !== false),
      'no route on this sidebar drops the text query',
    )
    .refine(
      (decoded) => decoded.every((entry) => (entry.depth === 0) === (entry.parent === null)),
      'every entry below the top names the branch it hangs under',
    ),
});
