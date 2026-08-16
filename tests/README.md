# Offline checks

No network, no browser, no Chrome. `npm test` runs everything listed in
`run.mjs`.

```sh
npm install    # once, at the repository root — pulls linkedom for a DOM outside a browser
npm test
```

The suites import the real command and decoder source, so they fail as soon as
the implementation drifts. Nothing here is a copy of the code.

## What is here now

- `carrier.mjs` — the synthetic Avito shapes shared by the browser-side suites.
  They mirror what was confirmed live: the visible card text lives in
  `iva.DescriptionStep` while the flat `item.description` is empty in the SSR
  catalog, the shown price in `iva.PriceStep` while `item.priceDetailed` keeps
  the base price, and the visible location line is built from `geo.geoReferences`.
  Keep these in step with the domain files when Avito drifts — a shape softened
  to make a test pass is a fact deleted.
- `run.mjs` — the suite list. A new suite is added here or it does not run, and
  a suite named here but absent fails the run rather than being skipped.
- `harness.mjs` — `loadCommand`, `assertDeclaredColumns` and the check runner.
  The `exportNames` argument is a check in its own right: the suites name the
  helpers they cover, so the boundary between the node half and the browser half
  fails loudly if an export moves.
- `search.flow.test.mjs` — the node half of `search`: navigation budget, the
  arguments handed to the browser context, the guards on the returned
  `searchUrl`, typed errors, the single bounded schema recovery, and geo
  validation running before any search request.
- `search.context.test.mjs` — the browser half: the real function from
  `src/decoders/search.mjs` against a synthetic SSR carrier and a stubbed
  `fetch`. Two document hops, absorbed / preserved / foreign `q`, the homepage
  rejection, `429` and challenges, an empty catalog, exactly one items API
  request, and the API never reached when a guard fails.
- `item.decoder.test.mjs` — the browser half of `get-item`, plus the two checks
  that read source text rather than behaviour.
- `get-page.context.test.mjs` — one document, and the postconditions that prove
  it is the page that was asked for: the canonical URL compared pair by pair
  against the requested one with `p` excluded, `searchCore.page`, page 1 without
  `p`. Then the card decoder and the reservation predicate on the node side.
- `apply-filters.context.test.mjs` — the largest suite, and the one with the most
  to prove: the `;` / `,` / `..` grammar parsed by the command's own parser, each
  Avito filter type serialized its own way, and every selection confirmed against
  both carriers. Most of its checks are about Avito accepting something it did
  not apply.
- `get-filters.test.mjs` — the only suite that is entirely node-side, because
  the command is: the browser half fetches one document and everything that
  decides what a filter is happens outside the page. It pins which keys become
  rows at all, the syntax each advertises, and the applied value written in that
  same syntax.
- `get-categories.test.mjs` — the failure paths a fixture cannot reach: a node
  whose state contradicts its type, two current categories at once, a URL off
  the site. You cannot ask Avito for a malformed sidebar.
- `get-location.test.mjs` — the rules that stop a plausible wrong answer:
  `--geo` needs one *exact* name match, so it cannot list the metro of a
  neighbouring city, and a result larger than `--limit` is refused rather than
  truncated.
- `get-coords.test.mjs` — the node flow and the browser half against a stubbed
  geocoder, plus the source-text check that the primed origin is never scanned
  for a challenge (F-044).
- `move-category.test.mjs` — the sidebar walk and the postconditions of a move:
  a name that is not a navigable row is refused with the names that are, and the
  city and the query must survive a move that is allowed to change the filters.

- `get-seller-reviews.test.mjs` — the two-request flow, the sort confirmed
  against whichever carrier the response happens to have, and the review without
  a score that must stay null.

184 checks in total. The number only ever goes up: an assertion that has to
change is a contract change with a `D-0xx` number, not a test edit.

## What a suite is for

Failure paths, mostly. You cannot ask Avito for a malformed response, a `429` or
a challenge on demand, so those live here — along with the navigation budget
(how many requests, and which), the declared columns against a returned row, and
the shapes that are legitimately strange: a card with no photos, a private seller
with no identity but a live rating, a review with no score.

What a suite cannot do is prove a value is correct. A synthetic carrier contains
what you put into it. That is what `verify/` and comparing against the visible
page are for.

Guidance: [.agents/skills/cdp-command-author/references/offline-suites.md](../.agents/skills/cdp-command-author/references/offline-suites.md).
