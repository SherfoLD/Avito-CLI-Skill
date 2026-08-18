import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/mebel_i_interer/divan_pryamoy_dlya_kuhni_8030214066?context=verify-stripped'];

// `textContent` of a container includes every descendant, so the way these
// columns break is by carrying a neighbouring section rather than by being
// empty. Each list is a bleed that was actually observed.
const free = (...forbidden) => z.string().refine(
  (value) => !forbidden.some((needle) => value.includes(needle)),
  (value) => ({ message: `bled into: ${forbidden.filter((needle) => value.includes(needle)).join(', ')}` }),
);

export const rows = z.array(z.looseObject({
  // The context token in the argument must not survive into the canonical URL.
  url: z.string().regex(/^https:\/\/www\.avito\.ru\/[^?#]+_8030214066$/),
  price: z.number().positive(),
  // A sofa is priced with a number, so its table is empty (F-080).
  priceList: z.array(z.unknown()).length(0),
  sellerRating: z.number().positive(),
  sellerReviewsCount: z.number().positive(),
  // The gallery is read on every run; the files are only written when the run
  // asked for them, and this one does not.
  imageCount: z.number().int().positive(),
  images: z.null(),
  attributes: z.record(z.string(), z.string()).refine(
    (attributes) => Object.keys(attributes).length > 0,
    'this listing prints a characteristics table',
  ),
  description: free('Местоположение', 'Характеристики', 'Узнать больше'),
  location: free('Узнать больше', 'Яндекс'),
})).length(1);
