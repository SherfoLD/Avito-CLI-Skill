/**
 * Listing photos as files on disk.
 *
 * Two firsts live here, and both are bounded to this file: it is the only place
 * that writes a file the caller named, and the only request this CLI makes
 * outside the browser session. The photo CDN answers anonymously, with no
 * cookies and `access-control-allow-origin: *` (F-085), so a binary never has to
 * cross the CDP channel.
 *
 * Nothing here converts an image. `*.img.avito.st` picks the format from
 * `Accept`: a browser's header is answered with `image/webp`, an explicit
 * `image/jpeg` with jpeg (F-086). So the request asks for a format the caller
 * can already open, and an answer in any other one stops the command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ArgumentError, CommandExecutionError } from '../runtime/errors.mjs';

const PHOTO_HOST = /(^|\.)img\.avito\.st$/;
const ACCEPTED_TYPES = new Map([['image/jpeg', '.jpg'], ['image/png', '.png']]);
const REQUEST_TIMEOUT_MS = 20000;

/**
 * The caller's directory, checked before anything is fetched: an argument that
 * cannot work fails as an argument rather than halfway through a gallery.
 */
export function assertPhotoDirectory(requestedDirectory) {
  const raw = String(requestedDirectory ?? '').trim();
  if (!raw) throw new ArgumentError('images-dir must be a directory path');
  if (!path.isAbsolute(raw)) throw new ArgumentError('images-dir must be an absolute path');

  let stats;
  try {
    stats = fs.statSync(raw);
  } catch {
    throw new ArgumentError(`images-dir does not exist: ${raw}`);
  }
  if (!stats.isDirectory()) throw new ArgumentError(`images-dir is not a directory: ${raw}`);
  return raw;
}

function photoUrl(value, position, total) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new CommandExecutionError(`photo ${position} of ${total} carries a malformed URL`);
  }
  if (parsed.protocol !== 'https:' || !PHOTO_HOST.test(parsed.hostname) || parsed.port) {
    throw new CommandExecutionError(`photo ${position} of ${total} points outside Avito photo hosting`);
  }
  return parsed.href;
}

/**
 * Write one listing's photos into `<directory>/<itemId>/` and hand back the
 * paths in gallery order. Nothing is written outside that subdirectory and
 * nothing is ever deleted.
 *
 * One unreadable photo ends the call. A gallery missing its third picture is the
 * fallback value this repository does not return, and the text of the listing is
 * one run without the flag away.
 */
export async function savePhotos(urls, { directory, itemId, fetchImpl = fetch }) {
  const targetDirectory = path.join(directory, itemId);
  try {
    fs.mkdirSync(targetDirectory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`creating ${targetDirectory} failed: ${message}`);
  }

  const total = urls.length;
  const files = [];
  for (const [index, url] of urls.entries()) {
    const position = index + 1;
    const source = photoUrl(url, position, total);

    let response;
    try {
      response = await fetchImpl(source, {
        headers: { accept: [...ACCEPTED_TYPES.keys()].join(', ') },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`photo ${position} of ${total} could not be fetched: ${message}`);
    }

    if (response.status !== 200) {
      throw new CommandExecutionError(`photo ${position} of ${total} answered HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const extension = ACCEPTED_TYPES.get(contentType);
    if (!extension) {
      throw new CommandExecutionError(
        `photo ${position} of ${total} came back as ${contentType || 'no content type'}, `
        + `and nothing here converts an image`,
      );
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) {
      throw new CommandExecutionError(`photo ${position} of ${total} came back empty`);
    }

    const file = path.join(targetDirectory, `${String(position).padStart(2, '0')}${extension}`);
    try {
      fs.writeFileSync(file, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`writing ${file} failed: ${message}`);
    }
    files.push(file);
  }
  return files;
}
