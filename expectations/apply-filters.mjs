import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb',
  '--set',
  'params[159478]=18629557,18629487;user=2',
];

// Filters narrow a search; they never move it. The query and the region coming
// back unchanged is what says this is the same search, filtered — everything
// under `items` is a plausible page whichever search answered.
//
// `user=2` is a short key, and a short key Avito accepted but did not apply is
// echoed into searchCore with an empty value (F-062); the server URL is where it
// is visible as applied.
//
// The two numbers on the envelope are about this page and not about the result
// set behind it, so they are checked against the listings that came back: the
// count exactly, the median by the range it was taken from. On this route every
// card carries a price, which is why the median is required to be one.
export const output = z.looseObject({
  query: z.literal('ddr5 32gb'),
  locationId: z.literal('637640'),
  locationName: z.literal('Москва'),
  searchUrl: z.string().regex(/[?&]user=2(?:&|$)/),
  itemsCount: z.number().int().positive(),
  medianPrice: z.number().positive(),
  items: z.array(z.looseObject({
    descriptionPreview: z.string().min(1),
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
