# Platform — shared by all ten commands

Confirmed live: 2026-08-16

What belongs to no single command: transport, carriers of state, the shared row
decoder, output shape, repository rules. Anything command-specific is in that
command's domain file.

## Transport

The only path to Avito is a browser context the user owns. Anonymous Node fetch
is closed, and nothing here works around that.

- Priming the origin: navigate to `https://www.avito.ru/robots.txt`; the body is
  never read. `search` needs no priming — its own `?q=` navigation is the hard
  load of the origin it needs.
- Every read after priming is a same-origin `fetch` from the browser context,
  not a page render.
- No command repeats a request. `429`, a CAPTCHA, an HTTP refusal, schema drift
  and a failed postcondition all mean stop. The single exception is one bounded
  bootstrap-recovery retry in `search`, with a 2 s backoff.
- Seven undocumented endpoints at runtime: `/web/1/js/items` (`search`,
  `apply-filters`), `/web/1/slocations`, `/web/1/search/locations`,
  `/web/2/locations/{metro,districts}` (`get-location`, `search`),
  `/web/1/coords/by_address` (`get-coords`), `/items/ads{pathname}` (`get-item`,
  `get-seller-reviews`), `/web/7/user/{key}/ratings` (`get-seller-reviews`).
  Every response is validated fail-closed; the shape is treated as
  internal-unstable.

## Carrier of state

A search route hands over everything needed in one SSR document:
`script[type="mime/invalid"][data-mfe-state="true"]` → `loaderData.data`. From
there: `catalog.items` (rows), `searchCore` (postconditions), `filtersV2` (the
filter schema), `rubricators.side.nodes` (the category tree).

After hydration the live DOM **does not contain** that carrier — neither
`script[data-mfe-state]` nor `searchCore`. The schema cannot be read from a
loaded document, only from a separate same-origin SSR fetch.

## Row decoder

One decoder serves `search`, `get-page`, `apply-filters` and `move-category`, so
its drift breaks all four at once.

The visible fields are **not** in the flat item object:

| What the card shows | Where it is read from | The flat field that would mislead |
|---|---|---|
| the large price | `iva.PriceStep[].payload.priceDetailed` | `item.priceDetailed` — the base price |
| the description text | `iva.DescriptionStep[].payload.description` | `item.description` — always empty |
| the location line | `geo.geoReferences[0]` + walking time | `item.location.name` — null on most rows |

The flat fields remain as a fallback, and that is exactly why carrier drift is
dangerous: the command will not fail, it will quietly return different
semantics. The only automatic defence is the mandatory non-empty
`descriptionPreview` in the strict fixtures, and that one does not catch price.

## Output shape

The listing row is exactly 12 keys: `itemId`, `title`, `price`, `location`,
`descriptionPreview`, `published`, `sellerName`, `sellerRating`,
`sellerReviewsCount`, `imagesPreviews`, `url`, `searchUrl`. It is returned by
`search`, `get-page`, `apply-filters` and `move-category`.

- 12 keys is the ceiling, and a column nests no deeper than 1. The slot freed by
  D-038 is occupied by `published` (D-039); a new column is again possible only
  in place of an existing one.
- `searchUrl` repeats in every row: the output is an array of rows with no
  metadata envelope.
- Page size belongs to Avito (50 listings, 25 reviews). No command has a count
  argument.

## Decisions

- **D-001 — private, not public.** The command surface stabilises before any
  thought of publishing it.
- **D-003 — read-only before write.** Favourites and any mutation come only after
  the read-only surface is stable, with their own contract and safeguards.
- **D-004 — evidence before implementation.** Network logic is not written until
  the command has fresh evidence with a replay.
- **D-005 — no secrets stored.** Cookies, tokens and personal fields enter
  neither the repository, nor the fixtures, nor the logs.
- **D-016 — the row is flat.** Nested objects are rejected by the row-shape rule;
  seller type is not derived at all — a live `--seller company` response carried
  a `/user/.../profile` link, so the seller's route does not encode their type.
- **D-020 — `price` is the price with bonuses**, the number Avito prints large on
  the card. The owner's decision. The base price is not exposed as its own
  column: the 12 keys are taken. `get-item` is outside this decision — the
  listing page has its own price semantics and it already agrees (F-043).
- **D-022 — a command returns Avito's whole page.** `--limit` was removed
  everywhere: the request was paid for in full regardless, and the argument only
  threw away rows already received. The price of the decision is that fixtures no
  longer pin an exact row count (`1..50`, `1..25`), so a fixture alone will not
  catch rows appearing or going missing.
