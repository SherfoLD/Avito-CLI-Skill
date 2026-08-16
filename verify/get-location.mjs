import { idString, text, z } from '../src/runtime/schema.mjs';

export const args = ['Казань', '--geo', 'metro', '--geo-query', 'Кремл'];

// Every geo column is nullable by contract, because suggestion mode fills none
// of them. In geo mode all four are filled, and the exact-match rule means one
// station and not a Kazan-shaped guess from a neighbouring city.
export const rows = z.array(z.looseObject({
  geoMode: z.literal('metro'),
  geoId: idString(),
  geoName: text(),
  geoGroup: text(),
})).length(1);
