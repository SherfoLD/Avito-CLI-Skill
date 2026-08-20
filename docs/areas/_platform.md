# Platform — shared by all ten commands

Confirmed live: 2026-08-20

What belongs to no single command: transport, carriers of state, the shared listing
decoder, output shape, repository rules. Anything command-specific is in that
command's domain file.

## Transport

The only path to Avito is a browser context the user owns. Anonymous Node fetch
is closed, and nothing here works around that.

- Every command primes the origin by navigating to
  `https://www.avito.ru/robots.txt`; the body is never read. `search` then
  reads its public `?q=` route and canonical catalog as separate same-origin
  document fetches, not rendered navigations. `get-item` renders the listing
  itself only as a fallback when its API read cannot produce the item.
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

A search route hands over almost everything in one SSR document:
`script[type="mime/invalid"][data-mfe-state="true"]` → `loaderData.data`. From
there: `searchCore` (postconditions), `filtersV2` (the filter schema),
`rubricators.side.nodes` (the category tree), `context` (the opaque string that
addresses the items API), and `catalog.items` — which is the one thing it does
not hand over whole, being complete only in its first twenty cards (F-089).

So the four commands that return a catalog page read two carriers, and which one
answers what is fixed (D-063):

| Carrier | Answers | Read by |
|---|---|---|
| SSR document | the search: `searchCore`, `filtersV2`, the sidebar, the canonical URL | all four, first |
| items API `/web/1/js/items` | the listings, all fifty complete | all four, second |

The API is not addressable on its own — it is asked in the terms of a
`searchCore` only a document has (F-090) — so this is not a carrier swap. It is
one document read followed by one API call, and the document keeps every
postcondition it ever proved.

After hydration the live DOM **does not contain** the document carrier — neither
`script[data-mfe-state]` nor `searchCore`. The schema cannot be read from a
loaded document, only from a separate same-origin SSR fetch.

## Listing decoder

One decoder serves `search`, `get-page`, `apply-filters` and `move-category`, so
its drift breaks all four at once.

The visible fields are **not** in the flat item object:

| What the card shows | Where it is read from | The flat field beside it |
|---|---|---|
| the large price | `iva.PriceStep[].payload.priceDetailed` | `item.priceDetailed` — the base price, a different number on 45 cards of 50 (F-093) |
| the description text | `iva.DescriptionStep[].payload.description` | `item.description` — the same string on the items API, empty in the SSR catalog |
| the location line | `geoReferences[0]` + walking time, or the plain city | the same references, in `item.geo` where the card has no `GeoStep` |

Neither the price nor the description is read from the flat field: a card
carrying no step stops the call, because the flat price is a different quantity
and the flat description is a second copy (D-070). The location is the one field
with two live carriers and reads from whichever the card has, so drift there is
still a wrong meaning rather than a refusal — and the only automatic defence is
the mandatory non-empty `descriptionPreview` in the strict expectations, which does
not reach it.

## Where a payload becomes an answer

A catalog page crosses the page boundary raw and is decoded in Node
(`src/site/card.mjs`, D-065). What stays in the page is the fetch chain — the
document read, the `searchCore` carried onto the items API request, the
postconditions over both — because each request is built from the response
before it and every read has to be same-origin.

## Output shape

Every command answers with **one JSON object**, declared as `output` in its
descriptor and parsed through it before printing (D-048). There is no `--format`:
the output is JSON and nothing else.

An answer that returns several of something is an envelope plus a list. What is
one fact about the whole answer sits on the envelope — the `searchUrl`, the
effective `locationId` and `locationName`, the confirmed `page` — and what
differs between the things returned sits inside them (D-073). `search`,
`get-page`, `apply-filters` and `move-category` share the element:
`LISTING_ITEM` in `src/site/listing.mjs`, 13 fields, one schema.

- 40 declared fields is the ceiling and 3 objects is the depth ceiling (D-074),
  both checked against the schema when the module is imported. Within them, what
  a field holds is the schema's own business.
- `strictObject` at **every** level: an undeclared key is a failure, not a value
  a caller was never told about.
- Page size belongs to Avito (50 listings, 25 reviews). No command has a count
  argument.

`--help` prints the answer as TypeScript, from the descriptor's `type` — written
by hand, and held in step with the schema by `npm run check:commands` (D-053).

## Decisions

- **D-001 — private, not public.** The command surface stabilises before any
  thought of publishing it.
- **D-003 — read-only before write.** Favourites and any mutation come only after
  the read-only surface is stable, with their own contract and safeguards.
- **D-004 — evidence before implementation.** Network logic is not written until
  the command has fresh evidence with a replay.
- **D-005 — no secrets stored.** Cookies, tokens and personal fields enter
  neither the repository, nor the expectations, nor the logs.
