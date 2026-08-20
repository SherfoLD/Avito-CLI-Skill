import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/mebel_i_interer/myagkaya-mebel/divany-ASgBAgICAkRaqgKMvg2ArjU'];

// The count is the check. A filter is returned if and only if `apply-filters`
// can set the key, so a filter becoming applicable or stopping is exactly what
// this number moves on — and it moves for a reason that belongs in the commit.
//
// The second rule defends the carrier behind `changesFiltersOnSelect`. It is read
// from Avito's `updatesForm` and from nothing else, so the day that key leaves
// `filtersV2` every filter on every route would quietly answer "changes nothing"
// — a false no, which no offline suite can tell from a true one. Sofas mark
// «Спальное место» and «Слова в описании», so at least one is the live floor.
export const output = z.looseObject({
  filters: z.array(z.looseObject({}))
    .length(31)
    .refine(
      (filters) => filters.some((filter) => filter.changesFiltersOnSelect === true),
      'no filter here rebuilds the form — updatesForm has gone from filtersV2',
    ),
});