- **D-023 — a photo size is never named in code.** Take the largest variant whose
  key parses as `<width>x<height>`; a record with no such key stops the command.
  Hardcoding `208x208` would produce `images: []` on every row the day the key is
  renamed — indistinguishable from a listing with no photos.
- **D-028 — `sellerName` is nullable** in all five commands that return it.
  `null` means "Avito did not send a name", not "there is no seller". The name is
  left exactly as Avito sent it, placeholder `Пользователь` included.
- **D-029 — `imagesPreviews`, not `images`**, in the listing row; `images` stays
  with the full gallery in `get-item` and `get-seller-reviews`. One name stood
  over both catalog previews (`636x636`) and originals (`1280x960`).
- **D-031 — the surface is built for a consuming agent.** Grounds: real agents
  used two commands out of nine, navigating by `description` alone. Hence the
  verb-shaped names of all ten commands, one carrier of state (the canonical
  `searchUrl`), refinement only in `apply-filters`, and no distinction between
  `params[...]` and short keys for the caller. The price was accepted up front:
  the minimal scenario got one call to `/web/1/js/items` longer.
- **D-035 — no fixed gaps between requests.** Four provisional two-second pauses
  were deleted unmeasured on the owner's instruction: the value was chosen by the
  owner rather than by Avito, and no measurement had been made in two days. Only
  the backoff before the single bootstrap-recovery retry in `search` remains.
- **D-038 — `sellerId` removed from all five commands.** The column was pure
  output: no command grouped by it, built a URL from it, or checked a
  postcondition with it, and the review feed travels by a third identifier
  (F-046). Five copies of the seller-route decoder left with the column — that is,
  a whole failure class that belonged to the seller rather than to the category
  (F-057) and that killed an entire call over one card. `sellerName` /
  `sellerRating` / `sellerReviewsCount` stayed: they come from the same payload
  but with their own checks.
- **D-039 — publication date: `published` in the listing row, `publishedText` in
  `get-item`.** Two names, because these are two different quantities, and one
  name over both would repeat the `images` / `imagesPreviews` mistake (D-029). In
  the row: the exact moment from `sortTimeStamp`, ISO 8601 in UTC
  (`2026-08-13T23:15:41Z`) — Avito sends no offset and prints everything in Moscow
  time, so the hour is left to the consumer rather than written into the contract.
  In `get-item`: Avito's own string as-is (`14 августа в 02:15`); parsing it into a
  date would mean inventing a year Avito did not send. A missing `sortTimeStamp`
  yields `null` rather than a stop — starting a new failure class immediately
  after removing one was not worth it; an impossible timestamp shape still stops
  the call.
- **D-026 — the evidence layer is versioned.** What lives there is not draft
  reconnaissance but `verify/` — the only value-level check there is — and the
  anonymised response samples in `fixtures/`, which is what makes "Avito changed"
  demonstrable rather than assumed. Excluded by `.gitignore`: `fixtures/traces/`
  (416 MB, and they may carry session headers), HTML dumps, logs, `.env`, `*.har`.
- **D-044 — attach to a browser the user already runs, never launch one.** The
  transport takes a profile directory (`--browser-profile`, or
  `AVITO_BROWSER_PROFILE`) whose browser has debugging on at
  `chrome://inspect/#remote-debugging`, and reads its socket from
  `DevToolsActivePort`. The `--remote-debugging-port` route is still supported
  and is the wrong default: a browser started for automation carries an empty
  profile, and Avito refuses an empty profile outright (F-068). This is also
  what keeps a `--remote-debugging-port` off the profile that holds the user's
  session, which the DevTools documentation warns against because any local
  process can attach to it.

- **D-045 — the connection outlives the command.** A browser with debugging on
  at `chrome://inspect` asks the person in front of it to approve every client
  that attaches, so connecting per invocation turns a ten-command chain into ten
  modals. A broker process holds the one connection for the session and each
  command talks to it over local HTTP; `avito session status` and `avito session
  stop` make it visible and stoppable, and it closes itself after five idle
  minutes. What is *not* shared is the tab: a tab is still opened and closed per
  command, so no command inherits another's page.
  Two consequences worth stating. The broker speaks a four-operation HTTP
  contract rather than relaying CDP, which keeps it incapable of doing more to
  the browser than a command could, and it is gated by a token in a file only
  the user can read — holding a connection open for convenience must not become
  an open door onto a logged-in session for every process on the machine.
  `AVITO_BROKER=off` restores per-command connections, which is right for a
  browser started with `--remote-debugging-port`, where nothing ever asks.

