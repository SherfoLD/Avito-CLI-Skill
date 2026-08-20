import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb',
  '--page',
  '2',
];

// The page number is the postcondition: Avito canonicalizes what it is given,
// and a page that quietly reset to 1 returns fifty perfectly plausible listings.
// It is pinned twice on purpose — the number Avito confirmed, and the URL the
// next command would page from.
//
// The two numbers on the envelope are about this page and not about the result
// set behind it, so they are checked against the listings that came back: the
// count exactly, the median by the range it was taken from. On this route every
// card carries a price, which is why the median is required to be one.
export const output = z.looseObject({
  page: z.literal(2),
  searchUrl: z.string().regex(/^https:\/\/www\.avito\.ru\/[^#]+(?:[?&])p=2(?:&|$)/),
  query: z.literal('ddr5 32gb'),
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
