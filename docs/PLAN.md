# Plan

Updated: 2026-08-19

The future only. What is already done is in [STATUS.md](STATUS.md) and in git.

Two blocks, and the first one comes first. Phases 25 and 27–29 are what one
consumer session found by using the skill blind on a real task — a services
search in Moscow; phase 30 came from counting an answer field by field. Every
claim in them was replayed live before it was written down.
Phases 13–21 are the category walk: the unit of work there is a top-level Avito
category, not a command, because data shape belongs to the category. Of twelve
categories, three are out of scope by decision and will not be walked — Jobs,
Business and equipment, Business 360. Eight of the remaining nine are walked;
Real estate is the one left, and it is phase 13.

Order between the blocks is fixed; inside a block the order between phases is
free, and inside a phase it is top to bottom.

The register of failures and the coverage table are in [STATUS.md](STATUS.md).

## Coverage gaps

Known holes in the checks themselves, as opposed to holes in what Avito lets us
read. Neither is urgent and neither is free.

- [ ] `search` has no offline coverage of its geo *directory* reads beyond the
      radius list, and no expectation exercises `--metro` / `--district`. It was
      checked live by hand when `src/site/` was extracted (D-047); that check is
      repeatable by nothing in the repository.
- [ ] `sellerName` is defended by no live rule at all (D-028) and cannot be — a
      required field applies to every element at once. Only the offline suite and
      human eyes stand behind it.
- [ ] `location` is in the same class and for a sharper reason: it was null on 45
      of 50 on the one page it was counted (F-095), so no expectation can require
      it and none does. A decoder that stopped reading the geo carrier entirely
      would look exactly like that page.

## What a new field still costs

The ceilings are 40 declared fields and 3 objects deep (D-074), so the phases
below do not bid against one another for a slot. What a field still costs is
meaning — what it says when the value is missing — and payload, which it pays
wherever it repeats. Before adding one, answer where it goes: identical across
every element is the envelope, different between them is the element (D-073).

## Phase 25 — Partial degradation of an optional field

The class has no live instance left. The review photos it was written around are
gone with D-061, and the one place a caller can now lose part of an answer is
`get-item --images-dir`, where a single unreadable photo of twelve ends a call
whose text was the point (D-059). That is the same question in a place where the
caller can at least re-run without the flag, which is why this sits below the
category walk rather than above it.

The rule stands — a command returns correct data or throws. What is missing is a
way to say "this element is here, one optional part of it is not".

- [ ] Draw the line where it belongs: the shape of the response and the required
      fields of an element fail closed as today; an optional media field of one
      element degrades that element. Anything that changes what a *required*
      field says stays a refusal.
- [ ] Find the carrier for "part of this element is missing". Silently returning
      the element without its photos is the fallback value this repository does
      not do. A field states it in the contract; a typed warning on stderr is
      part of no contract yet. This one is a stop-and-ask.
- [ ] Decide it against `get-item --images-dir`, which is the only carrier of
      the class now: eleven files on disk and one refusal is a shape a field
      could state, and today it is a refusal instead.

## Phase 27 — The seller as an entity

A caller choosing an executor works seller by seller, and the CLI has no seller.
`sellerName` is a string on a card; that seven of the fifty were the same shop
was discovered by noticing repeats.

The identity is in the payload, three times over, on `4045441344`:
`buyerItem.userHashedId` (`944d1e…`), `buyerItem.seller.hashId` (`cc39a1…`),
`buyerItem.rating.userKey` (`1667625…`), plus `item.userId` (`82922703`),
`item.shop` (`{ domain: "i82922703", id: 187313, isShop: true, name }`) and
`linkLoggerShop.profileUrl` (`brands/i82922703?…`). `publicProfile` is `null` on
this one.

- [ ] Establish which key addresses which page, and for whom. A shop resolves
      through `/brands/<domain>`; a private seller has no `shop` at all, and
      `get-seller-reviews` already reaches a feed by a key of its own — start from
      what that command resolves and why.
- [ ] Owner's note, and the reason this is not a one-liner: a profile in Services
      is not the profile of a goods seller. Research the closed categories before
      designing the output, not after.
- [ ] Then `sellerUrl` on `get-item` (a field of its own) and
      `get-seller-items` as its own command, which is the scenario the whole
      request came from: everything this seller offers, in one call.

