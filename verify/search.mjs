import { z } from '../src/runtime/schema.mjs';

export const args = ['ddr5 32gb', '--location-id', '637640'];

// `descriptionPreview` is nullable by contract and non-null on every row of a
// real catalog page: the flat carrier is empty in SSR, so a null here means the
// visible decoder stopped being read (F-041).
export const rows = z.array(z.looseObject({
  descriptionPreview: z.string().min(1),
  price: z.number().positive(),
})).min(1).max(50);
