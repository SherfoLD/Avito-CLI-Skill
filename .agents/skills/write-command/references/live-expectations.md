# Live expectations

`expectations/<command>.mjs` is the only check in this repository that looks at
real values coming back from Avito. The offline suites see synthetic carriers, so
they cannot tell a correct decoder from one reading the wrong field. Every
command has one; `npm run check:expectations` fails if it does not.

## What it pins, and what it must not

The shape contract is **not** here. Fields, types, formats and nullability live
in the command's `output` schema, where the CLI enforces them on every run and
the offline suites enforce them too. Restating any of it here is a second copy
that only the live check would consult.

What belongs here is what a schema cannot know: **what this particular request
must come back with.** `avito get-coords "Тверь, Советская улица, 11"` returns a
house in Тверь with a six-digit postal code — no schema can say that, and no
amount of type checking would notice if it started returning Москва.

It still never pins content that churns: listings appear and vanish, prices move,
so equality against a recorded listing would fail every day for the wrong reason.

```js
import { z } from '../src/runtime/schema.mjs';

export const args = ['Тверь, Советская улица, 11'];

export const output = z.looseObject({
  kind: z.literal('house'),
  locality: z.literal('Тверь'),
  postalCode: z.string().regex(/^\d{6}$/),
});
```

`args` is either an argv array — use this when the command takes a positional
subject — or an object of named flags expanded to `--key value`.

`output` is a schema over the **whole answer**. Every object in it is a
`looseObject` because the answer already satisfied the command's contract: naming
a field adds a constraint, it does not re-declare it, and the fields you do not
name stay visible to a `.refine`.

`npm run check:expectations` walks the names against the command's own schema —
envelope and list alike — and refuses one that names a field the command does not
return at that path, or that constrains nothing at all.

## The envelope is where the sharpest claims live

The envelope carries what the command *proved*, which is exactly what a live
check exists to test:

```js
export const output = z.looseObject({
  locationId: z.literal('637640'),      // Avito applied the region that was asked for
  page: z.literal(2),                   // and did not quietly reset to page 1
  query: z.literal('ddr5 32gb'),        // and did not dissolve the text into a category
  items: z.array(z.looseObject({ price: z.number().positive() })).min(1).max(50),
});
```

Everything under `items` is a plausible page whichever region answered. The
envelope is what tells them apart, so reach for it first.

## Writing one

Run the command once for real, read the answer, and then ask of each thing you
see: **would this still be true if the command answered about the wrong
subject?** If yes, it belongs in the schema or nowhere. If no, it belongs here.

**Per field** — what this request specifically must match. The address it
resolved, the sort it applied, the page it confirmed. Formats that hold for every
request — an ID that is digits, an ISO instant, a listing URL — belong in the
`output` schema instead. Derive either from the visible page, not from the code
you just wrote (see `silent-failures.md` §2).

Reach for the tightest thing that is true. `z.literal('house')` beats a regex,
and a regex beats `.min(1)`.

**Over a list** — `.length(n)` when the count is a fact about the route, and
`.refine` for anything the entries have to satisfy together:

```js
categories: z.array(z.looseObject({}))
  .refine((entries) => entries.filter((entry) => entry.current).length === 1,
    'exactly one entry is the category this search is in'),
```

A `.min(1).max(50)` range is not one of these on its own. It is true of every
page the command could return, so it needs a named field beside it.

**Nullable fields** — a field that is nullable by contract can only be required
here when this request is known to fill it. `price: z.number().positive()` says
this page of DDR5 has a price on every listing; the contract still allows a
listing without one.

## The rule about requiring a nullable field

It applies to **every element at once**. So no field that is nullable by contract
can be required here, on a command that returns a full page, unless you know it.

`sellerName` is the standing example. It was required until an anonymous session
turned out to receive no private-seller identity at all; even a page filtered to
companies had 2 of 50 without a name. The rule came out and cannot go back
(D-028), which means `sellerName` is defended by no live check at all — only the
offline suite and human eyes. That is written down as a risk in `_platform.md`
rather than papered over.

The inverse mistake is just as real: nothing required `descriptionPreview`, and
that is why `get-page` returning it as `null` on every listing went unnoticed
while three commands quietly disagreed about the same listing (F-041).

So the question for each field is precise: *is there any legitimate element where
this is empty?* If no, require it. If yes, you cannot, and you should know what
else defends it.

## When one fails

Check the value against the visible page **first**. Then:

- **Value is right, rule failed** → the rule is too tight. Loosen it, and say in
  the commit why the looser rule still catches what it was written for.
- **Value is wrong** → the command is wrong. Fix the command. Do not touch the
  expectation.
- **The command exited non-zero with "breaks its own contract"** → the answer no
  longer matches its schema, and the message names the path. Either the response
  stopped carrying a field or your args changed the shape. Find out which before
  editing anything.
- **A field is always `null`** → the field path is wrong. Back to decoding.

The default assumption is the second one. An expectation that gets relaxed
whenever it fires stops being a check and becomes a record of what the code
currently does.

## Editing one legitimately

One reason: **Avito itself changed shape**. A URL format migration, a renamed
key, a filter that became applicable.

When that happens, the edit and the evidence land in the same commit: the new
expectation in `expectations/`, the anonymised sample in `evidence/`, and the
consequence in the domain file with a fact number if it is a fact anyone will
need again. What you observed goes in the commit message.

Worked example: the `get-filters` count went from 25 to 30 in one session. That
was not drift and not a relaxation — five dimensional `numericRange` filters
became applicable because the command learned to serialise a range, so five that
had been correctly absent were now correctly present. The commit says so.

## Expectations are not evidence samples

`expectations/` holds what a live run must satisfy. `evidence/` holds anonymised
full response samples for offline comparison and replay. They are different
things with different lifetimes: an expectation is maintained forever, an
evidence sample is dated and never edited.