## Phase 28 — Which category a search silently landed in

The location half of this is answered: `locationId` and `locationName` are on the
envelope of all four listing commands, read off the response rather than off the
argument (D-073). The category half is not.

Three searches landed in three different categories (`/predlozheniya_uslug`,
`/moskva`, `/bytovaya_elektronika`), which makes their results incomparable, and
today that is inferable only from the slug of `searchUrl`.
`searchCore.categoryId` is the carrier — `null` when Avito determined none, which
is itself the fact a caller most needs, and which is visible today only as several
current branches in `get-categories` (F-084) — and every card carries its own
`category`.

- [ ] The card's own `category` and `searchCore.categoryId` are not the same
      question — one is per element, the other per search, so they land in
      different halves of the answer. Decide which one the caller needs before
      adding either.

## Phase 29 — `get-item` one URL at a time

The natural shape of the work is a wide search and then a handful of candidates:
fifty listings, seven kept, seven separate calls. `get-item url1 url2 url3` removes
six round trips from the most common flow there is.

- [ ] Decide what a batch does when one URL of seven fails. Fail-closed says the
      call ends; the value of the batch says the other six are still true. This is
      phase 25's line drawn on a different axis, and the two answers should not
      contradict each other — `--images-dir` already answers it one way for one
      photo of twelve (D-059).
- [ ] Count the requests before promising the saving. `get-item` falls back from
      the item API to a rendered page, and seven renders in one call is a
      different load profile from seven commands — the untested question of a
      safe request rate sits under this one.

## Phase 30 — Does `location` earn its slot

`location` was counted once: 45 of 50 null on a Moscow goods route where every
other field of the card was filled (F-095). One route is not the answer, and two
different questions are tangled in that number.

- [ ] Count it on routes where a place is the point — flats, services, a region
      with no metro. If it is filled there and empty only on goods, it is an
      honest field with a narrow domain; if it is empty everywhere, it is a field
      that costs payload on fifty entries to say nothing.
- [ ] Read the two carriers apart before deciding. `card.mjs` takes
      `geo.geoReferences[0]` with its walking time, or the plain city, and the
      count above does not say which of the two went missing — or whether both
      were absent because Avito drew no geo line at all.
- [ ] Only then the D-038 question, in its usual form: name the action a caller
      takes on `location` that they cannot take on `searchUrl` and `get-item`. If
      there is none, it goes; if there is one, it is worth a live rule on a route
      where the field is known to be filled.

## Phase 13 — Real estate

Fails entirely on `get-filters`: `Avito filter <key> has no stable name`.
Confirmed on flat rentals (`снять квартиру 2 комнатную`) and garages
(`гараж купить`).

- [ ] Decide what names a filter that has no `defaultTitle`. Avito sends `null`
      as a matter of course: `categoryId` (`select`, 7 values), `params[201]`
      (`select`, 4), `params[504]` (`multiselect`, 2) on rentals, `params[204]`
      on garages. Today only single-option filters survive, by accident — the
      name is borrowed from the name of that one option.
      Since D-037, unnamed `hidden` filters no longer kill the command because
      they are no longer returned, which leaves exactly the case of a named
      filter with options.
- [ ] Decide separately what `categoryId` is. The only `select` seen whose key
      is not `params[...]`: it cannot be applied, so since D-037 it simply is not
      returned. Confirm that this is correct rather than a side effect of the
      `params[...]` rule — if it can be applied, this category needs a way to
      pick a subcategory by filter and not only through `move-category`.
- [ ] Walk the category: flat sales and rentals, houses, land, garages,
      commercial. Daily rentals are not on this list and cannot be: that route is
      a different Avito product with no catalog in it at all (F-082).
- [ ] Check the semantics of a listing card on the routes the price fields have
      not seen — houses, land, garages, commercial. Rentals and sales were read
      live on 2026-08-18: 100 cards, every one a plain number, no floor and no
      price list, so nothing there argues with the goods reading of `price`
      (F-079). Commercial rent is the one route where a rate («₽ за м²», F-077)
      is likely, and it is the one that has not been read.

## Phase 18 — Topping up the walked categories

- [ ] Animals is confirmed on one route (dogs). Walk a second subcategory: until
      you check, "one green subcategory" says nothing about its neighbour.
