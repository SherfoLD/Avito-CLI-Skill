# Verify fixtures

`verify/<command>.mjs` is the only check in this repository that looks at real
values coming back from Avito. The offline suites see synthetic carriers, so they
cannot tell a correct decoder from one reading the wrong field. Every command has
one; `npm run check:fixtures` fails if it does not.

## What it pins, and what it must not

The row contract is **not** here. Columns, types, formats and nullability live in
the command's `row` schema, where the CLI enforces them on every run and the
offline suites enforce them too. Restating any of it here is a second copy that
only the live check would consult.

What belongs here is what a schema cannot know: **what this particular request
must come back with.** `avito get-coords "Тверь, Советская улица, 11"` returns a
house in Тверь with a six-digit postal code — no schema can say that, and no
amount of type checking would notice if it started returning Москва.

It still never pins content that churns: listings appear and vanish, prices move,
so equality against a recorded row would fail every day for the wrong reason.

```js
import { z } from '../src/runtime/schema.mjs';

export const args = ['Тверь, Советская улица, 11'];

export const rows = z.array(z.looseObject({
  kind: z.literal('house'),
  locality: z.literal('Тверь'),
  postalCode: z.string().regex(/^\d{6}$/),
})).length(1);
```

`args` is either an argv array — use this when the command takes a positional
subject — or an object of named flags expanded to `--key value`.

`rows` is a schema over the **whole returned array**, not over one row. That is
what lets a fixture say something about the set: a count, a uniqueness rule,
"exactly one of these is the current category". The element is a `looseObject`
because the row already satisfied the command's contract — naming a column here
adds a constraint, it does not re-declare the row, and the columns you do not
name stay visible to a `.refine`.

`npm run check:fixtures` refuses a fixture that names a column the command does
not return, and one that constrains nothing at all.

## Writing one

Run the command once for real, read the rows, and then ask of each thing you see:
**would this still be true if the command answered about the wrong subject?** If
yes, it belongs in the schema or nowhere. If no, it belongs here.

**Per column** — what this request specifically must match. The address it
resolved, the sort it applied, the page number in the returned `searchUrl`.
Formats that hold for every row of every request — an ID that is digits, an ISO
instant, a listing URL — belong in the row schema instead. Derive either from the
visible page, not from the code you just wrote (see `silent-failures.md` §2).

Reach for the tightest thing that is true. `z.literal('house')` beats a regex,
and a regex beats `.min(1)`.

**Over the set** — `.length(n)` when the count is a fact about the route, and
`.refine` for anything the rows have to satisfy together:

```js
.refine((rows) => rows.filter((row) => row.current).length === 1,
  'exactly one row is the category this search is in')
```

A `.min(1).max(50)` range is not one of these. It is true of every page the
command could return, which is why a fixture carrying only that is refused.

**Nullable columns** — a column that is nullable by contract can only be required
here when this request is known to fill it. `price: z.number().positive()` says
this page of DDR5 has a price on every row; the contract still allows a listing
without one.

## The rule about requiring a nullable column

It applies to **every row at once**. So no field that is nullable by contract can
be required here, on a command that returns a full page, unless you know it.

`sellerName` is the standing example. A fixture required it until an anonymous
session turned out to receive no private-seller identity at all; even a page
filtered to companies had 2 rows of 50 without a name. The rule came out and
cannot go back (D-028), which means `sellerName` is defended by no live check at
all — only the offline suite and human eyes. That is written down as a risk in
`_platform.md` rather than papered over.

The inverse mistake is just as real: no fixture required `descriptionPreview`,
and that is why `get-page` returning it as `null` on every row went unnoticed
while three commands quietly disagreed about the same listing (F-041).

So the question for each column is precise: *is there any legitimate row where
this is empty?* If no, require it. If yes, you cannot, and you should know what
else defends it.

## When a fixture fails

Check the value against the visible page **first**. Then:

- **Value is right, rule failed** → the rule is too tight. Loosen it, and say in
  the commit why the looser rule still catches what it was written for.
- **Value is wrong** → the command is wrong. Fix the command. Do not touch the
  fixture.
- **The command exited non-zero with "breaks its own contract"** → the row no
  longer matches its schema. Either the response stopped carrying a field or your
  args changed the shape. Find out which before editing anything.
- **A column is always `null`** → the field path is wrong. Back to decoding.

The default assumption is the second one. A fixture that gets relaxed whenever it
fires stops being a check and becomes a record of what the code currently does.

## Editing a fixture legitimately

One reason: **Avito itself changed shape**. A URL format migration, a renamed
key, a filter that became applicable.

When that happens, the fixture edit and the evidence land in the same commit:
the new expectation in `verify/`, the anonymised sample in `evidence/`, and the
consequence in the domain file with a fact number if it is a fact anyone will
need again. What you observed goes in the commit message.

Worked example: the `get-filters` count went from 25 to 30 rows in one session.
That was not drift and not a relaxation — five dimensional `numericRange` filters
became applicable because the command learned to serialise a range, so five rows
that had been correctly absent were now correctly present. The commit says so.

## Fixtures are not evidence samples

`verify/` holds expectations. `evidence/` holds anonymised full response samples
for offline comparison and replay. They are different things with different
lifetimes: a verify fixture is maintained forever, an evidence sample is dated
and never edited.
