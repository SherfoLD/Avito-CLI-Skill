# State

Updated: 2026-08-20

Facts only: what works, what does not, and why. The future is in [PLAN.md](PLAN.md).
How each command is built is in its domain file, [docs/areas/](areas/).

## Commands

Ten commands, all read-only. `npm run check` is green; the offline suite is 234
checks across seventeen suites. Nine expectations last passed live against Avito on
2026-08-19 and `get-filters` on 2026-08-20; the four listing ones have grown a
rule since (D-077) that has not been run live yet. Persistent search routing was
verified live on 2026-08-20: two searches held two tabs, both URLs reacquired
their own tab, and a URL returned by `apply-filters` became an alias without a
third tab (D-079, F-098). Dead-tab replacement and idle shutdown remain open.

Every command answers with **one JSON object**, declared as `output:
z.strictObject({...})` in its descriptor. The CLI parses the whole answer through
it before printing, the offline suites run the same parse, and there is no
`--format` — the output is JSON and nothing else (D-048). A command that returns
several of something answers with an envelope plus a list: the `searchUrl`, the
effective region, the confirmed page and the category the search landed in sit on
the envelope, and only what differs between the things returned sits inside them
(D-073, D-076). The four listing commands say two more things there about the
page they returned — `itemsCount` and `medianPrice`, both taken from the cards in
that answer and never from the result set Avito reports behind it (D-077). The runtime holds — `strictObject` at every level, 40 declared fields, 3 objects deep (D-074) —
and nothing else.

`--help` prints that contract as TypeScript, from the descriptor's `type`, which
is written by hand and held in step with the schema by `npm run check:commands`
(D-053). An `expectations/<command>.mjs` file is a schema over the whole answer,
saying what that one request must come back with. What none of them can express
is four ESLint rules over the AST (`npm run lint`).

What Avito answers with is declared in `src/schemas/`, one file per response,
and a command imports it rather than describing the shape again (D-067). The
page fetches and nothing more: `src/browser/` is three entry points and three
prelude files, two of the entry points being the reads six commands share, and
every request, postcondition and decode is Node (D-069). A command's offline
suite therefore drives both halves over one set of stubbed routes.

Where two commands read one carrier, they read it once: the category sidebar is
one walk in `src/site/rubricator.mjs` that `get-categories` describes nodes from
and `move-category` follows (D-071), and a URL Avito answered with is checked by
one rule, the one that refuses what `requestedSearchUrl` would refuse to take.

A refusal is one of five typed classes, and exit code 77 (`ACCESS`) is the one
that is not about the command: Avito answered without data — a rate limit, a
verification page, a document with no state — and only the person holding the
browser can act on it (D-066).

The browser has to be one the user already runs, with debugging on at
`chrome://inspect/#remote-debugging` — a purpose-launched empty profile is
refused by Avito outright (D-044, F-068). Which browser that is gets chosen once
and remembered in `browser.json`: `avito browser` lists the ones offering a
connection, `avito browser use` writes the answer down, and a file is the only
form of this setting an agent can see, since it opens a new shell per command
(D-051, D-052, F-074). The connection is held for the session by a broker;
`avito session status` reports it and the browser it would use (D-045). Tabs are
hidden — no tab strip entry, no application switch. A `search` starts one;
commands carrying one of its `searchUrl` values reuse it after a liveness probe,
and unrelated commands remain ephemeral (D-079). The only interruption left is
the one approval prompt per connection (F-071, F-073). Live, `get-location`
opened and released its ephemeral page without changing the two saved search
tabs (F-098).

| Command | Domain | Strict live verify |
|---|---|---|
| `search` | [search](areas/search.md) | 2026-08-19 |
| `get-page` | [search](areas/search.md) | 2026-08-19 |
| `get-filters` | [filters](areas/filters.md) | 2026-08-20 |
| `apply-filters` | [filters](areas/filters.md) | 2026-08-19 |
| `get-categories` | [categories](areas/categories.md) | 2026-08-19 |
| `move-category` | [categories](areas/categories.md) | 2026-08-19 |
| `get-location` | [geo](areas/geo.md) | 2026-08-19 |
| `get-coords` | [geo](areas/geo.md) | 2026-08-19 |
| `get-item` | [item](areas/item.md) | 2026-08-19 |
| `get-seller-reviews` | [item](areas/item.md) | 2026-08-19 |

