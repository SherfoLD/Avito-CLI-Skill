# Offline suites

`npm test` runs every suite in `tests/` with no network, no browser and no Chrome.
They are fast, they run on every change, and they are the only checks that can
exercise a failure path — you cannot ask Avito for a malformed response.

What they cannot do is tell you a value is correct. A synthetic carrier contains
what you put in it, so a decoder reading the wrong field passes happily. That is
what the verify fixtures and comparing against the page are for.

## The pieces

`tests/carrier.mjs` holds the synthetic Avito shapes shared by the suites. They
mirror what was confirmed live, and the comments say which fact each shape
encodes — the flat `description` is empty because it is empty in the real SSR
catalog, `item.priceDetailed` holds the base price while the visible price lives
in `iva.PriceStep`, a private seller's card has no `UserInfoStep` at all.

**Keep the carrier honest.** It is the model of Avito that every suite reasons
against, so a shape you soften to make a test pass is a fact you have deleted.
When Avito drifts, the carrier changes together with the domain file.

`tests/harness.mjs` loads a command with its runtime stubbed, provides the small
check runner, and offers `assertDeclaredColumns` — which compares a returned row
against the command's declared `columns`. That one exists because the column list
and the row are two separate places in the source and nothing else compares them;
a key renamed in one of them used to survive until a live verify.

`tests/run.mjs` lists the suites. A new suite is added there or it does not run.

## What a suite should assert

**The navigation budget.** How many requests the command makes and which ones.
This is the assertion that keeps the transport model honest: one `robots.txt`
priming, no rendered catalog page, one document fetch. It is also the one that
would catch a "harmless" retry appearing.

**The decoder against a synthetic carrier.** The real decoder, imported, not a
copy of its logic. A suite that reimplements the decode tests itself.

**Every typed error path.** A `429`. A challenge. A missing bootstrap. A
postcondition that does not hold. A page where every row is filtered out. These
are most of the value: they are cheap here and expensive or impossible live.

**The shapes that are legitimately weird.** A card with no photos yields an empty
array, not a failure. A private seller yields null identity *and* a live rating.
A review with no score keeps `score: null` rather than becoming 0.

**The guard that fires before the network.** Assert that the request never
happened, not just that an error was thrown. "Arguments are validated first" is
only true if nothing went out.

## What a suite must not do

- **Assert on the shape of data the command does not read.** Failing on a carrier
  you ignore is a spare failure mode. When breadcrumbs stopped being read, their
  shape checks went too — and the synthetic carrier now ships a deliberately
  malformed breadcrumb list to prove nothing looks at it.
- **Restate a value the fixture already pins.** Duplication between layers rots.
- **Get weakened to go green.** An assertion is right until proven otherwise. If
  one is genuinely in the way, the thing that changed is the contract, and that
  is a decision with a `D-0xx` number, not an edit.

## Growing the suite

The count is tracked and is not allowed to shrink. Each session that adds
behaviour adds checks; the movement belongs in the commit message, where "141 →
149" is a normal line.

That number is a floor, not a target. Padding it with restatements of the same
assertion buys nothing; the useful additions are failure paths and legitimately
weird shapes.

## DOM in an offline suite

`linkedom` gives a DOM outside a browser, so a decoder that walks HTML can be
exercised here rather than only live. Where a suite needs a real page, freeze the
HTML into a committed fixture rather than fetching it.

A committed HTML fixture is a review artefact, not a scratch dump, so it holds a
higher bar than a raw sample: trim it to what the assertion needs, strip anything
session-bound, and then reverse-validate — break the decoder deliberately and
confirm the suite goes red. A regression guard nobody has seen fail is a guard
nobody has seen work.
