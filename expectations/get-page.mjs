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
export const output = z.looseObject({
  page: z.literal(2),
  searchUrl: z.string().regex(/^https:\/\/www\.avito\.ru\/[^#]+(?:[?&])p=2(?:&|$)/),
  query: z.literal('ddr5 32gb'),
  items: z.array(z.looseObject({
    descriptionPreview: z.string().min(1),
    price: z.number().positive(),
  })).min(1).max(50),
});
