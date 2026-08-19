import { z } from '../src/runtime/schema.mjs';

// A service seller with hundreds of reviews, read oldest-first: page 1 is then the far
// end of the feed, where the entries no longer move.
export const args = [
  'https://www.avito.ru/moskva/predlozheniya_uslug/zamena_akkumulyatora_macbook_3286794751',
  '--sort',
  'date_asc',
];

// A downgraded sort returns a feed exactly as plausible as the right one, so the
// sort Avito confirmed is pinned here beside the page it served. Avito serves
// the feed in fixed pages of 25 and repeats nothing inside one, so a duplicate
// ID means the page was assembled from two responses.
export const output = z.looseObject({
  itemId: z.literal('3286794751'),
  sort: z.literal('date_asc'),
  page: z.literal(1),
  sellerReviewsCount: z.number().positive(),
  reviews: z.array(z.looseObject({
    stage: z.enum(['Сделка состоялась', 'Не договорились']),
    authorRole: z.enum(['Покупатель', 'Клиент']),
    // The oldest reviews are years old, so every date here carries its year.
    rated: z.string().regex(/^\d{1,2} [а-яё]+ \d{4}$/),
    itemTitle: z.string().min(1),
    text: z.string().min(1),
  }))
    .length(25)
    .refine(
      (decoded) => new Set(decoded.map((entry) => entry.reviewId)).size === decoded.length,
      'every review on the page is a different review',
    ),
});
