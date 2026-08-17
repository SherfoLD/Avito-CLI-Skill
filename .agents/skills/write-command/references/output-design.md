# Designing the output

A row is the API. It is read by an agent that will see the column names and the
`description` and nothing else, so the names carry the whole contract.

## The contract is a schema

The row is declared as a `z.strictObject` in the descriptor's `row` field, and
`columns` is derived from it. There is no second place to keep in step: the
column list, the types, the formats and the nullability are one declaration, and
the CLI parses every row through it before printing.

```js
row: z.strictObject({
  itemId: idString(),                       // ^\d+$
  title: text(),                            // non-empty after trimming
  price: z.number().nonnegative().nullable(),
  images: z.array(httpsUrl()),
  options: z.record(text(), text()),
}),
```

`strictObject` is the point: a key the schema does not declare is a failure, not
a value that shows up in `-f json` and vanishes in `-f table`.

The shared vocabulary — `text`, `idString`, `httpsUrl`, `itemUrl`, `searchUrl`,
`rank`, `count` — lives in `src/runtime/schema.mjs`. Use it before writing a new
regex: the same claim written twice drifts once.

## The ceiling and the shape

16 top-level keys (D-054). A column is a scalar, an array or record of scalars,
or an array of flat records — a table inside a row, and the only nesting there is
(D-055). A record one level down is declared the way the row is, `strictObject`
of scalars; a list of lists and a record of records are refused, because the
shape they describe is a tree. All of it is checked against the schema when the
module is imported, so a seventeenth column or a tree fails before anything runs.

Headroom is not permission. A column costs meaning — what it says when the value
is missing, which is a question every nullable column has to answer out loud —
and it costs payload on every row of every page. When `sellerId` was removed, the
case was that no command grouped by it, built a URL from it, or checked a
postcondition with it (D-038); that is the shape of the argument a new column
needs too, in reverse.

A map is still the right form for a vocabulary: filter options are
`{"<value>": "<name>"}` rather than `[{value, name}]` because the flat
alternative turned a 26-filter schema into 498 repeating rows (D-010). The table
form is for what is genuinely a table of its own — `get-item.priceList` is
`{ title, price }[]` because two services can share a title and the order is
Avito's, neither of which a map can hold (D-056).

## Naming

- camelCase. Checked against the schema by `defineCommand`.
- Align with the neighbouring commands before inventing anything. If four
  commands already return `sellerReviewsCount`, the fifth does not get
  `reviewCount`.
- **One name means one thing.** `images` and `imagesPreviews` are separate
  columns because a catalog preview (`636x636`) and a gallery original
  (`1280x960`) are different things, and one name over both let a consumer
  believe they had the original (D-029). The same reasoning produced `published`
  and `publishedText`: an exact instant and a rendered string are two quantities,
  not two formats of one.
- A name should survive being read alone. `price` is the number the card prints
  large; if you also carried the base price it would not be `price2`, it would be
  `basePrice` — and it would cost a slot.

## Order

Identity → the business numbers → metadata.

```
itemId, title, price, minPrice, hasPriceList, location, descriptionPreview,
published, sellerName, sellerRating, sellerReviewsCount, imagesPreviews,
url, searchUrl
```

For the four listing commands this exact list and this exact order are fixed —
they share one `LISTING_ROW` schema in `src/site/listing.mjs`, along with the
mapping from the decoder's `api*` rows and the reservation filter. Changing that
schema changes four commands at once.

The order in the schema is the order in the output: rows are parsed through it
before printing, so the JSON key order follows the declaration rather than
whatever order the command happened to build the literal in.

## Types

- Declare nullable columns as nullable, and mean it. `sellerName` is
  `text().nullable()` because Avito withholds private-seller identity from an
  anonymous session — the `null` is information, not a gap.
- **Nullable is not optional.** The key is always present; only its value may be
  `null`. A column that is sometimes absent disappears from `-f json` entirely,
  and the schema refuses it.
- A number stays a number. Do not format it into a string for display; the
  consumer formats.
- A unit that is not obvious belongs in the field map with the unit named:
  "premium as a 0–1 fraction, NOT already multiplied by 100" is a useful entry,
  "premium" is not.
- An array column is always an array, never `null`. Empty means empty.
- State the format where you can. `itemUrl()` says the listing URL carries no
  query, in one line, for every command that returns one.

## What does not become a column

- **Anything constant.** `optionsComplete` was the constant `true` from birth and
  was deleted. A column that always says the same thing costs a slot and teaches
  the caller nothing.
- **Anything that describes our implementation.** `currentValueSource` named
  which carrier we chose to read; that is our business, not the caller's.
- **Anything that restates another column.** `attrId` was the same number already
  inside `key`; `type` duplicated `valueSyntax`.
- **Anything the caller cannot act on.** The test that removed six columns from
  `get-filters` was exactly this: for each one, name the action it enables. If
  there is none, it goes (D-037).

## Row-shaped rules worth stealing

- **A resting value is not a choice.** `owner=0`, `localPriority=0` and an empty
  range read as `null` rather than being reported as an applied filter. Handing
  back a default dressed as a selection makes the caller act on nothing.
- **Absence is a signal, if you say so.** In `get-filters` the rule is "a row
  exists ⇔ the filter is applicable". There is no separate applicability flag,
  and there does not need to be — but that only works because it is stated in the
  command description, where the caller reads it.
- **One syntax field beats a type field.** `valueSyntax` tells the caller what to
  write after `key=`. It is derived from what the applying command accepts, not
  from the source type, which is why a caller never needs to know that a
  `numericRange` and a `slider` are different things.

## Where the contract lives

In the descriptor, printed by `--help`. Not in markdown.

Documentation says only what the descriptor cannot: why a flag is mutually
exclusive with another, what happens when it is omitted, which column is
deliberately partial. A markdown copy of the flag list is a copy that rots, and
`npm run check:docs` deliberately checks only that a command has a domain file —
never that the file lists its flags.
