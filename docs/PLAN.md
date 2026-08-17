# Plan

Updated: 2026-08-17

The future only. What is already done is in [STATUS.md](STATUS.md) and in git.

Two blocks, and the first one comes first. Phases 23–29 are what one consumer
session found by using the skill blind on a real task — a services search in
Moscow — and every claim in them was replayed live before it was written down.
Phases 13–21 are the category walk: the unit of work there is a top-level Avito
category, not a command, because data shape belongs to the category. Eight of
twelve are walked, four are not.

Order between the blocks is fixed; inside a block the order between phases is
free, and inside a phase it is top to bottom.

The register of failures and the coverage table are in [STATUS.md](STATUS.md).

## Coverage gaps

Known holes in the checks themselves, as opposed to holes in what Avito lets us
read. Neither is urgent and neither is free.

- [ ] `search` has no offline coverage of its geo *directory* reads beyond the
      radius list, and no fixture exercises `--metro` / `--district`. It was
      checked live by hand when `src/site/` was extracted (D-047); that check is
      repeatable by nothing in the repository.
- [ ] `sellerName` is defended by no live rule at all (D-028) and cannot be —
      `notEmpty` applies to every row. Only the offline suite and human eyes
      stand behind it.

## The twelve-key ceiling

Four of the phases below want a new column, and three of them cannot have one for
free: `MAX_ROW_KEYS` is 12 and both `search` and `get-item` are at 12 today. So a
new column is a swap, not an addition, and the swaps are not independent of one
another — `imagesPreviews` and `images` are the two candidates everything else is
queueing behind (phase 26). Decide the ceiling before the columns: either it
holds and the phases below bid for two slots, or it moves and that is its own
decision with its own reason.

## Phase 23 — A service has a price list, not a price

The largest data defect found, and it is not a parse failure. Replayed on
`4045441344` and `8000518854`, both in Services:

- the item API (`/items/ads<pathname>`) sends `item.price: null` and
  `formattedPrice` empty — `isHasValue: false`, `value: 0`, `string: ""`,
  `buyerItem.priceString: ""`. There is no scalar price to lose;
- the price lives in `item.priceList.groups[].values[]`, each `{ title, price,
  subPrice, serviceId, url }` with `price` as Avito's own string: `от 5 000 ₽`,
  `Цена договорная`, `1 ₽`;
- the search card carries `priceDetailed.fullString: "от 490 ₽"` beside
  `value: 490`, and its own `priceList` — `valuesAll` (the whole list),
  `values` (the two Avito draws) and `countHint: "Ещё 5 услуг"`.

So the row's `price: 490` is the floor of a price list printed as if it were a
price, and `get-item`'s `null` is honest but useless. Sorting and comparing by
price across services is meaningless today, and nothing in the output says so.

- [ ] Name the carrier of "from" before writing any code. `priceDetailed.string`
      begins with `от`, and reading that is text-scanning Avito's dialect. Look
      for a structural flag on the card first, across services and at least one
      goods route where the same field carries a plain number.
- [ ] Decide what `price` means in a listing row once "from" is known. A boolean
      beside it (`priceIsFrom`) states the fact without changing what `price` is;
      a null price on services states it by refusing. Both are defensible, only
      one costs a column (see the ceiling above).
- [ ] Decide what `get-item` does with `price` on a service. It may not invent the
      minimum of the list — that is a fallback value. Either null stays and the
      list is returned, or the command refuses a shape it has no column for.
- [ ] The price list itself, on both carriers. It is a table inside a row, which
      the flat 12-key contract has no form for: `get-item.attributes` is the
      precedent for a nested object in a row, and `countHint` says the card's
      `values` is a truncation while `valuesAll` is not.
- [ ] Check which other categories ship `priceList`. It was found in Services;
      whose shape it is — the category's or the seller's — has to be asked
      separately (F-057), and the answer decides whether this is a services
      phase or a row-contract phase.
