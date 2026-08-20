# Listings — `search`, `get-page`

Confirmed live: 2026-08-18

The shared listing decoder, the item shape and the transport are in
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

Both answer with `{ query, locationId, locationName, searchUrl, itemsCount,
medianPrice, items }` — `search` adds `category` and `get-page` the confirmed
`page`. The URL, the effective region and the category are stated once, on the
envelope, and never repeat inside `items` (D-073). `itemsCount` and `medianPrice`
describe the listings that came back rather than the result set behind them, and
both are taken after `--remove-reserved` shortened the page (D-077).

Request budget for `search`: 4 with no geo and 4 with `--location-id`
(the origin priming, which a warm tab skips, the `?q=` redirect payload, the
canonical SSR document, the items
API); 5 with `--coords` / `--radius`; 6 with `--metro` / `--district`, where the
location directory costs two more. A city cannot be applied by editing a URL, so
any geo goes through the same items API — which every search now ends with in any
case, because the listings are there (D-063). Budget for `get-page`: 3.

## How it works

`search` does not render the catalog. One same-origin read of
`https://www.avito.ru/?q=<query>` returns a pure redirect payload naming the
canonical route; a second read fetches that route, which carries `searchCore`,
`filtersV2` and `context` for the postconditions and for the request that
follows, plus the category sidebar `category` is read from (D-076). The listings come from a third call, to the items API (D-063). The visible
form is not used and the session's region is preserved.

Geo of the route the query landed on is carried into that request and confirmed
as preserved, the same way `apply-filters` treats it — losing it would widen the
search in silence. The one exception is `--location-id`: a metro or district ID
means nothing outside its own location and Avito accepts a foreign one without a
word (F-037), so a requested city discards the landed geo instead of inheriting
it.

The acceptance postcondition: our own `?q=` request landed on a non-homepage
route of `www.avito.ru`, and if `q` survived, it is exactly the requested one.
The homepage is not a search result: its recommendations sit in the same
`[data-marker="catalog-serp"]`, so the presence of a catalog proves nothing on
its own.

`get-page` builds its transition only from the current canonical `searchUrl` and
cross-checks `searchCore.page`, the pathname and every input query pair except
`p`. DOM pagination links are not used: after an SPA location update they keep
the old pathname. That document is what proves the page; its listings are then
asked for separately, and the answer is cross-checked against it field by field
before a single card is decoded.

## Decisions

- **D-012 — Avito generates the URL.** The command accepts only `response.url`;
  opaque `f` / `context` are never synthesised or rewritten. Pagination adds or
  replaces only an integer `p` (`p=1` means removing the parameter).
- **D-018 — submitting is a `?q=` navigation, and a dissolved query is accepted.**
  A `q === query` guard rejected correct Avito results for a whole class of
  queries, and a UI click added flakiness on the first submit. A "the query
  dissolved" marker was not added as its own field: the category route is visible
  in the canonical `searchUrl` already, and `query` on the envelope reads `null`
  where the text dissolved. One bounded
  navigation retry is allowed if the redirect did not complete.
- **D-019 — listings are never scraped from the DOM.** The scrape was deleted
  entirely: rendering the catalog existed only to serve it, and without it a
  query costs light same-origin calls and `search` stops depending on CSS-module
  prefixes.
- **D-063 — the document proves the page, the items API answers it.** All four
  listing commands read listings from `/web/1/js/items` and postconditions from the
  SSR document, because that document's catalog is complete only in its first
  twenty cards (F-089). This is not the ranking in
  `carrier-selection.md` being overturned: the document is still the primary
  carrier and still the only one that can be addressed by URL, so every
  postcondition it proved is kept and the API is cross-checked against it —
  preserved `searchCore` fields, preserved `params[...]`, the page number, and
  the route in the URL it generated. The cost is one extra request per call, and
  the alternative was `get-page` answering with thirty listings out of fifty stripped
  of `descriptionPreview`, `location`, `sellerName` and `imageCount`.

  It also removes a fork inside one command: `search` used to answer from the
  document when it was given no geo argument and from the API when it was, so the
  same query returned two different qualities of listing depending on a flag.
- **D-076 — `search` names the category it landed in, and does it in
  `move-category`'s words.** Three queries land in three different categories and
  their results are not comparable; until now that was inferable only from the
  slug of `searchUrl`. `category` is the name of the node Avito marks as current
  in the sidebar the canonical document already carries, so it costs no request —
  only `rubricators` added to the keys that cross, and the walk that
  `get-categories` and `move-category` already share (D-046, D-071).

  It is a **name and not an ID** because `searchCore.categoryId` names a coarser
  level than the one this CLI navigates (F-096): the ID would not identify the
  name beside it, and nothing accepts it. The name is exactly what
  `move-category --to` takes, so the field an agent reads is the field it passes
  back.

  `null` means Avito placed the search in no category — the sidebar of several
  bold branches (F-084) — and that is the answer, not a gap. A sidebar the walk
  cannot read ends the call instead, before the listings are requested: a `null`
  covering both would say "no category" where the truth is "not read".

  Only `search` and `move-category` have it, and those are the two commands that
  *decide* a category: one when Avito places the query, the other when the caller
  moves it. `get-page` and `apply-filters` change neither — a page is the same
  search deeper, and a filter is drift if it moves `categoryId` — so the category
  of the `searchUrl` they were handed is a fact the caller already holds. Stating
  it again per call would be payload for nothing, so they do not.

