import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: scripts/lib/ → scripts/ → root. */
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export const VERIFY_DIR = path.join(PROJECT_ROOT, 'verify');
export const FIXTURES_DIR = path.join(PROJECT_ROOT, 'evidence');
export const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');

export function relativeToRoot(absolute) {
  return path.relative(PROJECT_ROOT, absolute).replaceAll(path.sep, '/');
}