- [ ] `attributes` on a service already carries what the page prints as
      «Подробности» (`График работы`, `Чем занимается исполнитель`,
      `Производители`, `Техника`) — confirmed live on `4045441344`. Compare it
      field by field with the visible block before assuming it is complete.

## Phase 24 — `get-categories` dies exactly where it is the only way out

`avito get-categories` on `https://www.avito.ru/moskva?q=замена+аккумулятора+macbook+air+m2`
answers `COMMAND_EXEC: Avito category sidebar node 1000007 has inconsistent
type/state`. The sidebar behind that refusal, read raw:

| id | type | name | isCurrent | isOpened | children | url |
|---|---|---|---|---|---|---|
| 1000063 | 0 | Услуги | true | true | 2 | `/moskva/predlozheniya_uslug?cd=1&q=…` |
| 1000007 | 0 | Электроника | true | false | 2 | `/moskva/bytovaya_elektronika?cd=1&q=…` |

with two navigable `type=1` children under each. `searchCore.categoryId` is
`null`: Avito determined no category and drew several candidate groups instead.
Two invariants fail at once — a `type=0` node that is not `isOpened`, and two
nodes claiming `isCurrent`. The second one would refuse the call even if the
first were relaxed.

This is the case where the command matters most: no category was chosen, so
`move-category` is the only correction available, and it takes its `--to` names
from this output alone. One refusal disables both.

- [ ] Establish what Avito draws here against the visible page before touching the
      invariants. "Expanded branch" and "the current category" were read off a
      route that had a category; a route without one may be a different mode, and
      guessing it from the payload is how a wrong opinion gets written down.
- [ ] Decide what `isCurrent` on more than one group head means, and what the
      `current` column then says. The "multiple current categories" refusal is a
      second decision, not a consequence of the first.
- [ ] Both group heads carry a URL with `?cd=1&q=…`, and today it is dropped
      because `type=0` is not navigable — deliberately, as a control (F-034).
      On this route that URL is the whole answer: it is the way into `Услуги`
      keeping the query. Decide whether `navigable` is a property of the type or
      of the presence of a URL, and check the answer against a route that does
      have a category, where the rule was written.
- [ ] Then check the pair end to end: `move-category --to Услуги` from this URL,
      with the postconditions that already exist — the route Avito named, page 1,
      the location unchanged, `searchCore.query` preserved.
- [ ] This closes the `--category` request on `search` as well: a search that
      lands in no category is exactly when a caller wants to name one, and the
      sidebar already hands over a URL that does it. Nothing in `search` needs a
      new argument if this works.

## Phase 25 — Partial degradation of an optional field

The review images defect is fixed (F-075), the class behind it is not. One
optional media field of one element killed a page of 25 reviews whose text was
intact and was the whole point of the request.

The rule stands — a command returns correct data or throws — and the fix does not
weaken it: a review without its photo is not a lie, it is a review with a photo
we could not read. What is missing is a way to say that.

- [ ] Draw the line where it belongs: the shape of the response and the required
      fields of an element fail closed as today; an optional media field of one
      element degrades that element. Anything that changes what a *required*
      field says stays a refusal.
- [ ] Find the carrier for "part of this element is missing". Silently returning
      the element without its photos is the fallback value this repository does
      not do. A column is a column (see the ceiling); a typed warning on stderr
      is not part of any contract yet. This one is a stop-and-ask.
- [ ] Do it in one place. Phase 21 already has the three copies of the
      largest-variant rule with three failure contracts (`card.mjs` throws,
      `item.mjs` returns `null`, `get-seller-reviews` throws typed) — that
      inventory is the input to this decision, and this decision is what tells
      the three copies apart or merges them.

## Phase 26 — Images cost more than they return

`imagesPreviews` is five opaque URLs per row and fifty rows per search: it
dominates the payload of every `search`, and a text task uses none of them. The
originals are only in `get-item` anyway, so the previews buy nothing but volume.

Owner's proposal, to be discussed before it is built: drop the image columns from
the output and add `--with-images <dir>`, where the caller passes a private tmp
path and the command downloads the photos there, converted to png, so a human can
look at them. The same flag for every command that has images.

