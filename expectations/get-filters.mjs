import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/mebel_i_interer/myagkaya-mebel/divany-ASgBAgICAkRaqgKMvg2ArjU'];

// The count is the check. A filter is returned if and only if `apply-filters`
// can set the key, so a filter becoming applicable or stopping is exactly what
// this number moves on — and it moves for a reason that belongs in the commit.
export const output = z.looseObject({
  filters: z.array(z.looseObject({})).length(31),
});
