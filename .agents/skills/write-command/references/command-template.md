# Command layout

Two files with the same name, and the split is the CDP boundary:

```
src/commands/<name>.mjs          the Node half: arguments, navigation budget,
                                 typed errors, postconditions, the row
src/browser/commands/<name>.mjs  the page half: shipped into the page and run
                                 there, so it fetches and reads the document
```

A third place exists for what the page halves share: `src/browser/prelude/`,
inlined into **every** call by `src/runtime/browser-prelude.mjs`. A helper used
by one command stays in that command's page half.

Which half a decision belongs to follows from what it needs. Anything that needs
`fetch`, the DOM or `location` is the page half. Anything that throws a typed
error, validates an argument or decides what a row is, is the Node half — it can
use `zod`, and the page half cannot, because a serialized function carries none
of its imports.

## The descriptor

```js
import { defineCommand } from '../runtime/command.mjs';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '../runtime/errors.mjs';
import { idString, itemUrl, text, z } from '../runtime/schema.mjs';
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
  row: z.strictObject({
    itemId: idString(),
    title: text(),
    url: itemUrl(),
  }),
  run: async (ctx, args) => { /* … */ },
});
```

The descriptor is the whole contract. `--help` prints it, the checks read it, and
`bin/avito.mjs` parses every row through `row` before printing — so a column that
drifted from what it declares ends the call with a typed error instead of
reaching the caller. `columns` is derived from `row` and is never written by
hand; declaring it is an error.

`help` text on an argument is mandatory because for an agent caller it is the
only documentation that exists — so it says *why*, not just *what*: which flag it
is mutually exclusive with, where its value comes from, what happens if you leave
it out.

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

## Reading what Avito answered

Anything that runs in Node — the command half — decodes Avito's payload with a
schema and `decode`, which turns drift into a `CommandExecutionError` naming the
path that broke:

```js
const COORDS_PAYLOAD = z.object({
  point: z.object({ latitude: LATITUDE, longitude: LONGITUDE }),
  normalizedAddress: requiredText(),
  postalCode: optionalText(),          // absent and blank both read as null
});

const decoded = decode(COORDS_PAYLOAD, payload, 'Avito coords response');
// → "Avito coords response has an unexpected shape — point.latitude: expected number, received string"
```

`src/browser/commands/` and `src/browser/` are the exception and cannot do this: they are
serialized into the page and carry none of their imports, so their guards stay
hand-written. That boundary is the reason a decoder returns a reported shape
rather than throwing — the command turns it into a typed error on the Node side.

A schema replaces a shape check, not a judgement. Whether Avito applied the
location you asked for, whether two nodes both claim to be current, whether the
sort came back downgraded — none of that is a field, and all of it stays as code.

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

- **Name an intermediate shape after itself, not after the row.** The `api*`
  prefix in the card decoder and `suggested*` in `get-location` exist for this: a
  carrier that shares its key names with the columns is one rename away from
  being mistaken for output. The schema will catch the mistake now, but the
  reader still has to tell the two apart.
- **The browser-side script is a module, not a template string.** No
  double-escaping of regexes, no marker comments for the harness to find, and
  `import` instead of textual surgery. See `src/browser/README.md` for the two
  rules the prelude enforces on anything shared.
- **A shared decoder serves four commands.** `search`, `get-page`,
  `apply-filters` and `move-category` return the same row from the same decoder
  (`src/browser/prelude/card.mjs`) through the same schema and mapping
  (`src/site/listing.mjs`). A change in either is a change to four commands, and
  the offline suites for all four have to run.
- **Anchor on `data-marker`, never on class names or visible text.** CSS-module
  class names carry build hashes. Visible text, `aria-label`, `title` and
  `placeholder` are all locale-dependent — a selector written against Russian
  labels silently matches nothing the day the browser language changes, and
  "matches nothing" degrades into empty rows rather than an error. If you must
  match text, fail closed with a typed error when nothing matches.
- **Timeouts are per command, not copied.** Measure the endpoint you are actually
  calling and set the budget from what you measured. An intermittent timeout is
  recorded as a risk in the domain file, not hidden behind a retry.
