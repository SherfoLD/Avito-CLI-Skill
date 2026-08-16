/**
 * Avito's geo directories, read from Node:
 *
 *   /web/1/slocations                    name suggestions
 *   /web/1/search/locations?locationId=  what a location has: metro, districts,
 *                                        and the visible list of radii
 *   /web/2/locations/{metro,districts}   the ID lists themselves
 *
 * `search` validates the geo IDs it was handed against these before it searches,
 * because Avito silently drops an unknown geo ID and silently accepts one
 * belonging to another city (F-037).
 */

import { CommandExecutionError, TimeoutError } from '../runtime/errors.mjs';

export const AVITO_BASE_URL = 'https://www.avito.ru/';

/**
 * `action` names the read in the failure message. Three of these happen before
 * the real work, and without it a caller cannot tell which one broke.
 */
export async function fetchAvitoJson(page, path, params, action) {
  const endpoint = new URL(path, AVITO_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    endpoint.searchParams.set(key, String(value));
  }
  try {
    return await page.fetchJson(endpoint.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timed?\s*out|timeout/i.test(message)) {
      throw new TimeoutError(action, 15);
    }
    throw new CommandExecutionError(`${action} failed: ${message}`);
  }
}

/**
 * Both spellings of the mode are accepted: `search` says `--district` because
 * the request parameter it builds is `district[<n>]`, `get-location` says
 * `--geo districts` because it lists them. Anything else is `null`, so an
 * unimplemented mode cannot silently read the metro directory.
 */
export function geoDirectory(mode) {
  if (mode === 'metro') {
    return { path: '/web/2/locations/metro', collection: 'stations', capability: 'hasMetro' };
  }
  if (mode === 'district' || mode === 'districts') {
    return { path: '/web/2/locations/districts', collection: 'districts', capability: 'hasDistricts' };
  }
  return null;
}

/**
 * Avito nests capability parameters in groups that carry no meaning, and the
 * same parameter has been seen in different groups, so the search is flat.
 */
export function capabilityParameter(payload, id) {
  const groups = payload?.result?.params;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new CommandExecutionError('Avito location capabilities response has an unexpected shape');
  }
  let found = null;
  for (const group of groups) {
    if (!Array.isArray(group?.parameters)) continue;
    for (const parameter of group.parameters) {
      if (parameter?.id === id) found = parameter;
    }
  }
  return found;
}

/**
 * The location descriptor is the parameter whose `id` is `locationId`. It is
 * checked to be the location that was asked about: a descriptor for a different
 * city carries plausible `hasMetro` / `hasDistricts` flags and would silently
 * answer the wrong question.
 */
export function locationDescriptor(payload, locationId) {
  const descriptor = capabilityParameter(payload, 'locationId')?.value;
  if (!descriptor || typeof descriptor !== 'object') {
    throw new CommandExecutionError('Avito location capabilities response has no location descriptor');
  }
  if (String(descriptor.id) !== String(locationId)) {
    throw new CommandExecutionError('Avito returned capabilities for a different location');
  }
  return descriptor;
}

export function locationDisplayName(descriptor, locationId) {
  const name = String(descriptor?.names?.['1'] ?? '').replace(/\s+/g, ' ').trim();
  return name || String(locationId);
}
