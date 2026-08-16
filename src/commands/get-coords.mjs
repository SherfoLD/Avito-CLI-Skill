/**
 * `avito get-coords` — the node half. One address in, one point out; the region,
 * the search context and the radius all belong to `search`.
 *
 * Avito rewrites the request silently: a missing house number snaps to a
 * neighbour, an address existing in several cities resolves to one of them with
 * no ambiguity signal (F-045). That cannot be detected from a single response,
 * so the row carries Avito's own `normalizedAddress`, `kind` and `locality` for
 * the caller to compare against what they asked for.
 */

import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '../runtime/errors.mjs';
import { defineCommand } from '../runtime/command.mjs';
import { AVITO_BASE_URL } from '../site/geo.mjs';
import { readCoords } from '../decoders/get-coords.mjs';

const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';
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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function decodeCoords(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CommandExecutionError('Avito coords response has an unexpected shape');
  }

  const point = payload.point;
  if (!point || typeof point !== 'object' || Array.isArray(point)) {
    throw new CommandExecutionError('Avito coords response has no point');
  }
  const { latitude, longitude } = point;
  if (!finiteNumber(latitude) || !finiteNumber(longitude)) {
    throw new CommandExecutionError('Avito coords response has malformed coordinates');
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new CommandExecutionError('Avito coords response has out-of-range coordinates');
  }

  const address = cleanText(payload.normalizedAddress);
  if (!address) {
    throw new CommandExecutionError('Avito coords response has no normalized address');
  }
  const kind = cleanText(payload.kind);
  if (!kind) {
    throw new CommandExecutionError('Avito coords response has no address kind');
  }

  const components = Array.isArray(payload.components) ? payload.components : [];
  let locality = null;
  for (const component of components) {
    if (cleanText(component?.kind) === 'locality') {
      const name = cleanText(component?.name);
      if (name) locality = name;
    }
  }

  const postalCode = cleanText(payload.postalCode) || null;

  return { address, kind, locality, latitude, longitude, postalCode };
}

export default defineCommand({
  name: 'get-coords',
  description: 'Resolve an address to the coordinate pair avito search needs for --coords and --radius',
  access: 'read',
  example: 'avito get-coords "Тверь, Советская улица, 11" -f json',
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
  columns: ['address', 'kind', 'locality', 'latitude', 'longitude', 'postalCode'],
  run: async (page, args) => {
    const address = normalizeAddress(args.address);

    const endpoint = new URL(COORDS_ENDPOINT, AVITO_BASE_URL);
    endpoint.searchParams.set('address', address);

    try {
      await page.goto(ORIGIN_BOOTSTRAP_URL, { waitUntil: 'load', settleMs: 0 });
    } catch (error) {
      asExecutionError(error, 'opening the Avito API context');
    }

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

    return [decodeCoords(observed.payload)];
  },
});
