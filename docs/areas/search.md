# Listings — `search`, `get-page`

Confirmed live: 2026-08-16

The shared row decoder, the 12-key shape and the transport are in
[_platform.md](_platform.md).

## Contract

`search <query>` creates the search context and returns the first page. Geo lives
here and only here: `--location-id`, `--metro`, `--district`, `--coords`,
`--radius` answer "where are we searching" and are needed before the first
`searchUrl` exists. Plus `--remove-reserved`. There are no filter flags — all
refinement of an existing listing happens in `apply-filters` (D-031).

`get-page <searchUrl> --page <n>` changes `p` on a copy of the input URL and
nothing else. Plus `--remove-reserved`. The URL it returns carries `p=<n>` and is
therefore only good input for `get-page` and `get-filters`: `apply-filters` and
`move-category` accept page 1 only.

Both return the listing row and the canonical `searchUrl` of the listing they
produced, in every row.

Request budget for `search`: 3 with no geo (`/robots.txt`, the `?q=` redirect
payload, the canonical SSR document); 4 with `--location-id`; 5 with `--coords` /
`--radius`; 6 with `--metro` / `--district`, where the location directory costs
two more. A city cannot be applied by editing a URL, so any geo goes through the
same items API. Budget for `get-page`: 2.

## How it works

`search` does not render the catalog. One same-origin read of
`https://www.avito.ru/?q=<query>` returns a pure redirect payload naming the
canonical route; a second read fetches that route, which is where the rows come
from (`loaderData.data.catalog.items`) along with `searchCore` and `filtersV2`
for the postconditions. The visible form is not used and the session's region is
preserved.

The acceptance postcondition: our own `?q=` request landed on a non-homepage
route of `www.avito.ru`, and if `q` survived, it is exactly the requested one.
The homepage is not a search result: its recommendations sit in the same
`[data-marker="catalog-serp"]`, so the presence of a catalog proves nothing on
its own.

`get-page` builds its transition only from the current canonical `searchUrl` and
cross-checks `searchCore.page`, the pathname and every input query pair except
`p`. DOM pagination links are not used: after an SPA location update they keep
the old pathname.

## Decisions

- **D-012 — Avito generates the URL.** The command accepts only `response.url`;
  opaque `f` / `context` are never synthesised or rewritten. Pagination adds or
  replaces only an integer `p` (`p=1` means removing the parameter).
- **D-018 — submitting is a `?q=` navigation, and a dissolved query is accepted.**
  A `q === query` guard rejected correct Avito results for a whole class of
  queries, and a UI click added flakiness on the first submit. A "the query
  dissolved" marker was not added as its own column: the 12 keys are taken, and
  the category route is visible in the canonical `searchUrl`. One bounded
  navigation retry is allowed if the redirect did not complete.
- **D-019 — rows are read from the SSR catalog.** The DOM scrape was deleted
  entirely: rendering the catalog existed only to serve it, and without it a
  query costs three light calls and `search` stops depending on CSS-module
  prefixes.
- **D-024 — reservation is a flag, not a column.** `--remove-reserved` is a
  declared local predicate over the page that came back, not an Avito filter
  (no server-side reservation filter exists). The three rules are identical in
  all four listing commands: only the flat boolean `catalog.items[].isReserved`
  is read; the page is trimmed but never topped up from the next one; a page
  where everything is reserved is an `EmptyResultError`, and a page where the
  boolean is missing on even one row stops the command instead of guessing.

## Facts

- **F-038 — Avito canonicalises any `?q=` query into a category route**; the only
  difference is whether `q` survives beside it. `ddr5 32gb` keeps it; `iphone` and
  `iphone 13 pro max 256` dissolve into a category or a model with no `q`, and on
  a dissolved listing `searchCore.query` is empty too. So no postcondition over
  state can prove "this is the result of my query", and textual agreement is not
  guaranteed by the contract.
- **F-039 — submitting is one navigation, and the live DOM does not hold the SSR
  state.** `?q=` works from a bare origin, preserves the session region and names
  the canonical route itself. After hydration the landed page has zero
  `script[data-mfe-state]` nodes and no `searchCore`, which is why the schema is
  always read by a separate fetch.
- **F-011 — an empty search contains recommendations outside the catalog.** A
  unique nonsense query yields an empty `catalog-serp` followed by a "similar
  listings nearby and in other cities" block full of unrelated cards. Extracting
  cards across the whole document used to return them as a successful listing;
  now such a query is a typed `EmptyResultError` (exit 66).
- **F-033 — pagination is stateless.** `p=2` on the current canonical URL
  preserves the route and the filters and yields `searchCore.page=2`; `p=1`
  canonicalises with no `p`. The command uses neither DOM links nor the items
  API, and has no retry path.
- **F-048 — reservation arrives as a flat boolean on every catalog card**, but
  Avito offers no reservation filter. There is no badge to read from either: on
  reserved cards `iva.BadgeBarStep` contains ordinary badges and the word
  «Забронировано» appears in no step — the snippet draws the visible plaque from
  that boolean itself. The full text of `filtersV2` on three different routes
  contains neither `reserv` nor `заброн`. The chain catalog → item API → visible
  page agrees: for a card with `isReserved: true` the item API gives
  `deliveryInfo.isReserved: true` and the page shows «Товар зарезервирован».

## Risks

- The consumer must read the canonical `searchUrl` to understand they received a
  category rather than a text search (F-038).
- Reservation is exposed by no column, so a filtered page cannot be told apart
  from a genuinely short Avito page. `--remove-reserved` is mandatory in every
  link of the chain: a missed flag in `get-page`, `apply-filters` or
  `move-category` silently brings the reserved listings back.
- `search` creates a page-1 context only. The region of later pages is preserved
  from the canonical `searchUrl` rather than requested again.
- **The page past the last one answers `429`, and `get-page` calls it a CAPTCHA or
  a rate limit** (F-061). Reproduced on two categories, between successful
  requests to the same routes. A caller who reaches the end of the results gets a
  diagnosis about protection instead of "there are no more pages", and has no way
  to tell the two apart. Taken apart in phase 20.
- Sort order is not an output column, so there is nothing to confirm it with in
  `get-page`. The former guard over four hardcoded Russian labels was deleted — it
  would have killed pagination on a legitimately sorted URL (F-051).
