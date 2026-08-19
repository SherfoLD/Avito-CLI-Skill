# Command layout

One file is the command, and the CDP boundary is drawn as narrowly as it can be:

```
src/commands/<name>.mjs   arguments, the request, the postconditions, the row
src/schemas/*.mjs         what Avito answers with, one file per response
src/site/*.mjs            Avito knowledge that runs in Node: decoders, request
                          builders, the URL rules
src/browser/              only what a browser is needed for
```

Everything that decides anything is Node, because Node can use `zod` and the
page cannot: a serialized function carries none of its imports, so a guard
written in the page is a schema nobody can read and no offline suite reaches
(D-069).

What is left in the page is a same-origin `fetch` with the user's cookies and a
real DOM. Two entry points cover most of it —
`src/browser/commands/carriers.mjs` reads one SSR document and hands over the
state that was inside it, or fetches one URL the node half built and hands over
the JSON. Reach for those before writing a page half of your own; write one only
when you need something a fetch cannot give you, and then it fetches and decides
nothing. Shared page code goes in `src/browser/prelude/`, inlined into **every**
call by `src/runtime/browser-prelude.mjs` under two rules `src/browser/README.md`
states.

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
run: async (page, args) => {
  // 1. Validate everything that can be validated without the network.
  const requestedUrl = requestedSearchUrl(args.searchUrl);   // throws ArgumentError

  // 2. Prime the origin. The body is never read, and it is never text-scanned
  //    for a challenge — robots.txt contains the word `captcha` itself (F-044).
  await primeOrigin(page, COMMAND);

  // 3. One same-origin read from page context, decoded against a schema. A
  //    refusal from the page becomes one of the five typed errors here.
  const { state, responseUrl } = await readDocument(page, {
    requestUrl: requestedUrl,
    stage: 'schema',
    keep: ['url', 'searchCore'],
    schema: EXAMPLE_DOCUMENT,
    subject: 'Avito SSR example state',
    command: COMMAND,
  });

  // 4. Check the postconditions before decoding, against the carrier that
  //    actually proves application.
  assertPreserved(state.searchCore, requestedUrl, responseUrl);

  // 5. Decode. Pure function, same one the offline suite exercises.
  const rows = decodeRows(state);
  if (rows.length === 0) throw new EmptyResultError(COMMAND);
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

`src/browser/` is the one place that cannot do this — it is serialized into the
page and carries none of its imports — which is why nothing there decodes at
all. A page half reports what came back, as an `{ success: false, stage, code,
message }` envelope or the payload itself, and `src/site/carriers.mjs` turns
that into a typed error or a decoded value.

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
| API-first detail with a hydration fallback | `get-item` |
| A feed keyed off another response | `get-seller-reviews` |
| Name and directory resolvers | `get-location`, `get-coords` |

## Things that bite

- **Name an intermediate shape after itself, not after the row.** `suggested*`
  in `get-location` exists for this: a carrier that shares its key names with the
  columns is one rename away from being mistaken for output. The schema will
  catch the mistake now, but the reader still has to tell the two apart.
- **The browser-side script is a module, not a template string.** No
  double-escaping of regexes, no marker comments for the harness to find, and
  `import` instead of textual surgery. See `src/browser/README.md` for the two
  rules the prelude enforces on anything shared.
- **The four listing commands are one row and one request builder.** `search`,
  `get-page`, `apply-filters` and `move-category` share `src/site/card.mjs`,
  `src/site/listing.mjs` and `src/site/items.mjs`. A change in any of the three
  is a change to four commands, and all four offline suites have to run.
- **Anchor on `data-marker`, never on class names or visible text.** CSS-module
  class names carry build hashes. Visible text, `aria-label`, `title` and
  `placeholder` are all locale-dependent — a selector written against Russian
  labels silently matches nothing the day the browser language changes, and
  "matches nothing" degrades into empty rows rather than an error. If you must
  match text, fail closed with a typed error when nothing matches.
- **Timeouts are per command, not copied.** Measure the endpoint you are actually
  calling and set the budget from what you measured. An intermittent timeout is
  recorded as a risk in the domain file, not hidden behind a retry.
