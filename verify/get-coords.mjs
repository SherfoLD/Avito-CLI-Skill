import { z } from '../src/runtime/schema.mjs';

export const args = ['Тверь, Советская улица, 11'];

// Avito rewrites an address silently — a missing house number snaps to a
// neighbour, an address in several cities resolves to one of them with no
// ambiguity signal (F-045). This is the whole check: the point it returned is
// this address in this city, and not a plausible one nearby.
export const rows = z.array(z.looseObject({
  address: z.literal('Россия, Тверь, Советская улица, 11'),
  kind: z.literal('house'),
  locality: z.literal('Тверь'),
  postalCode: z.string().regex(/^\d{6}$/),
  // Тверь is north and east of the origin; a zero here is a coordinate nobody read.
  latitude: z.number().positive(),
  longitude: z.number().positive(),
})).length(1);