Every command that returns a catalog page reads two carriers: the SSR document
for the postconditions and the items API for the listings, because that
document's catalog is complete only in its first twenty cards (F-089, D-063). A
page is fifty complete listings on all four, and the same fifty whichever command
asked.
The page fetches those carriers and hands the catalog over as Avito sent it;
the request, the postconditions and what a card means are all Node
(`src/site/items.mjs`, `src/site/card.mjs`, D-065, D-069).

What a card *prints* is read from its `iva` steps and from nowhere else: the
price and the description come from their step or the call stops, because the
flat fields beside them carry the base price and a second copy (D-070, F-093).
The location is the one field with two live carriers — two real-estate routes
ship no `GeoStep` at all — and it reads from whichever the card has.

The listings are `catalog.items` and nothing else. Avito appends a second list when
a search runs short — near-misses from other regions and of other makes, headed
by a placeholder naming what it relaxed — and those are not answers to the
search: they are dropped, so a search that found nothing of its own ends in
`EMPTY_RESULT` rather than in somebody else's listings (D-072, F-094).

The consumer flow is one chain around one carrier of state, the canonical `searchUrl`:

```
get-location <city>             → locationId
search <query> --location-id    → items + searchUrl
get-filters <searchUrl>         → keys, options, what is applied, what rebuilds the form
apply-filters <searchUrl> --set → items + a new searchUrl
get-page <searchUrl> --page 2   → the next page
get-item <url>                  → the full text, and the photos as files
```

Photos are the one thing this CLI writes rather than returns. `get-item
--images-dir <dir>` fills `<dir>/<itemId>/` with `01.jpg`, `02.jpg` … in gallery
order and puts the paths in `images`; every other command reports `imageCount`
and nothing more (D-059, D-061). No image is converted: the CDN answers jpeg to a
request that asks for jpeg (F-086).

One exception to "any `searchUrl` is good input for the next step":
`apply-filters` and `move-category` accept page 1 only and reject a URL carrying
`p=<n>` with a typed error rather than silently resetting it. So the order is
fixed — filters and category first, depth after.

## Register of failures

Two classes of fail-closed refusal remain (F-055, F-057). Neither returns wrong
data, each disables a whole top-level category, and the refusal only arrives on
the call — you cannot see it coming from the listing.

| Class | Whose shape it is | What it disables | Where it gets fixed |
|---|---|---|---|
| `get-filters`: a named filter with no `defaultTitle` | the category's | flat rentals, garages (and vacancies, out of scope) | phase 13 |
| listing decoder: an item URL it will not accept | the category's | a jobs query mixing résumés and vacancies (F-088) | not planned — Jobs is out of scope |

Four classes left this list, and each time it was wrong not about the defect
existing but about what the defect disabled.

- The storefront slug with a dot in the `sellerId` decoder — the only one whose
  shape belonged to the **seller** rather than the category; it left along with
  the field (D-038). It was found in Electronics, a category already walked twice.
- The sectioned `sectionedMultiselect` form was filed under tyres and wheels
  while it actually held all of Transport shut: both transport branches died on
  it without ever reaching the `slider` the phase had been written for
  (D-040, F-060).
- The unknown API type was filed under "movers" while it held all of Services
  shut: `bannerCheckBoxWithImage` is present on all 12 routes checked. It turned
  out to be a checkbox with no vocabulary, applied with the value `1`
  (D-041, F-062).
- The résumé refusal was not fixed but removed: it lived in the listing decoder's
  photo reader, and the photos left the listing item (D-061, F-087). What that
  freed is one route of Jobs, not the category — the same query mixed with
  vacancies refuses on something else entirely (F-088), and Jobs is no longer on
  the plan.

Hence how to read this table: the "what it disables" column names where the
class was observed, not the boundary of its effect. For each remaining class the
question "whose shape is this, and where else does that shape occur" has to be
asked separately.

