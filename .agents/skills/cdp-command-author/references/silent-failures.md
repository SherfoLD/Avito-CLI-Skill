# Silent failures

Twelve ways a command looks fine, passes every check, and returns wrong data.
None of these is a style opinion — each one happened.

Read this at Step 6 (decoding) and again at Step 11 (comparing against the page).

---

## 1. The fixture was relaxed to make verify pass

**What you see.** `verify` reports `pattern "url" does not match /^https:\/\/www\.avito\.ru\/[^?]+_\d+$/`. Widening the pattern makes it green.

**What is actually wrong.** The command lost a URL prefix, kept a query string, or picked up a relative path. A failing pattern is the check working.

**Defence.** A failing fixture means the command is wrong. Tighten the command. The only legitimate reason to edit a fixture is that Avito changed shape — and then the fact goes into the domain file in the same commit.

---

## 2. The fixture was written from the same assumption as the code

**What you see.** Nothing. Both agree.

**What is actually wrong.** `patterns.sellerId` in all five fixtures was `^[A-Za-z0-9_-]+$`, exactly the alphabet the decoder enforced. When a real seller slug turned out to be `agent.pc`, the fixture failed *after* the decoder was fixed — it had never been an independent check.

**Defence.** A fixture rule should come from the visible page, not from the code you just wrote. Ask "where did I learn this constraint" — if the answer is "from my own implementation", it is not a check.

---

## 3. Field contamination that `notEmpty` and `columns` both pass

**What you see.** `description` is non-empty and verify is green. By eye, the description contains `address: …` or a category name that belongs to a sibling node.

**What is actually wrong.** `textContent` of a container includes every descendant.

**Defence.** `mustNotContain` in the fixture, listing the bleed you actually saw. On the command side, a more precise anchor. Never trust `textContent.trim()` as sufficient.

---

## 4. Two fields both look right

**What you see.** A date that is a valid date, in the right format, and a month off.

**What is actually wrong.** Two fields are both legitimate and mean different things. `item.priceDetailed` is the base price and `iva.PriceStep[].payload.priceDetailed` is the price the card prints; both are numbers, both are plausible, and only one is what the user sees. Same for `activeReviewsCount` (1519) against the visible `rating.summary` (`1500 отзывов`).

**Defence.** Decoding is not finished until one known record has been compared against the page by eye. Write the meaning into `docs/field-map.json` precisely — "the price shown on the card, bonuses applied", not "price".

---

## 5. Units

**What you see.** A number off by a factor of 10, 100 or 1000.

**Defence.** `mustBeTruthy` catches a `|| 0` fallback but not a scale error. Comparing against the page has to compare the *magnitude*, not just the presence of digits.

---

## 6. The flat field that is always there and always wrong

**What you see.** Every row has a `location`, and most of them are null. Every row has a `description`, and all of them are empty.

**What is actually wrong.** On this site the flat item object is a decoy. `item.description` is empty in the SSR catalog, `item.location.name` was null on 39 of 50 rows, and `item.priceDetailed` is the base price. The visible values live in the `iva` steps.

**Defence.** When a field exists on every row and is empty on most, that is a signal you are reading the wrong carrier — not that the data is missing. The `descriptionPreview` divergence between commands went unnoticed for exactly this reason, because `descriptionPreview` was not in `notEmpty` (F-041).

---

## 7. `|| 0` and `?? 'unknown'`

**What you see.** Every post has 0 likes. Every seller is `unknown`.

**Defence.** `mustBeTruthy` on numeric columns; `npm run check:typed-errors` on the sentinel. Prefer `?.` to `||`. Every `|| 0` needs one question answered: is 0 a legal value here, or is this a missed read?

---

## 8. Waiting a fixed time instead of for the thing

**What you see.** The network list is empty, so you conclude the page is static.

**What is actually wrong.** The request had not been made yet.

**Defence.** Wait for the specific condition — the request, the element — not for a number of seconds. If you must wait blind, wait, look, and then wait for the thing you saw.

---

## 9. A stale tab, mistaken for a rate limit

**What you see.** Fetches from your recon tab start timing out at ~115 s. It looks like the site throttling you.

**What is actually wrong.** The tab is hung. The same URL from a fresh tab answers in 2 s, and the command answers normally throughout.

**Defence.** Open a new tab before theorising. Never record a timing observation from a tab you have been hammering as a measurement of Avito's limits.

---

## 10. A `429` that is not about frequency

**What you see.** A `429` at the end of a dense series of requests. It looks like the first measurement of the rate limit.

**What is actually wrong.** The same call repeats the `429` after a seven-minute pause and in complete silence. What separates the cases is not time but the page: past the last page of results, `429` always comes. The same URL read from a long-lived primed tab answers `200` (F-061).

**Defence.** A number is a rate-limit measurement only if the failing request passes in silence. Otherwise you are about to write a false fact into memory that the next session will act on.

---

## 11. A green category proves nothing about its neighbour

**What you see.** Electronics passes, so the decoder handles electronics-shaped data.

**What is actually wrong.** The failure class you are tracking may belong to the *seller* rather than the category. The storefront slug with a dot broke a category that had been walked twice, because any seller anywhere can have one. Meanwhile "Parts" was marked open on the strength of one branch while a neighbouring branch of the same tree carried two separate refusals.

**Defence.** For each failure class ask whose shape it is — the category's or the seller's — and count a green run as proof only for the former. The register in `STATUS.md` lists where a class was *seen*, which is not where it *lives*.

---

## 12. Accepted is not applied

**What you see.** The request returns `200`, the key appears in the state, and the postcondition passes.

**What is actually wrong.** Avito echoes a `params[...]` key it did not apply: the key is in `searchCore.params`, the result count has not moved, and `filtersV2.currentValue` is empty (F-062). Conversely, for the five short keys `filtersV2.currentValue` is stale on a correct response (F-032).

**Defence.** Know which carrier proves application for the key you are setting, and check that one. Checking both where both are meaningful is not belt and braces here — it is the only thing that separates applied from echoed.

---

## What they have in common

1. **Green does not mean right.** The checks prove the structure did not break. They cannot prove a value is the value. Comparing against the page by eye is a required step, not a nicety.
2. **A field with a value is a more dangerous failure than an empty one.** Empty makes you look. Plausible makes you move on.
3. **The fixture rules work as a set.** `patterns` catches format, `notEmpty` catches loss, `mustNotContain` catches bleed, `mustBeTruthy` catches fallbacks. Three of the four leaves a hole.

When you find the thirteenth, write it here.