- [ ] Discuss it first. This is the first command that writes to disk, the first
      that fetches a binary, and png conversion needs a decoder this repository
      does not have. "Read-only" currently means "read-only against Avito" and
      would come to mean something else.
- [ ] Decide what the row says instead. A count, a file path per image, or
      nothing — and what happens when one photo of five fails to download, which
      is phase 25's question in another shape.
- [ ] Whatever is decided, this is where the two free columns come from. Nothing
      in phases 23, 27 or 28 should be planned as if they were already free.

## Phase 27 — The seller as an entity

A caller choosing an executor works seller by seller, and the CLI has no seller.
`sellerName` is a string on a row; that seven of the fifty rows were the same
shop was discovered by noticing repeats.

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
- [ ] Then `sellerUrl` on `get-item` (a column, see the ceiling) and
      `get-seller-items` as its own command, which is the scenario the whole
      request came from: everything this seller offers, in one call.

## Phase 28 — What a search result silently is

Two facts decide how a result reads, and both are inferred from the slug of
`searchUrl` today.

**Location.** `search` without `--location-id` returned Moscow, and the only
evidence was `/moskva/` in the URL. `searchCore` carries `locationId: 637640`,
`locationName: "Москва"` and `geoCoords`, and none of it reaches the output.
`--help` says "omit to keep the current region"; nothing tells a caller what the
current region is — `avito browser` reports a browser, not a session's region.

**Category.** Three searches landed in three different categories
(`/predlozheniya_uslug`, `/moskva`, `/bytovaya_elektronika`), which makes their
results incomparable. `searchCore.categoryId` is the carrier — `null` when Avito
determined none, which is itself the fact a caller most needs (phase 24) — and
every card carries its own `category`.

- [ ] Decide where a per-call scalar goes in a contract that returns rows.
      `searchUrl` is the precedent: one value, repeated on every row, and it works
      because a caller reads one row. Two more repeated columns is the obvious
      shape and the expensive one (see the ceiling).
- [ ] Read the resolved location off the response, never off the argument. The
      command already knows: an echoed `--location-id` proves nothing (F-037), and
      `locationName` beside it is what the caller asked to see.
- [ ] The card's own `category` and `searchCore.categoryId` are not the same
      question — one is per row, the other per search. Decide which one the caller
      needs before adding either.

## Phase 29 — `get-item` one URL at a time

The natural shape of the work is a wide search and then a handful of candidates:
fifty rows, seven kept, seven separate calls. `get-item url1 url2 url3` removes
six round trips from the most common flow there is.

- [ ] Decide what a batch does when one URL of seven fails. Fail-closed says the
      call ends; the value of the batch says the other six are still true. This is
      phase 25's line drawn on a different axis, and the two answers should not
      contradict each other.
- [ ] Count the requests before promising the saving. `get-item` falls back from
      the item API to a rendered page, and seven renders in one call is a
      different load profile from seven commands — the untested question of a
      safe request rate sits under this one.

## Phase 13 — Real estate

Fails entirely on `get-filters`: `Avito filter <key> has no stable name`.
Confirmed on flat rentals (`снять квартиру 2 комнатную`) and garages
(`гараж купить`).

- [ ] Decide what names a filter that has no `defaultTitle`. Avito sends `null`
      as a matter of course: `categoryId` (`select`, 7 values), `params[201]`
      (`select`, 4), `params[504]` (`multiselect`, 2) on rentals, `params[204]`
      on garages. Today only single-option filters survive, by accident — the
      name is borrowed from the name of that one option. Shared with phase 14.
      Since D-037, unnamed `hidden` filters no longer kill the command because
      they are no longer returned, which leaves exactly the case of a named
      filter with options.
- [ ] Decide separately what `categoryId` is. The only `select` seen whose key
      is not `params[...]`: it cannot be applied, so since D-037 it simply is not
      returned. Confirm that this is correct rather than a side effect of the
      `params[...]` rule — if it can be applied, this category needs a way to
      pick a subcategory by filter and not only through `move-category`.