- **D-016 — seller type is not derived.** A live `--seller company` response
  carried a `/user/.../profile` link, so the seller's route does not encode their
  type, and a field that guessed it would be guessing on every listing.
- **D-020 — `price` is the price with bonuses**, the number Avito prints large on
  the card. The owner's decision. The base price is not exposed as its own
  field. `get-item` is outside this decision — the listing page has its own
  price semantics and it already agrees (F-043).
- **D-022 — a command returns Avito's whole page.** `--limit` was removed
  everywhere: the request was paid for in full regardless, and the argument only
  threw away listings already received. The price of the decision is that an
  expectation no longer pins an exact count (`1..50`, `1..25`), so it alone will
  not catch listings appearing or going missing.
- **D-023 — a photo size is never named in code.** Take the largest variant whose
  key parses as `<width>x<height>`; a record with no such key stops the command.
  Hardcoding `208x208` would produce `images: []` on every listing the day the key is
  renamed — indistinguishable from a listing with no photos. One decoder is left
  holding this rule, `decodeItemImages` in `src/site/item.mjs`; the
  listing item and the review feed stopped reading photo URLs at all (D-061).
- **D-028 — `sellerName` is nullable** in all five commands that return it.
  `null` means "Avito did not send a name", not "there is no seller". The name is
  left exactly as Avito sent it, placeholder `Пользователь` included.
- **D-029 — `imagesPreviews`, not `images`**, in the listing item while it carried
  photo URLs at all; `images` stayed with the full gallery. One name over both
  catalog previews (`636x636`) and originals (`1280x960`) was the mistake being
  avoided, and D-061 removed the second name along with the field.
- **D-062 — a count of zero is only ever Avito's zero.** `imageCount` is `null`
  where the card carries no `images` key at all, which is every card past the
  twentieth of a deep page (F-089), and `0` only where Avito sent an empty list.
  Collapsing the two would have put a plausible wrong number in every listing of the
  tail of every deep page — the exact failure the rule about fallback values
  exists to prevent.
- **D-061 — photos live in one command, and the listing item counts them.**
  `imagesPreviews` was five opaque URLs on each of fifty listings — the largest single
  contribution to the payload of every search, and nothing an agent could open.
  The field became `imageCount`, `get-seller-reviews` lost its `images`
  entirely, and the originals are files written by `get-item --images-dir`
  (D-059). Counting reads no URL, which is what reopened résumés (F-087): the
  refusal that disabled them lived inside the listing decoder's photo reader.
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
- **D-038 — `sellerId` removed from all five commands.** The field was pure
  output: no command grouped by it, built a URL from it, or checked a
  postcondition with it, and the review feed travels by a third identifier
  (F-046). Five copies of the seller-route decoder left with the field — that is,
  a whole failure class that belonged to the seller rather than to the category
  (F-057) and that killed an entire call over one card. `sellerName` /
  `sellerRating` / `sellerReviewsCount` stayed: they come from the same payload
  but with their own checks.
- **D-039 — publication date: `published` in the listing item, `publishedText` in
  `get-item`.** Two names, because these are two different quantities, and one
  name over both would repeat the `images` / `imagesPreviews` mistake (D-029). In
  the listing: the exact moment from `sortTimeStamp`, ISO 8601 in UTC
  (`2026-08-13T23:15:41Z`) — Avito sends no offset and prints everything in Moscow
  time, so the hour is left to the consumer rather than written into the contract.
  In `get-item`: Avito's own string as-is (`14 августа в 02:15`); parsing it into a
  date would mean inventing a year Avito did not send. A missing `sortTimeStamp`
  yields `null` rather than a stop — starting a new failure class immediately
  after removing one was not worth it; an impossible timestamp shape still stops
  the call.
- **D-026 — the evidence layer is versioned.** What lives there is not draft
  reconnaissance but `expectations/` — the only value-level check there is — and the
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
  minutes. Which commands share a tab is D-079.
  Two consequences worth stating. The broker exposes only page ownership,
  navigation and runtime evaluation rather than relaying CDP, which keeps it
  incapable of doing more to the browser than a command could, and it is gated
  by a token in a file only the user can read — holding a connection open for
  convenience must not become an open door onto a logged-in session for every
  process on the machine.
  `AVITO_BROKER=off` restores per-command connections, which is right for a
  browser started with `--remote-debugging-port`, where nothing ever asks.
  That tab is created `hidden`, so a chain of commands costs the person in front
  of the browser nothing at all (F-073).

