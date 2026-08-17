import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb'];

// This route has a category, so exactly one row is it. What the fixture is
// really here for is the pair of rules that let a caller leave: the row we are
// already on is the only one with no route, and the ancestors above it carry
// theirs with the query on it (D-057).
export const rows = z.array(z.looseObject({}))
  .min(2)
  .max(40)
  .refine(
    (decoded) => decoded.filter((row) => row.current).length === 1,
    'exactly one row is the category this search is in',
  )
  .refine(
    (decoded) => decoded.every((row) => (row.searchUrl === null) === row.current),
    'the current row carries no route, and every other row carries one',
  )
  .refine(
    (decoded) => decoded.some((row) => row.role === 'branch' && row.navigable),
    'the branch above this category can be moved to',
  )
  .refine(
    (decoded) => decoded.every((row) => row.preservesQuery !== false),
    'no route on this sidebar drops the text query',
  )
  .refine(
    (decoded) => decoded.every((row) => (row.depth === 0) === (row.parent === null)),
    'every row below the top names the branch it hangs under',
  );
