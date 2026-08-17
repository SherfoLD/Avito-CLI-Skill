# Platform — shared by all ten commands

Confirmed live: 2026-08-18

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
semantics. Nothing about the *shape* catches it — a fallback value is the right
type — so the only automatic defence is the mandatory non-empty
`descriptionPreview` in the strict fixtures, and that one does not catch price.

## Output shape

The listing row is 14 keys, one schema — `LISTING_ROW` in
`src/site/listing.mjs`, imported by `search`, `get-page`, `apply-filters` and
`move-category` (D-048). The keys themselves are in `--help`, printed from the
schema (D-053).

- 16 keys is the ceiling (D-054). A column is a scalar, an array or record of
  scalars, or an array of flat records — a table inside a row, and the only
  nesting there is (D-055). Both rules are checked against the schema when the
  module is imported.
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
- **D-016 — seller type is not derived.** A live `--seller company` response
  carried a `/user/.../profile` link, so the seller's route does not encode their
  type, and a column that guessed it would be guessing on every row.
- **D-020 — `price` is the price with bonuses**, the number Avito prints large on
  the card. The owner's decision. The base price is not exposed as its own
  column. `get-item` is outside this decision — the listing page has its own
  price semantics and it already agrees (F-043).
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
  anonymised response samples in `evidence/`, which is what makes "Avito changed"
  demonstrable rather than assumed. Excluded by `.gitignore`: `evidence/traces/`
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
  That tab is created `hidden`, so a chain of commands costs the person in front
  of the browser nothing at all (F-073).

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

- **D-048 — the row contract is a schema, checked where a row exists.** It used
  to be written in three places and enforced in none of them at the moment a row
  was produced: the `columns` array named the keys, `verify/<command>.json`
  repeated them with their types and formats, and a 563-line static audit read
  source text through a hand-written tokenizer to guess which object literal was
  a row. Now each descriptor carries `row: z.strictObject({...})`, `columns` is
  derived from it, and `bin/avito.mjs` and `tests/harness.mjs` parse every row
  through it. What that changed, beyond deleting three scripts and both
  baselines:
  - an undeclared key is a failure instead of a value that appears in `-f json`
    and disappears in `-f table`;
  - a column present with the value `undefined` is a failure, where the old
    key-count check counted it as present — two synthetic carriers were doing
    exactly that with `published`, and `JSON.stringify` would have dropped the
    column;
  - the four listing commands share one `LISTING_ROW` in `src/site/listing.mjs`,
    along with the `api*` mapping and the reservation filter that had been
    copy-pasted into all four;
  - `verify/*.json` keeps only what is true of *its own request* — the address
    `get-coords` resolved, the page number in `get-page`'s `searchUrl` — because
    everything general is now checked on every run rather than on a live one;
  - Avito's own payloads are read with the same schemas through `decode`, so
    drift names the path (`point.latitude: expected number, received string`)
    instead of saying "has an unexpected shape".
  What a schema cannot say stayed code: an echo is still not an application, so
  every postcondition is still an explicit comparison against the carrier that
  proves the value took effect. And what could be neither — an argument bent into
  range, `return []` in a catch, `?? 'unknown'`, an Avito identifier pinned in
  source — moved from regular expressions over source text to four ESLint rules
  over a real AST, where a comment is not a node and a catch block is a scope.

- **D-049 — a verify fixture is a schema over the whole returned array.** The
  fixtures were JSON in a small dialect — `rowCount`, `patterns`, `notEmpty`,
  `mustNotContain`, `mustBeTruthy` — applied by a matcher written by hand. Every
  rule it could express was a rule about one column of every row, which left the
  questions a live check exists to ask unaskable: is exactly one sidebar row the
  current category, are these 25 reviews 25 different reviews, is the count the
  count this route has. A fixture now exports `args` and `rows`, a
  `z.array(...)` over what the command returned:

  ```js
  export const rows = z.array(z.looseObject({ kind: z.literal('house') }))
    .length(1);
  ```

  The element is a `looseObject` because the row already satisfied the command's
  `row` schema: naming a column here adds a constraint rather than restating one,
  and the columns left unnamed stay visible to a `.refine` over the set.

  Two things this costs. A fixture is executable now, so it can be vacuous in
  ways JSON could not — `check-verify-fixtures` answers that by refusing a
  fixture that names no column and carries neither an exact count nor a rule over
  the set, which is what a plausible `.min(1).max(50)` range amounts to. And
  `verify/` is no longer readable as data; `tests/verify-fixtures.test.mjs`
  compensates by loading every fixture offline and proving the matcher reports a
  violation rather than passing it.

  Three claims that were already vacuous went out with the dialect: `mustBeTruthy`
  on `rank`, on `reviewId` and `notEmpty` on `authorName` restated what the row
  schema makes impossible. `notEmpty` on `attributes` was worse than vacuous —
  it compared `String({})`, which is never empty — and is now a real check that
  the listing carries at least one attribute.