- **D-079 — one search chain owns one hidden tab.** Every `search` opens a new
  broker-owned tab. `get-page`, `get-filters`, `apply-filters`,
  `get-categories` and `move-category` acquire one by their normalized input
  `searchUrl`; every `searchUrl` they return becomes another key for that same
  tab. An identical URL from a later `search` points to the later tab, because
  the URL is the whole identity the caller carries. The other four commands
  remain ephemeral, and `AVITO_BROKER=off` remains ephemeral for all ten.
  Before reuse the broker probes the saved CDP session and replaces a dead tab;
  two live commands are never allowed to navigate one tab concurrently. No SSR
  value is cached with the tab: every command still fetches its document and
  carries that fresh `searchCore` immediately into its items API request.

- **F-098 — a returned search URL aliases the tab that produced it.** Live on
  2026-08-20, two different `search` calls held two broker pages; a
  URL-consuming command reacquired each URL without changing that count.
  `apply-filters` then returned a different URL, `get-filters` read the applied
  `sort=1` through it, and the broker still held two pages. `get-location`
  completed in between without changing the count, which confirms that its
  priming page remained ephemeral.

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

- **D-048 — the output contract is a schema, checked where the answer exists.**
  Each descriptor carries `output: z.strictObject({...})` and nothing else names
  the shape: `bin/avito.mjs` and `tests/harness.mjs` parse the whole answer
  through it, and `decode` reads Avito's own payloads with the same machinery, so
  drift names the path (`point.latitude: expected number, received string`)
  instead of saying "has an unexpected shape". What that buys:
  - an undeclared key is a failure at every level, not a value a caller was never
    told about;
  - a field present with the value `undefined` is a failure, where a key-count
    check counts it as present and `JSON.stringify` then drops it;
  - the four listing commands share one `LISTING_ITEM` in `src/site/listing.mjs`,
    along with the `api*` mapping and the reservation filter;
  - `expectations/` keeps only what is true of *its own request* — the address
    `get-coords` resolved, the page number `get-page` confirmed — because
    everything general is checked on every run rather than on a live one.
  What a schema cannot say stayed code: an echo is still not an application, so
  every postcondition is still an explicit comparison against the carrier that
  proves the value took effect. And what could be neither — an argument bent into
  range, `return []` in a catch, `?? 'unknown'`, an Avito identifier pinned in
  source — moved from regular expressions over source text to four ESLint rules
  over a real AST, where a comment is not a node and a catch block is a scope.

- **D-065 — a catalog crosses the boundary raw, and Node decides what it means.**
  The card decoder used to run in the page, where a serialized function carries
  no imports and every shape check is hand-written. It now runs in Node against
  `CATALOG_ITEM`, and the page returns `catalog` as Avito sent it. Measured on a
  50-card page: 559 KB raw against 33 KB of decoded listings, ~35 ms against ~7 ms
  for the return trip through the broker — against two Avito fetches of seconds,
  which is what makes the raw carrier affordable at all.
  What that buys is one place where a schema can name the path that drifted
  (`items.3.images: expected array`) instead of four hand-written `throw`s, and
  a decoder testable without assembling the prelude. What it costs is `linkedom`
  as a runtime dependency: the description carries Avito's own markup and only a
  parser turns it into text. It needs the `<body>` wrapper a browser adds — a
  bare fragment leaves `documentElement` null, which is a live-only failure the
  offline suite did not have a case for until it happened.
  The schema declares only what already stopped the call — `images` an array,
  `sortTimeStamp` a positive integer, `priceList.valuesAll` a list. Every carrier
  a fallback chain reaches past is `z.unknown().optional()`, which is what makes
  the move a no-op: the old decoder and the new one were compared field by field
  over one live 50-card page and answered identically. Those `unknown`s are the
  map of what tightening is still worth arguing about — the price step wins over
  the flat base price and nothing notices if it disappears (F-076).

- **D-066 — the HTML never leaves the page, and a document with no state is one
  refusal.** `readDocument` parses the markup where a real `DOMParser` is, pulls
  `loaderData` out of the state script and hands over JSON. Node never sees HTML.
  Doing it the other way round was measured and rejected: `linkedom`'s
  `innerText` includes the contents of `<script>`, so the challenge detector
  would have read the whole page state as page text — and Avito's state spells
  `captcha` in its own keys. That is F-044 a second time, and the offline suite
  would not have caught it, because the synthetic carrier ships a small state
  with no such word in it. `tests/get-page.test.mjs` now has that case.
  With the parser settled, the text detector went with it. It only ever
  separated "a verification page" from "the bootstrap did not arrive", and those
  are the same 200 HTML page with no state script, calling for the same thing: a
  person looking at the browser. So `readDocument` refuses `no_state` once, and
  eight copies of `if (document.challenge)` across six commands went with it.
  `looksLikeChallenge` stays where there is a rendered page to read —
  `get-item` — and where a response that should have been JSON came back as
  HTML.
  That refusal is `AccessError`, exit code 77, the fifth class. It is the one
  refusal a caller must not retry and cannot fix, so it stops looking like a
  drifted shape. Two mappings changed with it: `get-filters` used to answer a
  stateless document with `EMPTY_RESULT` "this page has no SSR filter schema"
  and `get-categories` with "no SSR search state" — both wrong. A route without
  filters still ships a bootstrap, with an empty `Sections` list.

