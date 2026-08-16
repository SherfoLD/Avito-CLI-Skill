import { z } from '../src/runtime/schema.mjs';

export const args = ['https://www.avito.ru/moskva/tovary_dlya_kompyutera/komplektuyuschie/operativnaya_pamyat-ASgBAgICAkTGB~pm7gnYZw?q=ddr5+32gb'];

// Every search URL has a category Avito detected for it, and describing that
// sidebar wrongly is what would send `move-category` at the wrong route. The
// command refuses two current categories on its own; zero is the case only a
// live run can see.
export const rows = z.array(z.looseObject({}))
  .min(2)
  .max(40)
  .refine(
    (decoded) => decoded.filter((row) => row.current).length === 1,
    'exactly one row is the category this search is in',
  );
