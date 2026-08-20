/**
 * `avito get-coords` — the node half. One address in, one point out; the region,
 * the search context and the radius all belong to `search`.
 *
 * Avito rewrites the request silently: a missing house number snaps to a
 * neighbour, an address existing in several cities resolves to one of them with
 * no ambiguity signal (F-045). That cannot be detected from a single response,
 * so the answer carries Avito's own `normalizedAddress`, `kind` and `locality` for
 * the caller to compare against what they asked for.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import {
  decode,
  optionalText,
  requiredText,
  text,
  z,
} from '../runtime/schema.mjs';
import { AVITO_BASE_URL } from '../site/geo.mjs';
import { readCoords } from '../browser/commands/get-coords.mjs';
import { primeOrigin } from '../site/carriers.mjs';

const COORDS_ENDPOINT = '/web/1/coords/by_address';
const MAX_ADDRESS_LENGTH = 300;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asExecutionError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout/i.test(message)) {
    throw new TimeoutError(action, 15);
  }
  throw new CommandExecutionError(`${action} failed: ${message}`);
}

function normalizeAddress(value) {
  const address = cleanText(value);
  if (!address) {
    throw new ArgumentError('address must be a non-empty string');
  }
  if (address.length > MAX_ADDRESS_LENGTH) {
    throw new ArgumentError(`address must be at most ${MAX_ADDRESS_LENGTH} characters`);
  }
  return address;
}

const LATITUDE = z.number().min(-90).max(90);
const LONGITUDE = z.number().min(-180).max(180);

/**
 * What `by_address` answers. The address components are Avito's own vocabulary
 * of place kinds — `locality` is the one this command reads, and an unknown one
 * is simply not it, rather than a shape to refuse.
 */
const COORDS_PAYLOAD = z.object({
  point: z.object({ latitude: LATITUDE, longitude: LONGITUDE }),
  normalizedAddress: requiredText(),
  kind: requiredText(),
  components: z.array(z.object({ kind: optionalText(), name: optionalText() })).default([]),
  postalCode: optionalText(),
});

function decodeCoords(payload) {
  const decoded = decode(COORDS_PAYLOAD, payload, 'Avito coords response');
  // Avito orders components from the widest to the narrowest, so the last
  // named locality is the one this address is in.
  const locality = decoded.components
    .filter((component) => component.kind === 'locality' && component.name)
    .map((component) => component.name)
    .at(-1) ?? null;

  return {
    address: decoded.normalizedAddress,
    kind: decoded.kind,
    locality,
    latitude: decoded.point.latitude,
    longitude: decoded.point.longitude,
    postalCode: decoded.postalCode,
  };
}

const OUTPUT = z.strictObject({
  address: text(),
  kind: text(),
  locality: text().nullable(),
  latitude: LATITUDE,
  longitude: LONGITUDE,
  postalCode: text().nullable(),
});

const OUTPUT_TYPE = `type Output = {
  address: string;            // the address as Avito normalized it, which is not always the one asked for
  kind: string;               // Avito's own precision label: "house", "street", "locality", …
  locality: string | null;
  latitude: number;           // pass both to search --coords
  longitude: number;
  postalCode: string | null;
};`;

export default defineCommand({
  name: 'get-coords',
  description: 'Resolve an address to the coordinate pair avito search needs for --coords and --radius',
  access: 'read',
  example: 'avito get-coords "Тверь, Советская улица, 11"',
  domain: 'www.avito.ru',
  args: [
    {
      name: 'address',
      type: 'string',
      required: true,
      positional: true,
      help: 'Address as a person would type it, for example "Тверь, Советская улица, 11"',
    },
  ],
  output: OUTPUT,
  type: OUTPUT_TYPE,
  run: async (page, args) => {
    const address = normalizeAddress(args.address);

    const endpoint = new URL(COORDS_ENDPOINT, AVITO_BASE_URL);
    endpoint.searchParams.set('address', address);

    await primeOrigin(page, 'get-coords');

    let observed;
    try {
      observed = await page.evaluateWithArgs(readCoords, { requestUrl: endpoint.toString() });
    } catch (error) {
      asExecutionError(error, 'requesting Avito coordinates');
    }

    if (!observed || typeof observed !== 'object') {
      throw new CommandExecutionError('Avito coords request returned an invalid result');
    }
    if (observed.requestError) {
      asExecutionError(new Error(String(observed.requestError)), 'requesting Avito coordinates');
    }
    if (observed.accessChallenge) {
      throw new CommandExecutionError(
        `Avito requires human verification or a rate-limit cooldown (coords API returned HTTP ${observed.responseStatus || 0})`,
      );
    }
    // A not-found address is an empty result, never a silent fall back to a city centre.
    if (observed.notFound) {
      throw new EmptyResultError('avito get-coords', `Avito found no address matching "${address}"`);
    }
    if (observed.responseStatus !== 200) {
      throw new CommandExecutionError(
        `Avito coords API returned HTTP ${observed.responseStatus || 0}`,
      );
    }
    if (!String(observed.responseContentType).toLowerCase().includes('application/json')
      || observed.responseParseError) {
      throw new CommandExecutionError('Avito coords API did not return JSON');
    }

    return decodeCoords(observed.payload);
  },
});