- **D-047 — there is a third kind of shared code, and it needed its own place.**
  `src/browser/` is what runs inside the page; `src/runtime/` is scaffolding
  that knows nothing about Avito. `get-location` and `search` read the same
  three geo directories — suggestions, a location's capabilities, the ID lists —
  for different reasons, in Node, through plain JSON reads that never have to
  happen in a page. That is knowledge about Avito running outside the browser,
  which fits neither directory, so it lives in `src/site/`. What moved: the JSON
  read with its typed failure, the dig that finds the location descriptor in a
  capabilities response (three identical error messages in two files before
  this), and the endpoint behind a geo mode. What did not: how each command
  judges what it read. The two commands even spell the mode differently on
  purpose — `search --district` because it builds `district[<n>]`,
  `get-location --geo districts` because it lists them — so the shared lookup
  accepts both spellings and says so.

## Facts

- **F-006 — anonymous fetch is closed.** A direct GET of a search page with no
  cookies: `HTTP 429`, `server: QRATOR`, a CAPTCHA. There is no public API path
  for this site; we work only through a browser context the user owns and we do
  not work around the protection.
- **F-040 — a search costs three light requests**, and the SSR catalog reproduces
  the card exactly. `/?q=` returns a pure redirect payload (`loaderData.redirect`
  = `data.url`); the canonical document carries `catalog.items` next to
  `searchCore` and `filtersV2`. After moving the decoder onto the visible
  carriers, every shared card matched the previous DOM output on every field —
  4 requests against 371 network events when rendering the catalog.
- **F-041 — the divergence between commands was real.** Before unification,
  `get-page` returned `descriptionPreview: null` on every row, and
  `get-page` / `apply-filters` disagreed with `search` about the price and the
  location of the same listing. The fixtures did not catch it, because
  `descriptionPreview` was not in `notEmpty`.
- **F-042 — pages past the first carry the same `iva` steps.** All 50 rows of
  page 2 carry `PriceStep` / `DescriptionStep` / `GeoStep`, the flat
  `item.description` is empty on all 50, and 35 rows have a bonus price differing
  from the base one. No separate branch for non-first pages is needed. Incidentally:
  Avito reshuffles part of a page between requests, so comparison against the
  visible listing is only valid by `itemId`, never by position.
- **F-044 — Avito's `robots.txt` itself contains the word `captcha`** (in
  `Clean-param` directives), so a primed origin must not be text-scanned for a
  challenge — the detector would match every time. A challenge is looked for
  where it is visible: in the response to a data request and in the rendered page.
- **F-047 — page size belongs to Avito.** There is no count parameter in the
  listing (50 rows; the UI changes only `p`) and none in the review feed
  (`limit=2` returned 25 records). Checked against the source in passing: an
  empty `imagesPreviews` on 9 of 50 rows is `images: []` in the SSR response
  itself for one seller, not a decoder loss.
- **F-049 — Avito withholds private-seller identity from an anonymous session.**
  In the catalog, `iva.UserInfoStep` arrives as an empty array (14 of 50 and 22
  of 50 rows on two pages); in the item API every profile link is empty and the
  name is replaced with `Пользователь`. The rating survives, which means identity
  and rating come from different carriers and neither can be derived from the
  other. Companies are unaffected and the profile route still answers `200`.
  `apply-filters` goes through the items API and degrades identically, so the
  hiding is done on the data side rather than in one carrier.
- **F-055 — five classes of fail-closed refusal**, each disabling a whole
  category. None of them returns wrong data. The table and the current state are
  in [STATUS.md](../STATUS.md).
- **F-056 — the gaps were removed unmeasured; Avito's limit is unknown.** The
  argument that had been available all along: `apply-filters` makes the same
  SSR → items API pair as `search` and always worked without a gap, and the pause
  in `get-page` sat before its single request and separated nothing. The first
  live run after the removal is the measurement.
- **F-059 — the date lives in the listing row, not on the listing page.** The
  expectation was the opposite. Both row carriers — the SSR catalog and the items
  API — carry `sortTimeStamp` (epoch milliseconds) on 50 rows of 50. The listing
  page carries no machine-readable date at all: not in the item API, not in
  JSON-LD, not in microdata; the epoch `1786662941` does not appear in its
  document even once, and all that exists is the rendered string —
  `item.sortFormatedDate` and the same text in
  `[data-marker="item-view/item-date"]`. Cross-checked on two listings:
  `1786662941000` = `14 августа в 02:15`, `1786630067000` = `13 августа в 17:07`.
  The string is Moscow time even for a listing in Ulyanovsk, so Avito does not
  render the time in the listing's own region. The only numeric time in the item
  API is `finishTime`, which is when the listing comes down, not when it went up.
