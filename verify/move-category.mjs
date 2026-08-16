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
export const rows = z.array(z.looseObject({
  searchUrl: z.literal('https://www.avito.ru/moskva?cd=1&q=ddr5+32gb'),
  price: z.number().positive(),
})).min(1).max(50);
