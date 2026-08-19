# Designing the output

The answer is the API. It is read by an agent that will see the field names and
the `description` and nothing else, so the names carry the whole contract.

## One object, always

A command answers with **one JSON object**, declared as `output` in the
descriptor. Not an array, not a scalar — one object, even when the command
returns exactly one thing (`get-item`, `get-coords`) and even when it returns
fifty (`search`).

```js
output: z.strictObject({
  query: text().nullable(),
  locationId: idString(),
  locationName: text(),
  searchUrl: searchUrl(),
  items: z.array(LISTING_ITEM),
}),
```

`strictObject` is the point, at every level: a key the schema does not declare is
a failure, not a value that reaches a caller nobody told about it. The CLI parses
the whole answer through this before printing.

The shared vocabulary — `text`, `idString`, `httpsUrl`, `itemUrl`, `searchUrl`,
`count` — lives in `src/runtime/schema.mjs`. Use it before writing a new regex:
the same claim written twice drifts once.

## The envelope rule

A command that returns several of something answers with an **envelope plus a
list**. Deciding what goes where is mechanical:

> **Identical across every element → the envelope. Different between them → the
> element.**

`searchUrl` is one URL for the whole search, so it sits on the envelope of the
four listing commands. `depth` in `get-categories` is different per node, so it
sits on the node. `sellerReviewsCount` is one number for the seller, so it sits
on the envelope of `get-seller-reviews` rather than on all twenty-five reviews.

Passing this rule is not earning a place. `get-categories` also had a route per
node; it went, because `move-category` takes a name and resolves the route
itself, so nothing a caller could do with it existed (D-075).

Two things this rule is for, and the second is the bigger one:

- **Repetition is payload.** A 120-character `searchUrl` on fifty cards is around
  2000 tokens of the same string, paid on every page an agent reads.
- **The envelope is where a fact about the request finally has a home.** `search`
  computed the effective `locationName`, compared it against what was asked for,
  and had nowhere to put it — so a caller who passed no `--location-id` got fifty
  listings and no way to ask which region answered. Every fact the command
  *proved* is a candidate: the URL it landed on, the region it applied, the page
  it confirmed, the sort Avito agreed to.

Position in an array is position. Do not add a `rank` field beside it.

## The ceilings

40 declared fields and 3 objects deep (D-074), counted once per declaration
wherever it sits and checked when the module is imported.

Depth counts object nesting, and a list does not add a level: every command today
is 2 — an envelope and the things in it, `get-item.priceList` included. The
ceiling is 3, so there is exactly one level of headroom and nothing uses it. If
your design wants it, say why in the commit.

Headroom is not permission. A field costs meaning — what it says when the value
is missing, which every nullable field has to answer out loud — and it costs
payload wherever it repeats. When `sellerId` was removed, the case was that no
command grouped by it, built a URL from it, or checked a postcondition with it
(D-038); that is the shape of the argument a new field needs too, in reverse.

A map is the right form for a vocabulary: filter options are
`{"<value>": "<name>"}` rather than `[{value, name}]` because the flat
alternative inflated a 26-filter schema into 498 repeating entries (D-010), and
because the map states the lookup a caller actually does. The list-of-objects
form is for what is genuinely a table — `get-item.priceList` is
`{ title, price }[]` because two services can share a title and the order is
Avito's, neither of which a map can hold (D-056).

## Naming

- camelCase, checked against the schema at every depth by `defineCommand`.
- Align with the neighbouring commands before inventing anything. If four
  commands already return `sellerReviewsCount`, the fifth does not get
  `reviewCount`.
- **One name means one thing.** `images` and `imagesPreviews` were separate
  fields because a catalog preview (`636x636`) and a gallery original
  (`1280x960`) are different things, and one name over both let a consumer
  believe they had the original (D-029). The same reasoning produced `published`
  and `publishedText`: an exact instant and a rendered string are two quantities,
  not two formats of one.
- A name should survive being read alone. `price` is the number the card prints
  large; if you also carried the base price it would not be `price2`, it would be
  `basePrice`.
