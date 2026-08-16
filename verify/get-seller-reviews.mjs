import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_detey_i_igrushki/kolyaska_2_v_1_stokke_scoot_2194767053',
  '--sort',
  'date_asc',
];

// Avito serves the feed in fixed pages of 25 and repeats nothing inside one, so
// a duplicate ID means the page was assembled from two responses.
export const rows = z.array(z.looseObject({
  stage: z.enum(['Сделка состоялась', 'Не договорились']),
  authorRole: z.literal('Покупатель'),
  rated: z.string().regex(/^\d{1,2} [а-яё]+( \d{4})?$/),
  itemTitle: z.string().min(1),
  text: z.string().min(1),
  sellerReviewsCount: z.number().positive(),
}))
  .min(1)
  .max(25)
  .refine(
    (decoded) => new Set(decoded.map((row) => row.reviewId)).size === decoded.length,
    'every review on the page is a different review',
  );
