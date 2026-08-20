import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb',
  '--to',
  'Все категории',
];

// The city and the text query belong to the search and must survive the move;
// the filters belong to the category and may not (D-033). This pins the whole
// URL because it is short enough to read, and because a move that dropped the
// query would land on a plain category browse that looks like a wider page.
//
// The two numbers on the envelope are about this page and not about the result
// set behind it, so they are checked against the listings that came back: the
// count exactly, the median by the range it was taken from. On this route every
// card carries a price, which is why the median is required to be one.
export const output = z.looseObject({
  searchUrl: z.literal('https://www.avito.ru/moskva?cd=1&q=ddr5+32gb'),
  query: z.literal('ddr5 32gb'),
  category: z.literal('Все категории'),
  itemsCount: z.number().int().positive(),
  medianPrice: z.number().positive(),
  items: z.array(z.looseObject({
    price: z.number().positive(),
  })).min(1).max(50),
}).refine(
  (answer) => answer.itemsCount === answer.items.length,
  'itemsCount must be the number of listings the answer carries',
).refine((answer) => {
  const prices = answer.items.map((entry) => entry.price).filter((price) => price != null);
  return prices.length === 0
    ? answer.medianPrice === null
    : answer.medianPrice >= Math.min(...prices) && answer.medianPrice <= Math.max(...prices);
}, 'medianPrice must sit inside the prices of the listings the answer carries');