- [ ] Re-check the walked categories against each defect separately rather than
      against a route. For each remaining failure class, ask whose shape it is —
      the category's or the seller's — and count a green mark as proof only for
      the former (F-057).
- [ ] After phase 13, walk all 57 routes again and record how many pass.
      A cheap regression: one SSR fetch per route.

## Phase 20 — The page past the last one answers `429`

`get-page` past the end of the results receives `429` and calls it "human
verification or a rate-limit cooldown". Reproduced on two categories: page 2 of
filtered cars (28 listings, there is no second page) three times, page 3 of motor
oil (79 listings) twice, with pages inside the range on the same routes passing
in between (F-061).

- [ ] Separate the two causes. The same URL read from a long-lived primed tab
      answers `200` with a full catalog document, so it is not the URL. Candidates:
      Avito answers `429` to an out-of-range page specifically for a
      cookie-poor session, or the command's context differs in some other way.
      Until that is separated, this is not a rate-limit measurement.
- [ ] Decide with the second carrier in hand. Since D-063 `get-page` reads the
      document first and the items API second, and the two disagree at exactly
      this boundary: page 25 of a 19-page result answers `200` with an empty
      catalog on the API and `429` on the document (F-091). So "there is no such
      page" is already answerable — the question is whether `get-page` may reach
      it, which means reading the page-1 document for the search and letting the
      API answer for the page. That trades one postcondition: today the document
      proves the page number and the API confirms it, and there it would be the
      API alone. The API also returns `count`, which no command exposes.
- [ ] Type the refusal on the strength of the answer. If it means "there is no
      such page", the caller needs `EmptyResultError` and not a diagnosis about
      CAPTCHA; if it is protection, the message is right, but then every request
      past the end of results must answer the same way, and that needs checking
      on a third category.
- [ ] While there, check `get-seller-reviews`: an offset past the end of the
      review feed already returns a typed empty result, and it is worth
      understanding why two commands behave differently at the same boundary.

## Phase 21 — What the schemas left behind

D-048 put the output contract in the descriptors and D-049 the live
expectations. Two things they exposed rather than solved:

- [ ] Tighten what the expectations claim, now that they can claim it. `search`,
      `get-page`, `apply-filters` and `move-category` pin their envelope; the
      other six pin less than one live run would let them. Open, and not to be
      guessed: does the `get-filters` route carry a `price` key, is the
      `get-page` count the same as page 1's.
- [ ] Now that the carriers are settled (D-063), tighten what the four listing
      expectations claim about a complete page. Each asserts a non-empty
      `descriptionPreview`; none yet asserts that the page is fifty listings, or
      that `location` and `sellerName` survive where Avito sends them — which is
      what would catch a silent return to the document catalog.

## Open questions

- **Whether a gap between requests is needed.** Still unmeasured, and the first
  candidate was the wrong one: the `429` caught at a density of about 37 requests
  in 106 seconds reproduces in silence too — it is a refusal on the page past the
  last one, not a rate limit (F-061). "The first `429` without a gap" is only
  worth recording when the refusal arrived on a request that passes in silence.
- **The vocabulary of `publishedText` forms.** Two collected live: `14 августа в
  02:15` and `вчера в 19:15`. The second matters more than the first — it shows
  Avito also prints a relative day, so the string sometimes carries no number at
  all. `сегодня в …` and last-year forms (with or without a year) have not been
  observed, so the field is still handed over as a string and not parsed (D-039).
- **What is still not applicable.** Two kinds of key. `hidden` is a constraint of
  the route rather than a filter, and the only question about it is whether it is
  ever a control in the visible form. `footWalkingMetro` and `categoryId` are keys
  that are not of the `params[...]` form: first find the carrier in `searchCore`,
  then talk about applying them. The rest is closed: `keywords` applies (F-064)
  and an enum with an empty vocabulary turned out to be a group heading (F-065).

## Definition of done for a command

- Fresh evidence with a replay, recorded in its domain file.
- Arguments and the output contract fixed in the descriptor and visible through `--help`.
- Fields and units compared against the visible page.
- Errors typed: no silent empty, no sentinel value, no silent clamp.
- A live expectation that catches empty and swapped fields.
- The offline suite and `npm run check` green.
