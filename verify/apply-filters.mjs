import { z } from '../src/runtime/schema.mjs';

export const args = [
  'https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb',
  '--set',
  'params[159478]=18629557,18629487;user=2',
];

export const rows = z.array(z.looseObject({
  descriptionPreview: z.string().min(1),
  price: z.number().positive(),
})).min(1).max(50);