- **D-067 — one Avito response, one schema, one file.** `src/schemas/` holds
  what Avito answers with, a file per response: `search-core.mjs` for the object
  both catalog carriers echo, `filters.mjs` for the `filtersV2` tree. A command
  imports the schema rather than re-describing the shape, which is what four
  browser halves were doing to `searchCore` in parallel.
  The tree is recursive and read loosely, with one strict object in it:
  `RANGE_VALUE` is `{from, to}` and nothing else, because a third side is a bound
  this reader does not apply and would silently drop (F-063). Everything else is
  `looseObject` — Avito adds keys for its own rendering and a page must not be
  refused over one nothing here reads.
  What it removed from `get-filters`: the `searchCore` object check, the
  non-scalar throw in `scalarOrNull`, the `Array.isArray` on `values`, the
  object check on an option, and the hand-rolled `unknownSides` walk over a
  range — 38 lines for 22, and the refusals now name the path
  (`filtersV2.Sections.0.Filters.0.currentValue`) instead of saying "implausible".
  `get-page` lost its filter walk from the page entirely: it applies no filter
  and reads none, so the tree is decoded in Node as a postcondition on the
  document. That walk had no offline coverage while it lived in the page; it has
  one now.

- **D-068 — the last decoder left the page.** `get-item`'s `buyerItem` decoder
  moved to `src/site/item.mjs` against `BUYER_ITEM`, and both of its carriers —
  the item API and the hydration state of a rendered listing — now hand the
  payload over as Avito sent it. `src/browser/prelude/` holds no decoder at all.
  The schema is read with `safeParse`, not `decode`, and that is the whole point:
  this carrier has a second one behind it, so a shape the decoder cannot trust is
  the same answer as a value it cannot trust — `null`, meaning "try the page"
  (D-064). Five hand-written `Array.isArray` guards became declarations and kept
  that contract exactly.
  What stayed in the page is what needs a real DOM: `document.body.innerText`
  and the hydration state of a listing that was actually rendered. There is no
  second copy of those to hand over.

- **D-069 — the page fetches, Node decides.** The four catalog commands built
  their request, checked their postconditions and refused their selections
  inside the page, because the items API is only addressable from a `searchCore`
  the SSR document carries (F-090). All of that is Node now, and the page is two
  functions: read one document and hand over the state that was inside it, fetch
  one URL Node built and hand over the JSON. Six commands run them —
  `get-filters` and `get-categories` had a one-document page half each, and those
  were the same function with a different slice taken.
  What that closed: `apply-filters` checked every selection against the fresh
  schema of the URL before a request existed (D-031), with hand-written walks
  over the filter tree and hand-written comparisons of what came back. Those are
  `src/schemas/filters.mjs` and `src/site/` now, where the offline suite reaches
  them and a refusal names the path. `searchCore` was being re-described in four
  browser halves in parallel; it is `SEARCH_CORE` once. The request builder,
  the scalar comparisons, the filter walk and the sidebar vocabulary moved out of
  `prelude/` with them — three files are left there, all of them fetch.
  Two things the move found, neither reachable from the old shape: `searchCore.params`
  carries a `{from, to}` range for a range filter and the schema had declared only
  scalars and lists, so any route with an applied range would have failed the
  decode; and `avito search` still carried a bounded retry for a refusal
  (`stage: 'schema'`, `code: 'missing'`) that no reader produces any more. The
  schema was widened, and the retry went.
  The page names nothing: `readDocumentState` copies the top-level state keys the
  node half asked for and interprets none of them. That list is what keeps a
  document read from shipping an SSR catalog nobody reads — the four catalog
  commands take their listings from the API, and `search` reads two documents.
  It costs one extra `evaluateWithArgs` per catalog command, about 7 ms on a small
  return, against two Avito fetches of seconds.

- **D-070 — where a card has one carrier, its absence is drift.** The listing
  decoder used to answer from the flat item wherever an `iva` step was missing,
  which is a fallback value in the one place this repository forbids one: the
  flat `priceDetailed` is the base price, a different number from the printed one
  on 45 cards of 50 (D-020, F-076). It now reads the price and the description
  from their steps alone, and a card carrying neither stops the call. What made
  that affordable is a census rather than an argument — 400 cards over 8 routes of
  6 top-level categories carry both steps (F-093) — and what makes it necessary
  is that the wrong answer is a plausible number nobody would go looking at.
  Two shape rules came with it, and both are in the schema so the message names
  the path: every `iva` value is a list of rendered components, and `isReserved`
  is a boolean or absent. Reading a step Avito sent in another shape as an empty
  one is drift wearing the shape of an absent step; decoding a non-boolean
  `isReserved` to `null` handed `--remove-reserved` the answer meant for a key
  that is not there (F-048).
  `iva.GeoStep` is deliberately not of this kind: two real-estate routes ship no
  such step at all and the flat `geo` carries the same references, so the
  location has two live carriers and reads from whichever the card has.

