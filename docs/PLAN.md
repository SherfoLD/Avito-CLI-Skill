# Plan

Updated: 2026-08-16

The future only. What is already done is in [STATUS.md](STATUS.md) and in git.

The unit of work is a top-level Avito category, not a command: data shape belongs
to the category, so "works" only means something per category. Eight of twelve
are walked; the four below are not. The remaining defects close two categories
each, so the phases reference one another instead of repeating the work. The
order between phases is free; inside a phase, top to bottom.

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
