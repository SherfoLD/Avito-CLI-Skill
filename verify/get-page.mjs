import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb',
  '--page',
  '2',
];

// The page number in the returned URL is the postcondition: Avito canonicalizes
// what it is given, and a page that quietly reset to 1 returns fifty perfectly
// plausible listings.
export const rows = z.array(z.looseObject({
  searchUrl: z.string().regex(/^https:\/\/www\.avito\.ru\/[^#]+(?:[?&])p=2(?:&|$)/),
  descriptionPreview: z.string().min(1),
  price: z.number().positive(),
})).min(1).max(50);