- **D-071 — one walk over the category sidebar, and one rule for a URL Avito
  answered with.** `get-categories` and `move-category` differ in what they do
  with a sidebar node, not in what a node is, and the traversal around
  `SIDEBAR_NODE` was written twice: the depth bound, the node count, the role and
  the route check, with a uniqueness rule only one of the two held. `sidebarWalk`
  in `src/site/rubricator.mjs` is the one walk now, and it yields a node with the
  three things a node does not carry — its depth, the visible name it hangs
  under, and its route as a `URL` or `null`.
  The private URL normaliser that went with the second copy is gone into
  `answeredUrl`. The two differed on nothing about the host and on one rule worth
  keeping: a port or credentials make a different origin, and an answered URL
  becomes the next command's argument, where `requestedSearchUrl` refuses both.

- **D-072 — the near-miss block is not a result, and is not read.** Avito
  appends `catalog.extraBlockItems` when a search runs short: a placeholder
  naming what it relaxed, then cards from other regions or of other makes
  (F-094). The listing decoder used to concatenate that list with `catalog.items`,
  so a search for one thing in one city answered with another thing in another
  city, in the same shape and with no field between them — `--location-id` read
  as though it had not applied. The owner's decision is that they are dropped:
  the command answers the search it was given, and where Avito found nothing of
  its own the answer is `EMPTY_RESULT` and not somebody else's listings.
  So `catalog.items` is the only list read, and `extraBlockItems` is not
  declared in the schema either — failing on the shape of data you do not read
  is a spare failure mode (D-034). What that costs is the one thing the block
  did carry: its placeholder is the only carrier of "this result set was
  widened", and no field states it. A caller sees a short page or an empty
  result, which is what the search is worth.

- **D-049 — a live expectation is a schema over the whole answer.** `expectations/<command>.mjs`
  exports `args` and `output`, a zod schema applied to everything the command
  printed:

  ```js
  export const output = z.looseObject({
    locationId: z.literal('637640'),
    items: z.array(z.looseObject({ price: z.number().positive() })).min(1).max(50),
  });
  ```

  A schema rather than a data dialect because the questions a live check exists
  to ask are questions about a set: is exactly one sidebar entry the current
  category, are these 25 reviews 25 different reviews, is the count the count
  this route has. Every object in it is a `looseObject` because the answer
  already satisfied the command's `output` schema — naming a field adds a
  constraint rather than restating one, and the fields left unnamed stay visible
  to a `.refine`.

  What that costs is that an expectation is executable, so it can be vacuous in
  ways data could not. `check-expectations` answers that by refusing one that
  names no field and carries no rule over the answer — which is what a plausible
  `.min(1).max(50)` range amounts to — and by walking the names against the
  command's own schema, envelope and list alike, so a rule that could never fire
  is reported with the path it was written at. `expectations/` is not readable as
  data either; `tests/expectations.test.mjs` compensates by loading every file
  offline and proving the matcher reports a violation rather than passing it.

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
    things. `expectations/` is maintained forever; `evidence/` holds
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

- **D-054 — a ceiling on the answer, not on a shape.** The owner's decision.
  There is a ceiling because headroom is not permission: nothing about a wider
  answer makes a field free, and each one still has to say what it means when the
  value is missing. Where the ceiling sits is D-074.

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
  the listing still does not carry is the unit of a rate — `postfix` holds it and
  no field takes it (F-077), so «150 ₽ за м²» and a flat 150 ₽ are one number to
  anything that sorts.

- **D-053 — the contract is printed as TypeScript, and written by hand.**
  `--help` prints the answer as a TypeScript declaration — a notation a consuming
  agent reads without being taught it — instead of a list of names. What that
  reaches which a list cannot: a nullable field (`price: number | null`), a list
  (`Item[]`), the filter grammar as a literal union, and the shape of the answer
  as a whole.

  The declaration is `type` in the descriptor, written by hand rather than
  rendered from the schema. A renderer produced one line per field and had no
  notation for the thing a caller most needs — what a field *means*, what its
  `null` says, which unit it is in — while every format that is not expressible
  as a zod check had to be carried in a `.meta({ note })` beside it anyway. Hand
  writing is a second copy, so it is gated rather than trusted:
  `npm run check:commands` refuses a name that is in the schema and not in the
  type, or the reverse.