- **D-050 — three names were describing something else.** Renamed, with nothing
  else changed:
  - `src/decoders/` → `src/browser/commands/`. Nothing in it was a decoder in the
    sense the name promised: eight of the nine files fetch, and the authoring
    skill said three times that a decoder is a pure function with no network.
    They are the page half of one command, so they now sit beside the shared page
    code under `src/browser/`, and `src/browser/prelude/` names the other half by
    what makes it different — every file in it is inlined into every call.
  - `fixtures/` → `evidence/`. Two directories were called fixtures in prose, and
    a section of the authoring skill existed only to say they are different
    things. `verify/` holds expectations, maintained forever; `evidence/` holds
    dated anonymised samples that are never edited.
  - `cdp-command-author` / `cdp-command-repair` → `write-command` / `fix-command`.
    The prefix named the transport, which is the one thing those skills are not
    about.

  The offline suites follow the same rule they always did — one per command,
  named after it. `search` keeps two, split by which side of the CDP boundary
  they exercise: `search.test.mjs` and `search.page.test.mjs`.

- **D-051 — the browser choice is a file, because an agent has no shell to keep
  it in.** `browser.json` in the state directory, written by `avito browser use`
  and read by every later run. The transports were reachable only through a flag
  or an environment variable, and both are per-invocation: the consumer agent
  starts a new shell for every command, so the only setting a person could make
  was one it would never see (F-074). Resolution is by layer — command line,
  environment, file, default — and a layer that names any transport decides it
  outright. Field-by-field merging would let a remembered profile beat a
  `--browser-url` passed on the spot, since the profile is consulted first
  within a layer. `resolveBrowserOptions` is the only place that collapses the
  four, so what a command connects to and what `avito session status` prints
  cannot disagree.

- **D-054 — the key ceiling is 16.** The owner's decision. Twelve had become the
  reason for every deferred column, and four phases were bidding for the same two
  slots. Nothing about a wider row makes a column free: each one still has to
  answer what it means when the value is missing.

- **D-055 — a column may be a table, and a table is a list of flat records.**
  The owner's decision, taken for the service price list: `{ title, price }[]`
  says what a `Record<title, price>` cannot — that two entries may share a title,
  and that the order is Avito's. The grammar admits exactly one level of it. A
  record inside a column is declared like the row itself, `strictObject` of
  scalars, so an undeclared key fails one level down as well; a list of lists and
  a record of records stay refused, because the shape they would describe is a
  tree and a row holds a table. `-f table` prints the entry count, the way it
  already prints one for `images`.

- **D-056 — `price` is a price or it is `null`; anything advertised is
  `minPrice`.** The
  owner's decision, and the reason is what the number does to a reader: on
  services the scalar is bait for the click, not what the work costs. `minPrice`
  is where that number goes, and it covers both ways a card can carry one: a
  floor («от 500 ₽» → `minPrice: 500`) and a table, where the card prints one
  number for a list of them — including as a plain «500 ₽», which is why
  `minPrice` cannot be read as "Avito wrote от". A card priced by a table also
  answers `hasPriceList: true` and points at `get-item`, which returns the
  table. `minPrice` is only ever the number Avito itself printed — never the
  smallest entry of the table, which is a different number: beside a list
  starting at 900 ₽ the same card printed «от 400 ₽» (F-079).
  A phrase leaves both null, except «Бесплатно», which is the real `0` it says
  (F-076). Telling a price from a floor needs no vocabulary: digits and spaces
  alone are a price, digits with anything beside them are a floor (F-078). What
  the row still does not carry is the unit of a rate — `postfix` holds it and no
  column takes it (F-077), so «150 ₽ за м²» and a flat 150 ₽ are one number to
  anything that sorts.

- **D-053 — the row contract is printed, not paraphrased.** `--help` renders the
  `row` schema as a TypeScript declaration above the arguments' answer — a
  notation a consuming agent reads without being taught it — in place of the
  comma-separated column names it used to print. What that reaches which a list
  could not: a nullable column (`price: number | null`), a list (`string[]`), the
  filter grammar as a literal union (`valueSyntax: "<from>..<to>" | …`), and the
  array around the whole answer, which was the contract of every command and was
  written down nowhere (`jq '.title'` on `get-item` answers `Cannot index array
  with string`).
  `| null`, `[]`, `Record<>` and numeric bounds come out of the schema; a string
  format does not, because a regex check exposes only its pattern object. So a
  format states itself in `.meta({ note })` where the vocabulary is declared —
  four helpers in `schema.mjs` plus `published` in `LISTING_ROW`, and every
  command that will ever be written inherits them. A per-column `.describe()` was
  the alternative and would have been ten edits to paraphrase column names.
  Prose keeps only what a type cannot hold, which is meaning: what `price` counts
  (D-020), that a row is a card rather than a listing, that a `null`
  `sellerName` is Avito withholding identity (D-028).