- **D-024 — reservation is a flag, not a field.** `--remove-reserved` is a
  declared local predicate over the page that came back, not an Avito filter
  (no server-side reservation filter exists). The three rules are identical in
  all four listing commands: only the flat boolean `catalog.items[].isReserved`
  is read; the page is trimmed but never topped up from the next one; a page
  where everything is reserved is an `EmptyResultError`, and a page where the
  boolean is missing on even one listing stops the command instead of guessing.

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

- **F-079 — a services card carries its whole price list, flat and complete.**
  `catalog.items[].priceList` sits beside `priceDetailed`, not inside an `iva`
  step, and is `{ valuesAll, values, countHint? }` where every entry is exactly
  `{ title, price }` — two strings, no other key, across 26 lists on one route.
  `values` is a prefix of `valuesAll`, `countHint` («Ещё 5 услуг») appears
  exactly when the two differ and names the remainder, so `valuesAll` is the
  whole table rather than a truncation. Titles were unique inside every list;
  lists ran 1 to 27 entries, 7.5 on average, and 16 kB for a page of 50 listings.
  The server-rendered card prints exactly `valuesAll`: the first two entries with
  their prices, the rest as bare titles, then the hint. Found only in Services —
  absent on all 50 cards of electronics, transport, animals, home and garden,
  vacancies, business equipment, flat rentals and flat sales, and on the last two
  every card also carried a plain number: no floor, no phrase, no table. The
  table itself is not returned, only `hasPriceList` beside a null `price` and the
  floor Avito advertised as `minPrice` (D-056): the card's copy of the table is
  the search index's and it disagrees with the one the listing page prints
  (F-081), so the caller who needs the prices reads them with `get-item`.

- **F-088 — a jobs query refuses on a card URL, not on a photo.** `search "резюме
  продавец" --location-id 637640` ends with `Avito catalog contains an invalid
  item URL` (2026-08-18), while `search "продавец"` on the same city returns listings
  and `get-page` on `/moskva/rezume?q=продавец` decodes its fifty. Which card
  carries the URL is not established: the route that would show it answered with
  an access challenge, and a challenge is a full stop. So this is a second jobs
  class, separate from the photo one that left with D-061 (F-087), and unowned
  until someone replays it.
- **F-082 — the daily-rental route is a different product, not an empty
  category.** `/moskva/kvartiry/sdam/posutochno` answers `200` with
  «Авито Путешествия» in the title and carries no `script[data-mfe-state]` at
  all, so there is no catalog to decode and every listing command ends on the
  same absence; a query that lands there (`квартира посуточно`) comes back as
  `EMPTY_RESULT`. Long-term rentals on `/moskva/kvartiry/sdam` and sales on
  `/moskva/kvartiry/prodam` are ordinary catalog routes and read normally, so
  this is one route of real estate rather than the category.

- **F-095 — `location` is null on most cards, and that is not the twenty/thirty
  split.** `avito search "ddr5 32gb" --location-id 637640` through the items API,
  2026-08-19: `descriptionPreview`, `sellerName`, `imageCount`, `published` and
  `price` were non-null on 50 of 50, and `location` was null on 45 of 50. The
  five that carried one were a metro reference with walking time («Китай-город,
  до 5 мин.») or a bare city («Уфа»). So the field is empty because the card
  draws no geo line, not because the carrier was thin: `location` does not belong
  beside the three fields F-089 thins, and a caller reading it as a lost field
  will be wrong nine times in ten.

## Risks

- The consumer must read the canonical `searchUrl` to understand they received a
  category rather than a text search (F-038).
- Reservation is exposed by no field, so a filtered page cannot be told apart
  from a genuinely short Avito page. `--remove-reserved` is mandatory in every
  link of the chain: a missed flag in `get-page`, `apply-filters` or
  `move-category` silently brings the reserved listings back.
- `search` creates a page-1 context only. The region of later pages is preserved
  from the canonical `searchUrl` rather than requested again.
- **The page past the last one answers `429`, and `get-page` calls it a CAPTCHA or
  a rate limit** (F-061). Reproduced on two categories, between successful
  requests to the same routes. A caller who reaches the end of the results gets a
  diagnosis about protection instead of "there are no more pages", and has no way
  to tell the two apart. It is the document that answers `429` there, and the
  document is still what `get-page` reads first, so D-063 did not fix this — but
  the items API answers `200` with an empty catalog at the same boundary (F-091),
  which is the material phase 20 now has to work with.
- Sort order is not an output field, so there is nothing to confirm it with in
  `get-page`. The former guard over four hardcoded Russian labels was deleted — it
  would have killed pagination on a legitimately sorted URL (F-051).