- **D-052 — `avito browser` finds the candidates instead of describing where to
  look.** Debugging leaves `DevToolsActivePort` in the profile root, so the
  browsers offering a connection can be listed rather than explained: one scan
  of the platform's application-support root, three levels deep. This is what
  makes the choice askable — the agent has a list to put in front of the person
  instead of a path to guess at, and the empty result is itself the answer
  "nothing here has debugging on". The README used to name a Chrome path that
  was wrong on the machine it was written on.

- **D-073 — one fact about the answer is stated once.** A command answers with
  one object: an envelope carrying what is true of the whole answer, and lists
  carrying what differs between the things in them. The rule for deciding is
  mechanical — **identical across every element → envelope; different between
  them → element** — which is why `get-categories` keeps `depth` and `parent` on
  each category (every node sits somewhere different) while the four listing
  commands keep `searchUrl` on the envelope (there is one). The rule says where a
  field goes, not that it earns a place: a per-node route passed it and was
  removed anyway, for having no caller (D-075).

  Two things this is for, and the second is the bigger one. `searchUrl` on fifty
  cards was ~2000 tokens of the same 120-character string per call, paid on every
  page an agent read. And the effective region was not reachable at all: `search`
  computed `locationName`, compared it against the request, and threw it away —
  so a caller who passed no `--location-id` had fifty listings and no way to ask
  which region answered. It is on the envelope now, beside `locationId`, for all
  four.

  The envelope is what removed `rank` as well. Position in a JSON array is
  position; a field restating it was a field.

- **D-074 — the ceilings are 40 declared fields and 3 objects deep.** Counted
  once per declaration wherever it sits, so burying thirty fields inside a list
  is still thirty fields the caller has to read.

  Depth counts object nesting, so every command today is 2 — an envelope and the
  things in it, `get-item.priceList` included, because a list does not add a
  level. The ceiling is 3 to leave exactly one: a table inside one of those
  things. Nothing reaches it, and a design that wants to is worth arguing for
  rather than assuming.

  Both are checked when the module is imported, against the schema, together with
  `strictObject` and camelCase at every level. They replace a 16-key ceiling on a
  flat row, which nesting made meaningless: the point was never the top-level key
  count, it was that an answer stays readable and that a field has to justify
  itself (D-054).

- **D-077 — the two numbers on a listing envelope describe the answer, not the
  search.** The four listing commands carry `itemsCount` and `medianPrice`
  beside `items`, and both are computed from the cards that call returned, after
  `--remove-reserved` has shortened the page. Neither is Avito's: the result-set
  size the items API reports (`count`/`totalCount`) stays where it was, read only
  to tell an empty answer from a broken one, because a total with this page's
  reserved cards subtracted is a number that is true of nothing.

  `medianPrice` reads `price` and only `price`. A card priced from a floor or by
  a table has no single price (D-056), so it is left out rather than counted at
  its `minPrice` — putting a floor in the middle of a page produces a plausible
  number no listing costs. A page where no card carries a price has no median and
  says so with `null`; an even count takes the mean of the two middle prices.
  «Бесплатно» is nought and counts, «Цена договорная» is nothing and does not
  (F-076). What the numbers *mean* is still Avito's problem: on a route that
  prices by the square metre the median is a median of rates (F-077).

  Both live in `listingAnswer` in `src/site/listing.mjs`, next to the reservation
  filter, so the count cannot drift from the list it counts in one command out of
  four.

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
  `get-page` returned `descriptionPreview: null` on every listing, and
  `get-page` / `apply-filters` disagreed with `search` about the price and the
  location of the same listing. The live checks did not catch it, because
  `descriptionPreview` was not in `notEmpty`.
- **F-042 — pages past the first carry the same `iva` steps.** All 50 listings of
  page 2 carry `PriceStep` / `DescriptionStep` / `GeoStep`, the flat
  `item.description` is empty on all 50, and 35 listings have a bonus price differing
  from the base one. No separate branch for non-first pages is needed. Incidentally:
  Avito reshuffles part of a page between requests, so comparison against the
  visible listing is only valid by `itemId`, never by position.
- **F-044 — Avito's `robots.txt` itself contains the word `captcha`** (in
  `Clean-param` directives), so a primed origin must not be text-scanned for a
  challenge — the detector would match every time. A challenge is looked for
  where it is visible: in the response to a data request and in the rendered
  item fallback.
- **F-047 — page size belongs to Avito.** There is no count parameter in the
  listing (50 listings; the UI changes only `p`) and none in the review feed
  (`limit=2` returned 25 records). Checked against the source in passing: a photo
  count of 0 on 9 of 50 listings is `images: []` in the SSR response itself for one
  seller, not a decoder loss.
