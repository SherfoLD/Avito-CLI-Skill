/**
 * The browser half of `avito get-location`: one question about the homepage,
 * because a homepage that is a challenge means every directory read after it
 * answers the wrong thing.
 *
 * Scanning is legitimate here for the same reason it is forbidden elsewhere:
 * F-044 is about a *primed origin*, whose `robots.txt` carries `captcha` in its
 * own `Clean-param` directives. This is a rendered page that was asked for.
 */

import { looksLikeChallenge } from '../browser/document.mjs';

export async function readAccessState(input, env) {
  const title = env.document.title || '';
  return {
    blocked: looksLikeChallenge(`${title}\n${env.document.body?.innerText || ''}`),
    title,
  };
}
