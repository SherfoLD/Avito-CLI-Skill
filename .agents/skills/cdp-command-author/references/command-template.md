# Command layout

Two files per command, and the split is not cosmetic: everything that can be
tested without a browser lives on the other side of it.

```
src/commands/<name>.mjs    navigation, guards, arguments, postconditions
src/decoders/<name>.mjs    pure functions over a payload — no network, no page
```

If a "decoder" needs the network, it belongs in the command. If a guard can be
expressed as a function of a payload, it belongs in the decoder, where a suite
can hit it directly with a synthetic carrier.

## The descriptor

```js
import { defineCommand } from '../runtime/command.mjs';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { decodeRows } from '../decoders/example.mjs';

const ORIGIN_BOOTSTRAP_URL = 'https://www.avito.ru/robots.txt';

export default defineCommand({
  name: 'example',
  description: 'One sentence saying what the caller gets and what to do with it',
  access: 'read',
  domain: 'www.avito.ru',
  example: 'avito example <searchUrl> -f json',
  args: [
    {
      name: 'searchUrl',
      type: 'string',
      required: true,
      positional: true,
      help: 'Search URL from avito search, apply-filters, move-category or get-page',
    },
  ],
  columns: ['itemId', 'title', 'url'],
  run: async (ctx, args) => { /* … */ },
});
```

The descriptor is the whole contract. `--help` prints it, the checks read it, and
`verify/example.json` pins `columns` against it. `help` text on an argument is
mandatory because for an agent caller it is the only documentation that exists —
so it says *why*, not just *what*: which flag it is mutually exclusive with,
where its value comes from, what happens if you leave it out.

The description is written for someone deciding whether to call this command
rather than a neighbouring one. "Get another result page of a search URL.
Returns the same listing columns as avito search" does that; "Paginate" does not.

## The body

```js
run: async (ctx, args) => {
  // 1. Validate everything that can be validated without the network.
  const requestedUrl = normalizeCatalogUrl(args.searchUrl);   // throws ArgumentError

  // 2. Prime the origin. The body is never read, and it is never text-scanned
  //    for a challenge — robots.txt contains the word `captcha` itself (F-044).
  await ctx.goto(ORIGIN_BOOTSTRAP_URL);

  // 3. One same-origin read from page context. No retry.
  const observed = await ctx.evaluate(readCatalog, { requestUrl: requestedUrl });

  // 4. Fail closed on anything that is not the shape we can decode.
  if (!observed.ok) throw asExecutionError(observed);

  // 5. Check the postconditions before decoding, against the carrier that
  //    actually proves application.
  assertPreserved(observed.payload.searchCore, requestedUrl);

  // 6. Decode. Pure function, same one the offline suite exercises.
  const rows = decodeRows(observed.payload);
  if (rows.length === 0) throw new EmptyResultError('example');
  return rows;
},
```

The order matters. Arguments before the network, so a caller's mistake never
costs a request. Postconditions before decoding, so a drifted response never
reaches a decoder that would find something plausible in it.

## Copy the closest neighbour

Do not start from a blank file. Find the existing command that shares the most —
same carrier, same postcondition style, same output shape — and copy it. The
shapes in this repository are:

| Shape | Command |
|---|---|
| SSR catalog read plus a guarded API refinement | `search` |
| Stateless pagination over an immutable URL | `get-page` |
| Many validated filters in one request | `apply-filters` |
| Full SSR schema reader with authoritative current values | `get-filters` |
| Navigation resolved from rendered state, then followed | `move-category` |
| API-first detail with hydration and DOM fallbacks | `get-item` |
| A feed keyed off another response | `get-seller-reviews` |
| Name and directory resolvers | `get-location`, `get-coords` |

## Things that bite

- **Do not reuse a column name for an intermediate variable.** The column-drop
  check reads row literals statically, and an intermediate object that shares a
  key with `columns` confuses it. Name it separately and destructure when
  building the row.
- **The browser-side script is a module, not a template string.** No
  double-escaping of regexes, no marker comments for the harness to find, and
  `import` instead of textual surgery. See `src/browser/README.md` for the two
  rules the prelude enforces on anything shared.
- **A shared decoder serves four commands.** `search`, `get-page`,
  `apply-filters` and `move-category` return the same row from the same decoder.
  A change there is a change to four commands, and the offline suites for all
  four have to run.
- **Anchor on `data-marker`, never on class names or visible text.** CSS-module
  class names carry build hashes. Visible text, `aria-label`, `title` and
  `placeholder` are all locale-dependent — a selector written against Russian
  labels silently matches nothing the day the browser language changes, and
  "matches nothing" degrades into empty rows rather than an error. If you must
  match text, fail closed with a typed error when nothing matches.
- **Timeouts are per command, not copied.** Measure the endpoint you are actually
  calling and set the budget from what you measured. An intermittent timeout is
  recorded as a risk in the domain file, not hidden behind a retry.