- **F-089 — the SSR catalog ships twenty complete cards and thirty stubs; the
  items API ships fifty complete ones.** In `loaderData.data.catalog.items` the
  cards past index 20 are missing exactly two keys, `images` and `iva`, while
  everything flat survives — id, title, `priceDetailed`, `sortTimeStamp`, the
  seller's rating. What `iva` carries goes with it: `descriptionPreview`,
  `location` and `sellerName` come back `null`, and `imageCount` is `null` rather
  than `0` (D-062). `extraBlockItems` is empty, so the stubs are catalog cards and
  not recommendations.

  The split is at exactly twenty, the complete cards are contiguous from the
  first, and it is neither a depth nor a vertical effect. Replayed 2026-08-18 on
  six pages, cache-busted:

  | route | vertical | page 1 | page 2 |
  |---|---|---|---|
  | `videokarty-…?q=видеокарта rtx 4060` | goods | 20 of 50 | 20 of 50 |
  | `kvartiry/sdam/na_dlitelnyy_srok-…` | real estate | 20 of 50 | 20 of 50 |
  | `/moskva/rezume?q=продавец` | jobs | 20 of 50 | 20 of 50 |

  The same page through `/web/1/js/items` answers with all fifty complete, and it
  is the same fifty: read fresh, both carriers return the same IDs in the same
  order (résumés, page 2, three interleaved reads, 50/50 identical). An earlier
  divergence on that route was the HTTP cache of the probe, not Avito.

  Whether Avito hydrates the tail on scroll is not established, and this
  repository does not scroll — it asks the API instead (D-063).
- **F-090 — the items API is not addressable on its own.** `/web/1/js/items`
  is asked in the terms of a whole `searchCore` — `categoryId`, `locationId`,
  `name`, every `params[...]` — and none of that is derivable from a URL. The
  document that carries it therefore always comes first, and the API answers
  about the state that document was in. That is why moving the listings onto the API
  costs one extra request rather than replacing one.
- **F-091 — the items API takes a page number, and answers cleanly past the
  last page.** `p=<n>` and `page=<n>` are both honoured and both come back
  normalized to `p=<n>` in the server-generated `url`, with `searchCore.page`
  equal to the request. A key it does not know is ignored in silence: the control
  `pp=3` answered page 1, which is what makes the other two an application rather
  than a coincidence. Page 1 is the request without the key, exactly as it is the
  URL without `p`. Past the end of the results it answers `200` with an empty
  `catalog.items` — not the `429` the SSR document gives at the same boundary
  (F-061). Replayed 2026-08-18 on videocards (928 results: pages 2, 3 and 25 of
  19), on flat rentals, and in `evidence/catalog-carriers-202608181900.json`
  (3 199 results: page 70 of 63 answers 200 with an empty catalog).
- **F-092 — only a page-1 document ships the opaque `context`, and the API does
  not need it.** `loaderData.data.context` is present on page 1 and the key is
  absent altogether from the document of page 2. Sent or omitted, the API answers
  the same page with the same first ID, so `get-page` carries the context when
  its document has one and simply does not when it has not. Replayed 2026-08-18
  on `…/operativnaya_pamyat-…?q=ddr5+32gb`.
- **F-093 — the card's steps are not optional, and one of them is not a step.**
  Counted over the items API of 8 routes in 6 top-level categories — services
  twice, animals, transport, personal items, real estate twice, computer parts —
  400 cards of 400 carry `iva.PriceStep` with a `priceDetailed` and
  `iva.DescriptionStep` with text, every `iva` value is a list, and `isReserved`
  is a boolean. So the fallbacks past those carriers were unreachable rather than
  useful (D-070). What is genuinely optional is which *other* steps a card has:
  `BadgeStickerStep` is on 7 cards of one 50-card page and 50 of another.
  Two more measurements decided the two fallbacks separately. The flat
  `description` is the step's own text on the API, identical on 200 cards
  compared, so it was a second copy and not a second meaning — the "empty flat
  description" belongs to the SSR catalog, which no longer feeds this decoder
  (D-063). The flat `priceDetailed` is a different number on 45 cards of 50 of
  `/moskva/tovary_dlya_kompyutera?q=ddr5+32gb`, and its string agrees with the
  step's about «от» on all 50 of the cleaning route, so the fallback would have
  been wrong about the amount and right about nothing.
  `GeoStep` is the counter-example that keeps its fallback: `/moskva/kvartiry`
  and `/moskva/garazhi_i_mashinomesta` ship no such step on any of their 50
  cards, and the flat `geo` carries the same `geoReferences` — checked
  end-to-end, all 50 listings of the flats route return a metro reference with its
  walking time. Replayed 2026-08-19; the census is in
  `evidence/card-step-carriers-202608191445.json`.
  The census covers `catalog.extraBlockItems` too, on the two routes that
  populate it: 88 cards of 88 carry both steps, all their `iva` values are lists
  and every `isReserved` is a boolean. What those cards *are* is F-094.
