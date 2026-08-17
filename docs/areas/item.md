# Listing and seller — `get-item`, `get-seller-reviews`

Confirmed live: 2026-08-18

Transport and the shared rules are in [_platform.md](_platform.md).

## Contract

`get-item <url>` accepts a full listing URL, normally from a listing row. The
columns are in `--help`, printed from the schema (D-053).

The command is called for three of them: `description` — the full text instead
of the truncated `descriptionPreview`; `images` — the original photographs
(`1280x960`) instead of the catalog previews (`636x636`); and `priceList` — the
price table of a service, which the listing row reports only the existence of
(D-056). The rest are already in the listing row and do not justify a separate
call.
`publishedText` is the one column the listing row states more precisely: there
the same date arrives as the machine-readable moment `published`, here only as a
string, exactly as Avito prints it (F-059, D-039).

`get-seller-reviews <itemUrl>` accepts the same listing URL. Columns:
`reviewId`, `score`, `stage`, `rated`, `authorName`, `authorRole`, `itemTitle`,
`text`, `answerText`, `answered`, `images`, `sellerReviewsCount`. Arguments:
`--sort` (from the seller's own fresh vocabulary) and `--page` (turned into the
server-side `offset = (page - 1) * 25`). Budget: exactly 3 requests.

Neither command touches phone numbers, the messenger, the cart, delivery or
favourite actions. A bare item ID is not supported without a confirmed resolver.

## How it works

`get-item` is API-first: `/items/ads{pathname}` → the listing page's hydration →
the visible DOM. The API URL is built only from the full pathname the user
passed; on HTTP, schema or ID drift the command navigates to the item URL and
reads `window.__staticRouterHydrationData...buyerItem`, then the previous DOM
anchors.

`get-seller-reviews` takes `ratingUserKey` from `buyerItem.rating.userKey` of the
same item API response and requests `/web/7/user/{key}/ratings`. The listing page
is not rendered: from a session primed only with `robots.txt`, both requests
answer `200 application/json`.

`--sort` is validated against **this** seller's fresh `searchParametersV2` and
then cross-checked against the response's `selectedOption`; on deep pages,
against `sortRating` in the server's `nextPage`.

## Decisions

- **D-007 — full URL only.** `get-item` accepts a listing URL, strips the query
  and context, and builds the API route only from a confirmed full pathname. A
  bare ID is not resolved: alias, region and category cannot honestly be
  reconstructed from one ID, and the URL is already the output of `search`.
- **D-009 — API → hydration → DOM.** Primary is a same-origin
  `GET /items/ads{pathname}`, which yields structured fields without loading the
  listing page; the two fallback layers bound the risk of drift in an
  undocumented endpoint.
- **D-017 — three flat nullable seller fields plus `images`, always an array.**
  The fourth was `sellerId`, removed by D-038, and the freed slot went to
  `publishedText` (D-039); `priceList` was the thirteenth column (D-056). Media is
  accepted only from `*.img.avito.st`. The final DOM fallback deliberately returns
  nullable seller fields and an empty `images` rather than opening the gallery,
  and a `null` `priceList` rather than an empty one: the visible table is anchored
  by nothing but its own heading, so that path reports it did not read one instead
  of claiming there is none.
- **D-021 — the review feed accepts a listing URL, and `get-item` does not
  change.** The option "replace one of `get-item`'s columns with `reviewsUrl`"
  was rejected: such a link would just be `<itemUrl>#open-reviews-list`, it
  carries no `ratingUserKey` and it saves no requests. The option "accept
  `ratingUserKey` as an argument" was rejected: it exposes an internal hash, and
  Avito accepts someone else's key silently.

## Facts

- **F-022 — the hidden item API is live, and it has a twin in the hydration.**
  `GET /items/ads{itemPathname}` from a same-origin session returns
  `200 application/json` with `{analytics, buyerItem, redirectCode, redirectUrl}`.
  Navigating naturally to the listing page does **not** make that XHR, because the
  same object already sits in `window.__staticRouterHydrationData`. An important
  field distinction: `item.formattedPrice.string` is the visible personalised
  price, `item.price` is the base one; for WYSIWYG listings the visible text
  corresponds to `descriptionHtml`, not `description`.
- **F-036 — the hydration already contains both the seller and the full gallery.**
  A warning confirmed live: `sellerReviewsCount` must preserve the visible
  semantics of `rating.summary` (`1500 отзывов`) and not be replaced with the
  apparently-precise `activeReviewsCount=1519`. Each photograph arrives in the
  variants `75x55`, `150x110`, `640x480`, `1280x960`; the page renders `640x480`
  and the expanded gallery loads exactly `1280x960`.
- **F-043 — `get-item` already returns the visible bonus price**, so no migration
  was needed for D-020: the command decodes `formattedPrice.string` and returned
  the same number as `get-page` and as the page prints large. The trap next door:
  the microdata `itemprop="price"` on the same node contains the base price, so
  reading the schema.org attribute instead of the text would return different
  semantics.
- **F-046 — seller reviews live only in a modal.** There is no public page
  (`/user/<hashId>/reviews` → `404`); the visible link is the anchor
  `#open-reviews-list` on the same page. The neighbouring
  `item-view/rating-badge-link` leads to reviews **of the product model**, not of
  the seller, and the two must not be confused. The feed's key is a third seller
  identifier, equal neither to `seller.hashId` nor to the segment of the public
  route.
