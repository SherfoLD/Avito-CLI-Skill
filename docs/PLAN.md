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
