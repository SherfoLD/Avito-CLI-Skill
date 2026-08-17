# State

Updated: 2026-08-16

Facts only: what works, what does not, and why. The future is in [PLAN.md](PLAN.md).
How each command is built is in its domain file, [docs/areas/](areas/).

## Commands

Ten commands, all read-only. `npm run check` is green; the offline suite is 208
checks across sixteen suites. All ten fixtures pass live against the descriptor
schemas (D-048, D-049).

The row contract is a `z.strictObject` in each descriptor: `columns` is derived
from it, the CLI parses every row through it before printing, the offline suites
run the same parse, and `--help` prints the schema itself as a type (D-053). A `verify/<command>.mjs` fixture is a schema over the
whole returned array, saying what that one request must answer with. What neither
can express is four ESLint rules over the AST (`npm run lint`).

The browser has to be one the user already runs, with debugging on at
`chrome://inspect/#remote-debugging` — a purpose-launched empty profile is
refused by Avito outright (D-044, F-068). Which browser that is gets chosen once
and remembered in `browser.json`: `avito browser` lists the ones offering a
connection, `avito browser use` writes the answer down, and a file is the only
form of this setting an agent can see, since it opens a new shell per command
(D-051, D-052, F-074). The connection is held for the session by a broker;
`avito session status` reports it and the browser it would use (D-045). A
command's tab is hidden — no tab strip entry, no application switch, so the only
interruption left is the one approval prompt per connection (F-071, F-073).

| Command | Domain | Strict live verify |
|---|---|---|
| `search` | [search](areas/search.md) | 2026-08-16 |
| `get-page` | [search](areas/search.md) | 2026-08-16 |
| `get-filters` | [filters](areas/filters.md) | 2026-08-16 |
| `apply-filters` | [filters](areas/filters.md) | 2026-08-16 |
| `get-categories` | [categories](areas/categories.md) | 2026-08-15 |
| `move-category` | [categories](areas/categories.md) | 2026-08-16 |
| `get-location` | [geo](areas/geo.md) | 2026-08-15 |
| `get-coords` | [geo](areas/geo.md) | 2026-08-15 |
| `get-item` | [item](areas/item.md) | 2026-08-16 |
| `get-seller-reviews` | [item](areas/item.md) | 2026-08-17 |

The consumer flow is one chain around one carrier of state, the canonical `searchUrl`:

```
get-location <city>             → locationId
search <query> --location-id    → rows + searchUrl
get-filters <searchUrl>         → keys, options, what is already applied
apply-filters <searchUrl> --set → rows + a new searchUrl
get-page <searchUrl> --page 2   → the next page
get-item <url>                  → the full text and the original photos
```

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
| `get-filters`: a named filter with no `defaultTitle` | the category's | vacancies, flat rentals, garages | phases 13, 14 |
| row decoder: an image on `www.avito.st` | the category's | résumés entirely | phase 14 |

Three classes left this list, and each time it was wrong not about the defect
existing but about what the defect disabled.

- The storefront slug with a dot in the `sellerId` decoder — the only one whose
  shape belonged to the **seller** rather than the category; it left along with
  the column (D-038). It was found in Electronics, a category already walked twice.
- The sectioned `sectionedMultiselect` form was filed under tyres and wheels
  while it actually held all of Transport shut: both transport branches died on
  it without ever reaching the `slider` the phase had been written for
  (D-040, F-060).
- The unknown API type was filed under "movers" while it held all of Services
  shut: `bannerCheckBoxWithImage` is present on all 12 routes checked. It turned
  out to be a checkbox with no vocabulary, applied with the value `1`
  (D-041, F-062).

Hence how to read this table: the "what it disables" column lists where the
class was observed, not the boundary of its effect. For each remaining class the
question "whose shape is this, and where else does that shape occur" has to be
asked separately.

## Category coverage

The unit of work is a top-level Avito category, not a command: data shape belongs
to the category, so "works" only means something per category. There are 12. A
category counts as walked when all ten commands pass on its routes, not just
`search`.

| Category | State |
|---|---|
| Electronics | walked (phones, consumer electronics, audio/video, RAM, GPUs) |
| Hobby and leisure | walked (bicycles, sport, tools, tickets) |
| Personal items | walked (clothing, prams, category root) |
| Home and garden | walked (furniture, appliances, category root) |
| Animals | walked on one route (dogs) — topped up in phase 18 |
| Transport | walked (cars, motorcycles, trucks and machinery, watercraft, cross-enduro) |
| Real estate | fails on `get-filters` — phase 13 |
| Jobs | fails with two different refusals in its two halves — phase 14 |
| Services | walked (cleaning — all ten commands; movers, health, computer help, roofing, category root) |
| Parts and accessories | walked (tyres, rims, wheels, car parts and by make, truck parts, mats, all eight subcategories of the root) |
| Business and equipment | never checked — phase 17 |
| Business 360 | never checked — phase 17 |

57 routes walked; that is a lower bound, not full coverage even of the green
categories.

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
- `get-page` past the last page of results receives `429` and calls it a CAPTCHA
  or a rate-limit cooldown. The data is not corrupted, but the caller is handed
  the wrong diagnosis — phase 20.
- Two categories are entirely unavailable and two more were never checked, and
  the refusal only arrives on the call — see the register above.
- Every command depends on the undocumented internal shape of the SSR bootstrap
  and on seven undocumented endpoints. Any drift must end fail-closed.
- The shared row decoder serves four listing commands; its drift shows up as
  different semantics, not as a refusal. The shared `LISTING_ROW` schema catches
  a wrong *shape* on all four at once, and says nothing about a wrong *meaning*.
- `sellerName` is defended by no live check at all (D-028) — only the offline
  suite and human eyes.
- This repository has no remote: the history exists, a copy does not.
- Write operations (favourites) will need their own contract and protection
  against unintended mutation — deliberately not started.
