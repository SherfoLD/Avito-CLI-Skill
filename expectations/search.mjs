import { z } from '../src/runtime/schema.mjs';

export const args = ['ddr5 32gb', '--location-id', '637640'];

// Avito accepts a location it does not apply, so the region it reports back is
// the postcondition worth pinning: everything under `items` is a plausible page
// whichever region answered.
//
// `descriptionPreview` is nullable by contract and non-null on every item of a
// real catalog page: the flat carrier is empty in SSR, so a null here means the
// visible decoder stopped being read (F-041).
//
// The two numbers on the envelope are about this page and not about the result
// set behind it, so they are checked against the listings that came back: the
// count exactly, the median by the range it was taken from. On this route every
// card carries a price, which is why the median is required to be one.
export const output = z.looseObject({
  locationId: z.literal('637640'),
  // Avito places this query in a category of its own, and the name is the one
  // `move-category --to` takes. A null here would mean it placed it in none,
  // which on this route would be Avito drifting rather than a wider search.
  category: z.string().min(1),
  itemsCount: z.number().int().positive(),
  medianPrice: z.number().positive(),
  items: z.array(z.looseObject({
    descriptionPreview: z.string().min(1),
    price: z.number().positive(),
    // This route is goods, where Avito prices every card with one number: nothing
    // here is priced by a table, and nothing is advertised from a floor.
    minPrice: z.null(),
    hasPriceList: z.literal(false),
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
