import { z } from '../src/runtime/schema.mjs';

// A service seller with hundreds of reviews, read oldest-first: page 1 is then the far
// end of the feed, where the rows no longer move and two of them carry a photo. A feed
// without one leaves the image decoder untested by every live run (F-075).
export const args = [
  'https://www.avito.ru/moskva/predlozheniya_uslug/zamena_akkumulyatora_macbook_3286794751',
  '--sort',
  'date_asc',
];

// Avito serves the feed in fixed pages of 25 and repeats nothing inside one, so
// a duplicate ID means the page was assembled from two responses.
export const rows = z.array(z.looseObject({
  stage: z.enum(['Сделка состоялась', 'Не договорились']),
  authorRole: z.enum(['Покупатель', 'Клиент']),
  // The oldest reviews are years old, so every date here carries its year.
  rated: z.string().regex(/^\d{1,2} [а-яё]+ \d{4}$/),
  itemTitle: z.string().min(1),
  text: z.string().min(1),
  sellerReviewsCount: z.number().positive(),
  images: z.array(z.string().regex(/^https:\/\/\d+\.img\.avito\.st\/image\/1\//)),
}))
  .length(25)
  .refine(
    (decoded) => new Set(decoded.map((row) => row.reviewId)).size === decoded.length,
    'every review on the page is a different review',
  )
  .refine(
    (decoded) => decoded.some((row) => row.images.length > 0),
    'the oldest page of this seller carries reviews with photos',
  );
