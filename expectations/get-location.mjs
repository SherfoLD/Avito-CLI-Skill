import { idString, text, z } from '../src/runtime/schema.mjs';

export const args = ['Казань', '--geo', 'metro', '--geo-query', 'Кремл'];

// Geo mode resolves the name to exactly one location and then answers about it.
// The exact-match rule is what stops a Kazan-shaped guess from a neighbouring
// city, so the single location matters as much as the single station.
export const output = z.looseObject({
  geoMode: z.literal('metro'),
  locations: z.array(z.looseObject({
    locationId: idString(),
    locationName: z.literal('Казань'),
  })).length(1),
  geo: z.array(z.looseObject({
    geoId: idString(),
    geoName: text(),
    geoGroup: text(),
  })).length(1),
});