- **D-052 — `avito browser` finds the candidates instead of describing where to
  look.** Debugging leaves `DevToolsActivePort` in the profile root, so the
  browsers offering a connection can be listed rather than explained: one scan
  of the platform's application-support root, three levels deep. This is what
  makes the choice askable — the agent has a list to put in front of the person
  instead of a path to guess at, and the empty result is itself the answer
  "nothing here has debugging on". The README used to name a Chrome path that
  was wrong on the machine it was written on.

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

- **F-073 — a tab has three ways to be born and only one of them is free.**
  Measured on Chromium 151, macOS, `Target.createTarget` with the frontmost
  application recorded before and after. Plain: the browser takes the screen
  (`ghostty → Helium`) and the tab joins the strip. `background: true`: no
  application switch, a tab in the strip, and a document that reports
  `visibilityState: 'hidden'` — Chromium throttles it, and the protocol
  documents the flag as unsupported on macOS. `hidden: true`: no application
  switch, no tab in the strip, absent even from `Target.getTargets`, and the
  page still reports `visible`, keeps the profile's cookies (the geo directory
  answered with the profile's own search history) and renders — all ten fixtures
  pass on hidden tabs, `get-item` and its rendered-page fallback included. What
  remains is the approval prompt of F-071, once per connection rather than once
  per command.

- **F-074 — the broker was reporting itself instead of the browser.** Found by
  running the consumer skill from a different agent on this machine, 2026-08-16.
  Nothing had told the CLI which browser to use — the skill never mentioned one,
  and the only ways to say it were a flag and an environment variable, neither
  of which survives the fresh shell an agent opens per command. So the default
  port was tried, nothing was listening, and what the caller got was `the
  session broker did not start` after 20 seconds. The true message existed and
  was actionable (`no Chrome DevTools endpoint at http://127.0.0.1:9222`), but
  the broker is spawned detached with `stdio: 'ignore'`, so it died in the
  child. `avito session status` then answered `not running — the next command
  will start one`, which describes a healthy idle machine; it consulted its own
  state file and never looked at a browser. Three layers, each naming the wrong
  subject. The child now writes its startup cause where the parent reads it,
  which also ends the wait at 0.2s instead of 20, and `session status` resolves
  and probes the endpoint it would use. Same species as F-061 and F-069: the
  data was never wrong, the diagnosis was.

- **F-076 — a card with no number says so twice, and differently.**
  `priceDetailed.hasValue: false` covers two visible forms and the flat `value`
  is `0` under both, so `hasValue` alone says only "no number to compare by".
  What tells them apart is the `PriceStep` value: `null` under «Цена договорная»
  (6 cards of 50 on `predlozheniya_uslug?q=ремонт+стиральных+машин`), `0` under
  «Бесплатно» (19 cards of 50 on `sobaki?q=щенок`, shelter listings). Reading the
  flat zero when the step said `null` answered a number where Avito printed a
  phrase; the step decides now, and the flat field is read only where Avito sent
  no step at all. Live after the fix: `«ремонт стиральных машин»` returns
  `price: null` on all 7 of its «Цена договорная» rows, `«щенок»` returns
  `price: 0` on all 20 of its «Бесплатно» ones.

- **F-077 — the price can carry a unit, and the unit is structural.**
  `priceDetailed.postfix` holds it — `за м²`, `за час`, `за м³` — beside the
  number rather than inside it, so it never disturbs the number and no column
  carries it (D-056). On `predlozheniya_uslug?q=уборка+квартиры` 19 cards of 50
  carry one, so a `price: 150` there is what the page prints as
  «от 150 ₽ за м²». Outside
  Services the postfix was empty on every card read (electronics, transport,
  animals, home and garden, vacancies, business equipment).

- **F-078 — «от» has no structural carrier at all.** The `priceDetailed` keyset
  is identical on every card of both services routes, so the word lives only
  inside `string` / `fullString`, so what the decoder tests is the shape of that
  string rather than the word: digits and spaces are a price, digits with
  anything beside them are a floor, and the number then travels as `minPrice`
  (D-056). It is implied by nothing else: a card with a price list can print a
  plain «500 ₽» and a card with no list can print «от 250 ₽», so `hasPriceList`
  is not a proxy for it. 27 cards of 50 on the repair route carry it, none on the
  goods routes read.

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
- **`price` still does not say what it counts.** The phrases, the floor and the
  table are handled (D-056), but «150 ₽ за м²» is `price: 150` like any other
  150: the unit is in the payload and in no column. No fixture catches a wrong
  number, only a wrong shape.
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