- **A review with no score is its own class of record, not a zero.** Such records
  have no `score` field at all, and `stageTitle` equals `Не договорились`. So the
  visible `reviewCount` counts only scored reviews while `activeReviewsCount`
  counts all: a private seller showed `summary="4 отзыва"` against seven returned
  records.
- **F-075 — a review photo carries its own dimensions beside the size keys.**
  Each entry of `images` is `{"1280x960": url, "640x480": url, "256x192": url,
  "180x135": url, "originalSize": {"width": 720, "height": 960}}` — a structure,
  not a scalar, under a key that is not a size. Item photos have no such
  companion, so a decoder written from `item.imageUrls` refuses every review with
  a photo. The size keys are the only ones read; what a size key may carry is
  checked where the vocabulary is (a structure there is not a URL and must never
  be stringified into one), and the rest of the entry is Avito's to change. The
  variant that wins is the largest offered, and the URL under `1280x960` returns
  the photo at its `originalSize` — 720×960, not 1280×960.
- **The sort vocabulary depends on `fromItem`** and comes from Avito itself: with
  it, `goods_relevant_desc` is available; without it, not. The availability of the
  "photos only" filter is dynamic too and differs between a private seller and a
  company.

- **F-070 — the order of `attributes` is Avito's and is not sorted.** Condition
  parameters first, then category parameters — the order the page prints them
  in. The decoder has never sorted them; the previous system's JSON serializer
  did, silently, so a capture taken from it is alphabetized by label and will
  appear to differ on every attribute while every value is identical. An order
  Avito does not have is not ours to invent, which is the same rule as F-072.

- **F-080 — a service has no scalar price, and its price list is grouped.**
  `item.price` is `null`, `formattedPrice` is `{string: "", value: 0, isHasValue:
  false}`, `buyerItem.priceString` is empty and the page prints nothing at all
  where a goods listing prints its number, so `get-item`'s `price: null` is the
  honest answer and not a decoding loss. The table is `item.priceList =
  { title, isRedesign, groups: [{ title, isCollapsed, values }] }`, and an entry
  is `{ title, price, subTitle, subPrice, serviceId, url, imv, withSsr }` —
  richer than the card's pair, with `subTitle` and `subPrice` null on every entry
  read. One group, titled «Прайс-лист», on all three items. On a goods listing
  the key is present and `null`. The rendered page prints the group entry for
  entry, so the API is the visible list. The command returns it flat, in Avito's
  order, with the group titles merged away — one group has ever been sent, and a
  column holds a table rather than a tree (D-055).

- **F-081 — the card's price list and the listing page's disagree.** Same three
  items, both carriers read as JSON and both compared against their own rendered
  page: on `8107239005` the page and the API carry an entry the card does not
  («Диагностика (при заказе ремонта)», Бесплатно) and price the shared
  «Диагностика» at 500 ₽ where the card says «Цена договорная»; on `7318797534`
  all 25 titles agree in order while 23 prices differ — card «от 490 ₽» against
  «Цена договорная». The page agrees with the item API every time, so the card's
  list is the search index's copy of the same table and it goes stale. A caller
  who needs the price a seller currently asks needs `get-item`, and the two
  lists must never be presented as one: `search` reports only that a table exists
  and `get-item` is the one command that reads it (D-056).

## Risks

- **The feed accepts wrong input silently.** An unknown `ratingUserKey` returns
  `200` with an empty `entries` — someone else's key is indistinguishable from an
  empty feed by status. An unknown `sortRating` is silently replaced with
  `date_desc`, and so is `goods_relevant_desc` without `fromItem`. That is why the
  key cannot become an argument and why the sort must be cross-checked against
  `selectedOption`; neither may be weakened.
- **On deep pages of the feed Avito sends neither `score` nor
  `searchParametersV2`**, even with `requiredFilters`. If such a page is also the
  last one, the only way to confirm the sort is an extra request to the start of
  the feed — a fourth request for the call.
- **`publishedText` can be neither sorted nor compared.** It is a string Avito
  rendered, without a year and without seconds, in Moscow time; its year cannot be
  inferred. The vocabulary of forms is half collected: `14 августа в 02:15` was
  joined by `вчера в 19:15` (a BMW X5 listing, 2026-08-16), so Avito prints
  relative days too — a form with no year and no number at all. `сегодня в 12:20`
  and last-year forms have still not been observed. A consumer who needs the date
  as a quantity needs the listing row with `published`, not this column.
  Incidentally: the date is the moment of publication, and re-listing moves it, so
  "created" does not follow from it.
- **There is no machine-readable date in reviews at all:** `rated` and `answered`
  are visible strings like `сегодня` or `1 мая 2025`. Sorting and filtering by
  time on the consumer's side is not possible.
- The primary `/items/ads{pathname}` is undocumented and internal-unstable, so it
  is validated strictly; both fallbacks must stay working.
- In the DOM fallback the price is read from a marked node and parsed fail-closed
  when two numbers are present: a layout with a struck-through old price inside
  the same container would otherwise produce a glued-together garbage number.
