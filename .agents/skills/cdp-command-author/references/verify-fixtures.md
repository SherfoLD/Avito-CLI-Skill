# Verify fixtures

`verify/<command>.json` is the only check in this repository that looks at real
values coming back from Avito. The offline suites see synthetic carriers, so they
cannot tell a correct decoder from one reading the wrong field. Every command has
one; `npm run check:fixtures` fails if it does not.

## What it pins, and what it must not

It pins **shape and invariants**. It never pins content: listings churn, prices
move, sellers appear and vanish, so equality against a recorded row would fail
every day for the wrong reason.

```json
{
  "args": ["ddr5 32gb", "--location-id", "637640"],
  "expect": {
    "rowCount": { "min": 1, "max": 50 },
    "columns": ["itemId", "title", "price"],
    "types": { "price": "number|null", "imagesPreviews": "array" },
    "patterns": { "url": "^https://www\\.avito\\.ru/[^?]+_\\d+$" },
    "notEmpty": ["itemId", "title", "url"],
    "mustNotContain": { "url": ["?", "context="] },
    "mustBeTruthy": ["price"]
  }
}
```

`args` is either an argv array — use this when the command takes a positional
subject — or an object of named flags expanded to `--key value`.

## Seeding, then tightening

Seed it from one real run. That gives you `rowCount`, `columns` and `types`, and
nothing else — deliberately, because a rule generated from one observation
documents that observation rather than the contract.

Then tighten by hand. A fixture with only the seeded fields will pass against
almost any output; `npm run check:fixtures` warns when it sees one.

**`patterns`** — formats you can state independently of the values. An ID that is
digits. A date in ISO 8601. A URL on the right host with the right shape. Derive
these from the visible page, not from the code you just wrote (see
`silent-failures.md` §2).

**`notEmpty`** — the fields that cannot be empty on *any* row. This is stricter
than it sounds, and it is where the reasoning happens.

**`mustNotContain`** — the bleed you actually observed. `url` must not contain
`?` or `context=` because a leaked opaque context is the specific way that column
has broken before.

**`mustBeTruthy`** — numeric columns, to catch a `|| 0` fallback that `types` and
`notEmpty` both pass.

**`rowCount`** — a real range. `{min: 1, max: 50}` says a page is a page. It will
not catch rows going missing, which is the accepted price of returning Avito's
whole page rather than a fixed count (D-022).

## The rule about `notEmpty` and `mustBeTruthy`

Both apply to **every row at once**. So no field that is nullable by contract can
appear in either, on a command that returns a full page.

`sellerName` is the standing example. It was in `notEmpty` until an anonymous
session turned out to receive no private-seller identity at all; even a page
filtered to companies had 2 rows of 50 without a name. The rule came out and
cannot go back (D-028), which means `sellerName` is now defended by no live check
at all — only the offline suite and human eyes. That is written down as a risk in
`_platform.md` rather than papered over.

The inverse mistake is just as real: `descriptionPreview` was *not* in `notEmpty`,
and that is why `get-page` returning it as `null` on every row went unnoticed
while three commands quietly disagreed about the same listing (F-041).

So the question for each column is precise: *is there any legitimate row where
this is empty?* If no, it belongs in `notEmpty`. If yes, it cannot be there, and
you should know what else defends it.

## When a fixture fails

Check the value against the visible page **first**. Then:

- **Value is right, rule failed** → the rule is too tight. Loosen it, and say in
  the commit why the looser rule still catches what it was written for.
- **Value is wrong** → the command is wrong. Fix the command. Do not touch the
  fixture.
- **`missing column "X"`** → either the response no longer carries it or your
  args changed the shape. Find out which before editing anything.
- **A column is always `null`** → the field path is wrong. Back to decoding.

The default assumption is the second one. A fixture that gets relaxed whenever it
fires stops being a check and becomes a record of what the code currently does.

## Editing a fixture legitimately

One reason: **Avito itself changed shape**. A URL format migration, a renamed
key, a filter that became applicable.

When that happens, the fixture edit and the evidence land in the same commit:
the new expectation in `verify/`, the anonymised sample in `fixtures/`, and the
consequence in the domain file with a fact number if it is a fact anyone will
need again. What you observed goes in the commit message.

Worked example: the `get-filters` fixture went from 25 to 30 rows in one session.
That was not drift and not a relaxation — five dimensional `numericRange` filters
became applicable because the command learned to serialise a range, so five rows
that had been correctly absent were now correctly present. The commit says so.

## Fixtures are not evidence samples

`verify/` holds expectations. `fixtures/` holds anonymised full response samples
for offline comparison and replay. They are different things with different
lifetimes: a verify fixture is maintained forever, an evidence sample is dated
and never edited.