- The envelope and the element must not share a name for different things. When
  `get-categories` moved to an envelope, the per-node route had to be renamed
  from `searchUrl`, which on the envelope now means "the search this sidebar
  belongs to". It was called `targetUrl` for a while and then deleted (D-075) —
  the rename is still the rule, the field is just no longer the example.

## Order

Identity → what was asked → what came back → the list.

```
query, locationId, locationName, searchUrl, items
```

Inside an element: identity → the business numbers → metadata.

```
itemId, title, price, minPrice, hasPriceList, location, descriptionPreview,
published, sellerName, sellerRating, sellerReviewsCount, imageCount, url
```

For the four listing commands that element is fixed — one `LISTING_ITEM` in
`src/site/listing.mjs`, along with the reservation filter, and one decoder in
`src/site/card.mjs`. Changing either changes four commands at once.

The order in the schema is the order in the output: the answer is parsed through
it before printing, so the JSON key order follows the declaration rather than
whatever order the command happened to build the literal in.

## Types

- Declare nullable fields as nullable, and mean it. `sellerName` is
  `text().nullable()` because Avito withholds private-seller identity from an
  anonymous session — the `null` is information, not a gap.
- **Nullable is not optional.** The key is always present; only its value may be
  `null`. A field that is sometimes absent disappears from the JSON entirely, and
  the schema refuses it.
- A number stays a number. Do not format it for display; the consumer formats.
- An array is always an array, never `null` — unless the two empties are
  different answers, which is the one case that earns a nullable list.
  `get-item.images` is `null` for "you did not ask for the files" and `[]` for
  "this listing has no photos".
- A unit that is not obvious belongs in the field map with the unit named.

## What does not become a field

- **Anything constant.** `optionsComplete` was the constant `true` from birth and
  was deleted.
- **Anything that describes our implementation.** `currentValueSource` named
  which carrier we chose to read; that is our business, not the caller's.
- **Anything that restates another field.** `attrId` was the same number already
  inside `key`; `type` duplicated `valueSyntax`; `rank` restated the array index.
- **Anything the caller cannot act on.** The test that removed six fields from
  `get-filters` was exactly this: for each one, name the action it enables. If
  there is none, it goes (D-037).

## Rules worth stealing

- **A resting value is not a choice.** `owner=0`, `localPriority=0` and an empty
  range read as `null` rather than being reported as an applied filter. Handing
  back a default dressed as a selection makes the caller act on nothing.
- **Absence is a signal, if you say so.** In `get-filters` the rule is "a filter
  is returned ⇔ it is applicable". There is no separate applicability flag, and
  there does not need to be — but that only works because it is stated in the
  command description, where the caller reads it.
- **One syntax field beats a type field.** `valueSyntax` tells the caller what to
  write after `key=`. It is derived from what the applying command accepts, not
  from the source type, which is why a caller never needs to know that a
  `numericRange` and a `slider` are different things.

## The type beside the schema

`type` in the descriptor is the same contract as TypeScript, written by hand, and
it is what `--help` prints. Write it as you write the schema — not afterwards:

```
type Output = {
  query: string | null;   // what Avito searched for; null where the text dissolved into a category
  locationId: string;     // digits only, the region Avito actually searched
  searchUrl: string;      // the canonical URL every other command takes
  items: Item[];
};

type Item = { … };
```

The comments are the whole reason it is hand-written: a renderer can produce
`price: number | null` but not *why* it is null, which unit the number is in, or
which command reads the thing this field only counts. That is what a consuming
agent is missing, and there is nowhere else to put it.

`npm run check:commands` refuses a name that is in the schema and not in the
type, or the reverse. It cannot check that a comment is true — that part is
yours.

## Where the contract lives

In the descriptor, printed by `--help`. Not in markdown.

Documentation says only what the descriptor cannot: why a flag is mutually
exclusive with another, what happens when it is omitted, which field is
deliberately partial. A markdown copy of the flag list is a copy that rots, and
`npm run check:docs` deliberately checks only that a command has a domain file.