- **F-094 — `catalog.extraBlockItems` is the near-miss block, and the decoder
  hands it over as results.** Avito fills it when the search itself runs short,
  on both carriers alike. It opens with a `type: 'placeholder'` entry carrying
  the visible heading and two flags for what was relaxed — `isGeo`, `isMixed`
  («Похожие объявления рядом и в других городах», «Дальше встречаются объявления
  из других регионов») — and the rest are full `type: 'item'` cards that are not
  answers to the query. Measured 2026-08-19: `/moskva/sobaki?q=щенок
  бельгийского гриффона` answers `count: 29` with 11 cards in `items` and 40 in
  the extra block, from Курган, Белгород, Псков and fifteen more regions;
  `/moskva/tovary_dlya_kompyutera?q=ddr5 96gb kingston renegade rgb xmp 3.0`
  answers `count: 2` with 48 extra cards of other makes and capacities.
  The block is empty on a route with enough results — eight ordinary routes
  answered with it so, and the key is present either way — and it grows as the
  search shrinks: at `count: 0` («…палевый окрас», and a full model string with
  a frequency the market does not carry) `items` is empty and the block holds
  50 cards. `count` counts the search; `totalCount` on such a route counts the
  block instead — 0 against 50 — so the two are not two witnesses to one number.
  Until D-072 the decoder concatenated both lists and dropped only the
  placeholder, and `avito search "щенок бельгийского гриффона" --location-id
  637640` answered 50 listings of which 28 were outside the region asked for.
  The rendered page cannot be read for this: it draws 41 cards above the
  divider «Дальше встречаются объявления из других городов», and only 10 of the
  41 are бельгийские гриффоны — the rest are йорки, чихуахуа and шпицы of the
  same city, which is the relaxed *query* half of the block mixed straight into
  the main run. So the visible page separates the block by geography alone,
  while the response separates it whole. Sighted against that page after D-072:
  the command returns exactly those 10 cards, id, price and city equal field by
  field.
- **F-087 — the résumé refusal was the photo reader's, and it is gone.** A résumé
  card carries a placeholder served from `www.avito.st`, outside the photo CDN,
  and the listing decoder threw on it — one card killed the page, which disabled
  résumés entirely. Replayed both ways on 2026-08-18 against
  `/moskva/rezume?q=продавец`: before D-061 `get-page` ends with `item image URL
  is outside Avito image hosting`, after it the page decodes and the placeholder
  is simply counted. Jobs is not open on that evidence — the other half of the
  category refuses elsewhere (F-088).
- **F-049 — Avito withholds private-seller identity from an anonymous session.**
  In the catalog, `iva.UserInfoStep` arrives as an empty array (14 of 50 and 22
  of 50 listings on two pages); in the item API every profile link is empty and the
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
- **F-059 — the date lives in the listing item, not on the listing page.** What
  was expected was the opposite. Both catalog carriers — the SSR catalog and the
  items API — carry `sortTimeStamp` (epoch milliseconds) on 50 of 50. The listing
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
  the live check passed on 50 listings. So the refusal page names the wrong
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
  answered with the profile's own search history) and renders — all ten expectations
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
  `price: null` on all 7 of its «Цена договорная» listings, `«щенок»` returns
  `price: 0` on all 20 of its «Бесплатно» ones.

- **F-077 — the price can carry a unit, and the unit is structural.**
  `priceDetailed.postfix` holds it — `за м²`, `за час`, `за м³` — beside the
  number rather than inside it, so it never disturbs the number and no field
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
- Drift in the shared listing decoder breaks four commands at once. The price and
  the description now refuse where their carrier goes missing (D-070); the
  location has two live carriers and would still answer from the other one.
- **`price` still does not say what it counts.** The phrases, the floor and the
  table are handled (D-056), but «150 ₽ за м²» is `price: 150` like any other
  150: the unit is in the payload and in no field. No expectation catches a wrong
  number, only a wrong shape.
- Every command depends on the internal shape of the SSR bootstrap. Any drift
  must end fail-closed, not in a fallback value.
- The decoder checks were written against the shape of two or three goods
  categories and taken for the shape of Avito. F-055 is the lower bound of the
  list, not the list.
- `sellerName` is defended by no live check any more: `notEmpty` was removed for
  it (D-028) and cannot come back — a required field applies to every listing at
  once, and even a page filtered to companies had 2 of 50 without a name. Only
  the offline checks and human eyes remain.
- A required field in an expectation applies to every element at once, so nothing
  nullable by contract can be required on a full page. Weakening one further
  without checking against the source is not allowed: that distinction is exactly
  what separates a listing with no photos from a field the decoder lost.
