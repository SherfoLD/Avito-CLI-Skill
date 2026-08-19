import { z } from '../src/runtime/schema.mjs';

export const args = ['ddr5 32gb', '--location-id', '637640'];

// Avito accepts a location it does not apply, so the region it reports back is
// the postcondition worth pinning: everything under `items` is a plausible page
// whichever region answered.
//
// `descriptionPreview` is nullable by contract and non-null on every item of a
// real catalog page: the flat carrier is empty in SSR, so a null here means the
// visible decoder stopped being read (F-041).
export const output = z.looseObject({
  locationId: z.literal('637640'),
  items: z.array(z.looseObject({
    descriptionPreview: z.string().min(1),
    price: z.number().positive(),
    // This route is goods, where Avito prices every card with one number: nothing
    // here is priced by a table, and nothing is advertised from a floor.
    minPrice: z.null(),
    hasPriceList: z.literal(false),
  })).min(1).max(50),
});
