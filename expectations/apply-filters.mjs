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
export const output = z.looseObject({
  query: z.literal('ddr5 32gb'),
  locationId: z.literal('637640'),
  locationName: z.literal('Москва'),
  searchUrl: z.string().regex(/[?&]user=2(?:&|$)/),
  items: z.array(z.looseObject({
    descriptionPreview: z.string().min(1),
    price: z.number().positive(),
  })).min(1).max(50),
});
