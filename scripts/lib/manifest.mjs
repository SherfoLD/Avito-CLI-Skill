/**
 * In-memory command manifest, built by importing every command module.
 *
 * Every check script reads it through here, so a command that fails to import
 * is a hard error rather than a silently missing entry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_ROOT } from './paths.mjs';

const COMMANDS_DIR = path.join(PROJECT_ROOT, 'src', 'commands');

export class ManifestImportError extends Error {
  constructor(filePath, cause) {
    super(`failed to load ${path.relative(PROJECT_ROOT, filePath)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ManifestImportError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

export function commandSourceFiles() {
  if (!fs.existsSync(COMMANDS_DIR)) return [];
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((entry) => entry.endsWith('.mjs') && !entry.startsWith('_') && !entry.includes('.test.'))
    .sort()
    .map((entry) => path.join(COMMANDS_DIR, entry));
}

/**
 * Load every command descriptor. Returns manifest entries carrying the
 * descriptor fields plus the source path the audit rules read.
 *
 * A file that exists but does not default-export a descriptor is a failure,
 * not a skip: a command that drops out of the manifest also drops out of every
 * gate, which is exactly the silent hole these scripts exist to prevent.
 */
export async function loadManifest() {
  const entries = [];
  for (const filePath of commandSourceFiles()) {
    let module;
    try {
      module = await import(pathToFileURL(filePath).href);
    } catch (error) {
      throw new ManifestImportError(filePath, error);
    }
    const descriptor = module.default;
    if (!isDescriptor(descriptor)) {
      throw new ManifestImportError(
        filePath,
        new Error('default export is not a command descriptor — export defineCommand({...}) as default'),
      );
    }
    entries.push({
      site: descriptor.site,
      name: descriptor.name,
      description: descriptor.description,
      access: descriptor.access,
      domain: descriptor.domain,
      example: descriptor.example ?? null,
      args: descriptor.args.map((arg) => ({ ...arg })),
      output: descriptor.output,
      type: descriptor.type,
      keys: [...descriptor.keys],
      sourceFile: path.relative(PROJECT_ROOT, filePath).replaceAll(path.sep, '/'),
      sourcePath: filePath,
    });
  }
  return entries;
}

function isDescriptor(value) {
  return (
    value != null
    && typeof value === 'object'
    && typeof value.name === 'string'
    && typeof value.site === 'string'
    && Array.isArray(value.keys)
    && Array.isArray(value.args)
  );
}