- **F-061 — a `429` is not always about frequency.** The first refusal after the
  gaps were removed looked like a measurement of the limit: it arrived at the end
  of a dense series, about 37 requests in 106 seconds. But the same call repeated
  the refusal after a seven-minute pause and in the silence between successful
  commands, and what separates the cases is not time but the page: `get-page`
  past the last page of results receives `429` (filtered cars — 28 listings, page
  2 requested; motor oil — 79 listings, page 3 requested), while pages inside the
  range on the same routes pass one after another. The same URL read from a
  long-lived primed tab answers `200` with a full catalog document, so the refusal
  does not belong to the URL. Two consequences. First: the rate limit is still
  unmeasured, and recording that number as a measurement would be a mistake.
  Second: the command's message ("human verification or a rate-limit cooldown")
  hands the caller the wrong diagnosis — taken apart in phase 20.
- **F-057 — a green category proves nothing.** The storefront slug with a dot
  brought down `search` on graphics cards and `apply-filters` on `ddr5 32gb` — in
  Electronics, a category walked twice — because the shape of that slug belongs to
  the seller, not to the category. The F-055 list is sorted by where a defect was
  observed, not by where it lives.
- **F-068 — "проблема с IP" is not about the IP; it is about the profile.**
  Measured on 2026-08-16 on one machine, one address, minutes apart. A Chromium
  launched with `--remote-debugging-port` on a dedicated empty profile primed
  `robots.txt` normally and then got `403` on the `?q=` hop, `content-type:
  text/html`, 27 283 bytes, titled `Доступ ограничен: проблема с IP`. The same
  code against a browser the user had been using all along — debugging turned on
  at `chrome://inspect/#remote-debugging`, socket read from `DevToolsActivePort`
  — got `200` and a 354 950-byte catalog document on the same hop, and
  `verify/search.json` passed on 50 rows. So the refusal page names the wrong
  cause: what Avito refused was a profile with no history, and its own title
  would have sent anyone debugging this at the network. Hence D-044.
- **F-069 — a `403` challenge is reported as an HTTP failure.** Found while
  chasing F-068. `readDocument` tests `429` for a challenge and sends everything
  else that is not `200` down the `http` branch, so a page whose title says it is
  a challenge comes back to the caller as "Avito SSR request failed". The
  `challenge` flag is computed on every document and never consulted, because the
  `http` branch returns first. No data is falsified; the diagnosis is wrong,
  which is the same species of defect as F-061 and belongs with it in phase 20.
  Present in all ten commands, since they share the shape of this reader.
- **F-071 — an unapproved debug prompt is indistinguishable from a dead
  browser.** With debugging on at `chrome://inspect`, the browser accepts the
  TCP connection and then holds the WebSocket handshake open until the person
  approves the client: `curl` with upgrade headers returns nothing at all, and
  the port is listening the whole time. After 30 seconds the transport reports
  "connecting to the browser timed out", which reads as a browser that is gone.
  So `DevToolsActivePort` naming a live port proves the browser is reachable,
  not that a connection will be granted — the difference is a person, and the
  only remedy is to ask for the click, never to reconnect in a loop. Confirmed
  both ways in one session: the same endpoint, the same profile and the same
  code timed out unapproved and connected on the first try once approved.

## Risks

- Browser-side IP blocks (`Доступ ограничен: проблема с IP`, hCaptcha) and `429`
  on the items API recurred across sessions and can recur at any moment. The
  rule: stop without touching the challenge, do not repeat the request, do not
  weaken validation.
- A safe request rate has never been measured, and the cover a fixed gap provided
  is gone (D-035). The first candidate measurement turned out to be a refusal on
  the page past the last one rather than a rate limit (F-061): only a `429` that
  does not reproduce in silence counts as a number here.
- Drift in the shared row decoder breaks four commands at once and shows up as
  different semantics, not as a refusal.
- Every command depends on the internal shape of the SSR bootstrap. Any drift
  must end fail-closed, not in a fallback value.
- The decoder checks were written against the shape of two or three goods
  categories and taken for the shape of Avito. F-055 is the lower bound of the
  list, not the list.
- `sellerName` is defended by no live check any more: `notEmpty` was removed for
  it (D-028) and cannot come back — `notEmpty` applies to every row at once, and
  even a page filtered to companies contained 2 rows of 50 without a name. Only
  the offline checks and human eyes remain.
- `notEmpty` / `mustBeTruthy` in verify apply to every row, so no field that is
  nullable by contract can be in either on a full page. Weakening them further
  without checking against the source is not allowed: that distinction is exactly
  what separates a listing with no photos from a field the decoder lost.