- [ ] Walk the category: flat sales and rentals, daily rentals, houses, land,
      garages, commercial.
- [ ] Check the semantics of the listing row on real estate: the 12 keys were
      written for goods, and what `price` means on a daily rental has never been
      looked at live.

## Phase 14 — Jobs

Fails entirely, but with two different refusals in the two halves of the category.

- [ ] Vacancies: `get-filters` stops on an unnamed `multiselect` `params[110693]`
      with five values. The hidden `params[196930…196932]` and `params[198006]`
      dropped out of the list after D-037, but that did not open the category.
      Same defect as phase 13; fix it once.
- [ ] Résumés: `search` stops on `item image URL is outside Avito image hosting`.
      Résumé cards carry placeholders on `www.avito.st` (46 URLs out of 288 on a
      page) while the rule admits only `(^|\.)img\.avito\.st$`. `get-filters` on
      résumés passes. The fix lives in the shared row decoder that serves four
      listing commands, so its price is a regression risk on all four.
- [ ] After the fixes, close the case that exists nowhere else, on vacancies:
      three single-value `params[...]` on one route (`196929` radio "Поиск по
      приоритетам", `172815` radio "Формат работы", `827` `select` "Опыт
      работы"). Check both applying them one at a time and all three in one call.
- [ ] Check the semantics of the listing row on vacancies and résumés: `price` is
      a salary, `sellerName` is an employer or a candidate.

## Phase 17 — Business and equipment, Business 360

- [ ] Walk both categories the same way (one SSR fetch per route, no render) and
      record the result. Not a single route in either has been checked.
- [ ] Avito marks "Business 360" as new, so its shape cannot be inferred from
      neighbouring categories: check it separately, not in passing.

## Phase 18 — Topping up the walked categories

- [ ] Animals is confirmed on one route (dogs). Walk a second subcategory: until
      you check, "one green subcategory" says nothing about its neighbour.
- [ ] Re-check the walked categories against each defect separately rather than
      against a route. For each remaining failure class, ask whose shape it is —
      the category's or the seller's — and count a green mark as proof only for
      the former (F-057).
- [ ] After phases 13–17, walk all 57 routes again and record how many pass.
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
- [ ] Type the refusal on the strength of the answer. If it means "there is no
      such page", the caller needs `EmptyResultError` and not a diagnosis about
      CAPTCHA; if it is protection, the message is right, but then every request
      past the end of results must answer the same way, and that needs checking
      on a third category.
- [ ] While there, check `get-seller-reviews`: an offset past the end of the
      review feed already returns a typed empty result, and it is worth
      understanding why two commands behave differently at the same boundary.

## Phase 21 — What the schemas left behind

D-048 moved the row contract into the descriptors and D-049 the fixtures.
Two things they exposed rather than solved:

- [ ] Tighten what the fixtures claim, now that they can claim it. Each was
      converted faithfully (D-049), so most still say only what the JSON dialect
      could. Reading one live run per command would answer, for example: is the
      applied `user=2` visible in the `apply-filters` searchUrl, does the
      `get-filters` route carry a `price` row, is the `get-page` count the same
      as page 1's. None of those may be guessed.
- [ ] The largest-image-variant rule exists in three copies with three failure
      contracts: `largestImageVariant` in `src/browser/prelude/card.mjs` throws,
      `decodeItemImages` in `src/browser/prelude/item.mjs` returns `null` for the whole
      item, and `decodeReviewImages` in `get-seller-reviews` now throws a typed
      error. The rule is the same in all three (F-047); only what a caller does
      about a violation differs. Decide whether that difference is real before
      unifying them — the browser half cannot import from Node, which is half the
      reason there are three.

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
  observed, so the column is still handed over as a string and not parsed (D-039).
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
- Errors typed: no silent empty, no sentinel row, no silent clamp.
- A verify fixture that catches empty and swapped fields.
- The offline suite and `npm run check` green.