## Category coverage

The unit of work is a top-level Avito category, not a command: data shape belongs
to the category, so "works" only means something per category. There are 12, and
three of them are out of scope by decision, not by defect — Jobs, Business and
equipment, Business 360 are not planned and will not be walked. Of the nine that
remain, a category counts as walked when all ten commands pass on its routes, not
just `search`.

| Category | State |
|---|---|
| Transport | walked (cars, motorcycles, trucks and machinery, watercraft, cross-enduro) |
| Real estate | partial — `search` reads rentals and sales, `get-filters` fails on the category (phase 13); the daily-rental route is not a catalog at all (F-082) |
| Jobs | out of scope — not planned |
| Services | walked (cleaning — all ten commands; movers, health, computer help, roofing, category root) |
| Personal items | walked (clothing, prams, category root) |
| Home and garden | walked (furniture, appliances, category root) |
| Parts and accessories | walked (tyres, rims, wheels, car parts and by make, truck parts, mats, all eight subcategories of the root) |
| Electronics | walked (phones, consumer electronics, audio/video, RAM, GPUs) |
| Hobby and leisure | walked (bicycles, sport, tools, tickets) |
| Animals | walked (dogs); a second subcategory is topped up in phase 18 |
| Business and equipment | out of scope — not planned |
| Business 360 | out of scope — not planned |

57 routes walked; that is a lower bound, not full coverage even of the green
categories. The same table, in Russian and without the route detail, is in the
[README](../README.md#покрытие-категорий).

The same rule applies inside a category. "Parts and accessories" was recorded as
"`get-filters` open" on the strength of one branch — tyres — while a neighbouring
branch of the same tree carried two refusals at once: the car picker's form and a
vocabulary of 12150 values (F-066, F-067). A green command on one route says
nothing even about the next route of the same category.

## Standing blockers

Cross-cutting. Risks specific to one command are in its domain file.

- Anonymous direct GET answers `429`, `server: QRATOR` and a CAPTCHA;
  browser-side IP blocks recurred across sessions and can recur at any moment.
  Nothing here works around the protection: it stops without touching the
  challenge.
- A safe request rate has never been measured, and the fixed gaps between
  requests were removed (D-035). The first candidate measurement turned out to
  be a refusal on the page past the last one, not a rate limit (F-061).
- **`price` still does not say what it counts.** A floor travels as `minPrice`
  and a table as `hasPriceList` (D-056), but a rate does not: «150 ₽ за м²» is
  `price: 150`, the unit sits in the payload and in no field (F-077). Nothing
  refuses, and no expectation catches a wrong number — only a wrong shape.
- A service's price list exists twice and the two copies disagree: the search
  card's is the index's and goes stale, `get-item`'s is what the page prints
  (F-081). Only the second one is returned.
- `get-page` past the last page of results receives `429` and calls it a CAPTCHA
  or a rate-limit cooldown. The data is not corrupted, but the caller is handed
  the wrong diagnosis — phase 20.
- A query that lands on Avito Travel («квартира посуточно») comes back as
  `EMPTY_RESULT: No listings match the requested query`, which is the same wrong
  diagnosis in another place: the route carries no catalog at all (F-082), and
  the listing is not empty.
- One category is partly unavailable and three are out of scope, and a refusal
  only arrives on the call — see the register above.
- Every command depends on the undocumented internal shape of the SSR bootstrap
  and on seven undocumented endpoints. Any drift must end fail-closed.
- The shared listing decoder serves four listing commands, so one drift moves four.
  Since D-070 the price and the description refuse rather than answer from
  another carrier; what is left silent is the location, which has two live
  carriers, and the unit of a rate. The shared `LISTING_ITEM` schema catches a
  wrong *shape* on all four at once and says nothing about a wrong *meaning*.
- `sellerName` is defended by no live check at all (D-028) — only the offline
  suite and human eyes.
- This repository has no remote: the history exists, a copy does not.
- Write operations (favourites) will need their own contract and protection
  against unintended mutation — deliberately not started.
