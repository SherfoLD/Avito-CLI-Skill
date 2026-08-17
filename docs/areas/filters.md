# Filters — `get-filters`, `apply-filters`

Confirmed live: 2026-08-16

The shared row decoder, the row shape and the transport are in
[_platform.md](_platform.md).

## Contract

`get-filters <searchUrl>` answers two questions: what can be applied to this
route, and what is already applied. Six columns: `key`, `name`, `unit`,
`valueSyntax`, `currentValue`, `options`. Budget: 2 requests.

The governing rule: **a row exists ⇔ the filter is applicable**. The absence of a
key *is* "you cannot apply this"; there is no separate marker for it.
`valueSyntax` is never `null` and says what to write after `key=`: `<value>`,
`<value>[,<value>]`, `<text>[,<text>]`, `<from>..<to>` or `1`. `currentValue` is
either `null` or a string in exactly that syntax, which can be handed straight
back to `--set`.

For a range, the other half of the answer comes from `options`: empty means the
bound is a number (`numericRange`), non-empty means the bound is one of the
listed values (`slider`, whose two ends *are* the two dropdowns of the visible
control). The syntax is the same for both, so the caller never needs to know the
type (D-041).

`apply-filters <searchUrl> --set <selections>` accepts page 1 and up to 50
filters of 50 values per call. Grammar: `;` between filters, `,` between values
of one filter, `..` for a range with optional ends, `key=` with no value clears
it. Plus `--remove-reserved`. Budget: 3 requests regardless of how many filters.

Keys come in two kinds, and the caller sees no difference: `params[<attrId>]` —
a list, a text field, a range or a checkbox — and the short keys `price`, `user`,
`d`, `localPriority`, `sort`.

## How it works

The schema comes from `loaderData.data.filtersV2` in the SSR bootstrap of the
current route; DOM controls and `/web/1/js/items` are not used as a source.
`content` is walked recursively, and a nested filter is returned alongside a top
level one even when its parent was skipped as inapplicable.

For short keys, `get-filters` takes the values from `searchCore` rather than
`filtersV2`: their `currentValue` arrives stale or missing entirely. Both
carriers sit in the same bootstrap, so the substitution costs no extra request.

`apply-filters` sends every selected filter in **one** request to
`/web/1/js/items?...&spaFlow=true&useReload=true`, carrying a full snapshot of
the form state: the opaque context, the category, the location, the geo and every
`params` the call did not change. Postconditions are checked per key and by exact
equality:

- `params[...]` — against `searchCore.params[attrId]` **and** `filtersV2.currentValue`;
  the value of such a key comes in three forms — a list of values, a `{from, to}`
  object for a range, and the scalar `1` for a checkbox — and is carried across
  unchanged, in whatever form it arrived;
- short keys — against `searchCore` **only**, because their
  `filtersV2.currentValue` is stale;
- a cleared key must be absent or empty; partial application is drift, not success;
- every key the call did not change must come back unchanged, geo included.

There is deliberately no "apply, re-read the schema, apply the rest" loop: a key
that was not in the fresh schema is one the caller could not have seen, and a key
that appears after applying will reach them on the next `get-filters`.

## Decisions

- **D-008 — the schema source is the SSR bootstrap**, not the DOM and not
  `/web/1/js/items`. The DOM lost colour IDs, expanded values and a virtualised
  `sectionedMultiselect`; a natural call to the items API answered `429` and
  triggered a firewall CAPTCHA. The bootstrap is the same backend state the MFE
  builds the visible form from, and reading it requires no UI mutation.
- **D-010 — one object per filter with a map of options.**
  `options: {"<value>":"<name>"}`, not a row per option: the flat contract
  inflated a RAM schema of 26 filters and 491 values into 498 repeating rows. An
  array of `[{value,name}]` is rejected by the row-depth rule; a map stays inside
  the allowed depth.
- **D-030 — several values of one filter go as a `,`-separated list.** Not an
  optimisation but the closing of a hole: they cannot be accumulated by chaining
  at all (F-050). Allowed only where Avito accepts them by the fresh schema
  (`checkboxGroup`, `multiselect`, `sectionedMultiselect`); for other types a
  second value is an `ArgumentError` before the network. Repeating the `--set`
  option itself is also an error, not a quiet win for the last one.
- **D-032 — the `--set` syntax.** `;` between filters, `,` between values, `..`
  for a range, an empty value clears. The separators have to live inside a single
  value, because a repeated named option silently collapses to the last one.
  Neither `;` nor `,` occurs in any confirmed option ID (`^\d+$`) or key. A JSON
  object as the value was rejected: an agent gets quoting wrong more often than
  it gets `;` wrong, and the help text is the only thing it reads.
- **D-040 — a section is presentation, not a value; `slider` is a range.** The
  rule for an unknown type was confirmed by the owner: the command must fail,
  otherwise schema drift becomes invisible. So Transport was opened by two
  changes to shape handling rather than by weakening the rule. First: the `values`
  of a sectioned control arrives either as a flat list of options or as
  `{id, title, options}` wrappers naming a group of the visible control
  («Популярные», «Все»). A wrapper carries no applicable value, so its options are
  taken and the wrapper is thrown away; one option repeated in two groups is one
  option, two different names for one value is a stop, and mixing the two forms in
  one array is a stop as well. Second: `slider` was entered in the type map as a
  range — its ends are option IDs and it carries the same `inputs` block as
  `numericRange`. The type is known, so the command does not fail. The caveat "a
  range inside `params[...]` is neither returned nor applied" lasted one day and
  was replaced by D-041.
- **D-041 — a range applies through two Avito keys, a checkbox through a bare key
  with the value `1`.** Avito declares the range form itself in the `inputs`
  block, and a round trip confirmed all of it (F-063): `params[<attrId>][from]`
  and `[to]`, answered by `{from, to}` in both carriers. So `numericRange` and
  `slider` are one output row with `<from>..<to>`, told apart by `options`: the
  first has none, the second has the dictionary both bounds come from. The order
  of a slider's bounds is checked against the order of its own list, not against
  the ID numbers: the numbers belong to Avito. `bannerCheckBoxWithImage` is not
  an unknown type but a checkbox with a picture: no `values`, no `inputs`, all
  content is presentation, and its state travels as `1` (F-062). It is entered in
  the map as `boolean` and applies through a bare key with no index. D-040 is
  untouched by this: a type absent from the map still stops the command.
- **D-042 — a text field is an output row with its own syntax; a group heading is
  not a filter.** `keywords` applies through the same indexed list a multiselect
  uses, so it gets its own syntax entry `<text>[,<text>]` and an empty `options`:
  the field has no vocabulary and pretending otherwise is not allowed (F-064).
  The postcondition is exact equality, because Avito returns what was typed
  character for character. The price of the grammar was accepted deliberately: a
  word containing `,` or `;` cannot be expressed through `--set`, and a word
  shaped like `2015..2018` is rejected by type before the network rather than
  going out under the wrong key. A `checkboxGroup` with empty `values` does not
  become a row — it is a group heading whose values sit in `content` as separate
  filters and are already returned (F-065).
- **D-043 — an entry point is not a filter, and Avito's vocabulary is not
  trimmed.** Two amendments to the same "a row exists ⇔ the filter is applicable"
  rule, both found in parts. First: `garageEntrypoint` is entered in the type map
  with its own `entrypoint` normalisation, which never has a syntax — not now, and
  not if Avito one day sends it `values`. It is the mirror of D-041: a checkbox
  with a picture has a value and therefore became a row, while the car picker has
  no value of its own and therefore does not — it only fills in three ordinary
  filters, which it names itself (F-066). The type is genuinely decoded rather
  than skipped: D-040 is untouched. Second: the vocabulary ceiling was raised from
  2000 to 20000 options per filter (40000 per route). The ceiling is a guard
  against implausible data, not a size policy: Avito honestly lists 12150
  manufacturers on truck parts, and trimming that list would reintroduce the very
  silent clamp this command exists to avoid (F-067).
- **D-037 — `get-filters` returns only what is applicable and only what the
  caller needs.** Twelve columns became six. Not one of the removed columns
  enabled an action: `attrId` was the same number already inside `key`;
  `section` / `parentKey` described the shape of Avito's SSR tree; `type`
  duplicated `valueSyntax`; `optionsComplete` was the constant `true`;
  `currentValueSource` described our own choice of carrier. The four forms of
  `currentValue` (array, scalar, `{from,to}`, number) stayed inside the command
  and one form comes out. A resting value (`owner=0`, `withDeliveryOnly=0`,
  `localPriority=0`, an empty range) is no longer passed off as a choice.

## Facts

- **F-021 — the SSR document contains the full schema.** Exactly one
  `script[type="mime/invalid"][data-mfe-state="true"]`, with `filtersV2` and every
  section inside. Sofas: 36 recursive filters and 103 values, including 19 colours
  with IDs and 7 nested filters the visible form never showed. RAM: 26 filters and
  491 values, where two `sectionedMultiselect` carry 361 and 65 complete records
  while their DOM controls are collapsed. There is no separate schema XHR among
  the initial responses.
- **F-024 — options have to be grouped.** The full RAM schema flattened is 498
  rows instead of 26 objects. `key` and `attrId` stay separate fields inside the
  command: `price` proves they are not interchangeable.
- **F-029 — short-key serialisation and the anatomy of `params`.** The confirmed
  table: `price → pmin/pmax`, `user`, `d`, `localPriority`, `sort → s`; ordinary
  values are `params[id][index]`. The `attrId` of a short key is **not stable**
  across categories, so the runtime must dispatch by `key` and never by `attrId`.
  Eight common `params[...]` are stable across categories while the state key is
  not (`110405` on sofas, `110396` on RAM), which is why availability always comes
  from a fresh `filtersV2`.
- **F-032 — `filtersV2.currentValue` is unreliable for short keys.** On a correct
  `200` it is sometimes stale or missing entirely (`user` disappeared,
  `sort.currentValue` stayed at the previous value) while `searchCore` and the
  server URL both confirm the application. Hence the split of roles: the fresh
  schema is the vocabulary and the types, `searchCore` is the postcondition.
- **F-050 — chaining calls does not accumulate values of one filter, it
  overwrites them.** `params[112691]=757883` (128 GB), then the same key with
  `757884` (256 GB) — exit 0, no error, and 128 GB is gone. That is, "128 or 256"
  was unreachable by any means. Avito does accept several values in one request:
  `params[112691][0]&[1]` returned `200` and both values were confirmed in both
  carriers; the listing is their union. The `[1]` index is confirmed on the live
  command.
- **F-052 — what a live run of all ten commands showed.** Three filters per call,
  including a range and a mix of `params[...]` with short keys — one request, each
  selection confirmed separately. An applied `price` is put by Avito into the
  opaque `f=` even though it accepts `pmin` / `pmax` on the way in: the
  postcondition survived only because it reads `searchCore` — a check over URL
  shape would have been wrong here. Clearing `sort=` works normally. Geo
  (`metro=104`) survives filter application.
- **F-054 — single-value `params[...]` are normal, not rare.** They were not being
  found because the search was confined to two goods categories. They exist on
  nine of 25 routes, in both API-type forms (`radioGroup` and `select`). The rule
  for finding such a category: a single-value filter appears where the attribute
  physically excludes a second value — gender, number of children, number of
  strokes, publication date. Rejection of a second value is confirmed live before
  the network; Avito accepts two single-value `params[...]` in one call. But those
  keys did not reach the canonical URL at all — the choice went into the opaque
  `f=`, which is the second proof that application cannot be checked by URL shape.
- **F-058 — half the sofa schema was applied by nothing.** 11 rows of 36 came out
  with `valueSyntax: null`: five `numericRange` inside `params[...]`, `keywords`,
  three `hidden`, a filter with an empty vocabulary, and `footWalkingMetro`.
  Three of them are hidden constraints of the route itself, belonging to the
  category rather than to a filter. A round trip of the new form is confirmed:
  `apply-filters` with three keys, then `get-filters` — exactly three keys with a
  non-empty `currentValue`, literally what was passed.
- **F-060 — Transport was killed by the shape of the options, not by an unknown
  type.** Both branches the owner checked (cars `bmw x5 2015`, motor oil) stopped
  at `contains a malformed option` in the very first sectioned filter — parsing
  never once reached the `slider`. Cars have three sectioned filters: «Марка»
  carries two groups and 438 records, of which 20 are repeats («Популярные» ⊂
  «Все») with the same names → 418 options; «Страна бренда» and «Коробка передач»
  have one group each. Oil has six, the largest being «Производитель» 686,
  «Допуски OEM» 552, «Объём» 443. The group `id` is empty on all nine, but there
  is no longer any reason to read it. There is one `slider` there —
  `params[162396]` «Объём двигателя», 39 values with IDs and
  `inputs.from.id = params[162396][from]`. After the fix the routes return 46 and
  22 rows, and the same fix opened tyres (`contains a malformed option`, phase 16)
  and cross-enduro — the regression route with the slider. The live round trip:
  `apply-filters --set 'params[110000]=329202;params[110008]=331255;price=1000000..2500000'`
  (BMW being exactly the repeated option) produced the canonical
  `/avtomobili/bmw/avtomat-…`, and `get-filters` on it returned exactly those three
  keys; on oil, two sectioned keys (Shell, 5W-40) confirmed the same way.
- **F-062 — Services was killed by one filter, and it is one filter for the whole
  category.** `params[191434]` «Надёжный исполнитель» of type
  `bannerCheckBoxWithImage` is present on all 12 routes checked (the root, movers,
  machinery rental, car services, plumbing, roofing, cleaning, health, appliance
  repair, computer help, rubbish removal, tutoring, beauty) and always with empty
  `values`. There are no other unknown types in the category. The live round trip
  on movers: `params[191434]=1` → `searchCore.params[191434] = 1`,
  `filtersV2.currentValue = 1`, listing 1166 → 165. Right next to it sits the
  opposite case: `params[156269380000]` («Статус исполнителя», a `checkboxGroup`
  also without a vocabulary) with the same `=1` is **accepted and not applied** —
  the key appears in `searchCore.params`, the counter does not move,
  `filtersV2.currentValue` is empty. So `searchCore` on its own proves nothing
  about `params[...]`, and the two-carrier check is the only thing separating
  applied from echoed.
- **F-063 — both range forms inside `params[...]` are confirmed by round trip.**
  The keys are the ones Avito names in `inputs`. `numericRange` (car model year):
  `params[164669][from]=2015&[to]=2018` → `searchCore.params[164669] =
  {from:2015,to:2018}`, schema `{from:"2015",to:"2018"}`, 80329 → 9997. `slider`
  (engine displacement): the same two keys, the value being an option ID from its
  own `values`, `3261720..3261730` (2.0–3.0 l) → 39437. A one-sided bound works,
  and the unset end arrives as `0` in `searchCore` and as `null` or `""` in the
  schema — so a bound of zero is indistinguishable from an unset one and does not
  need to be distinguishable. The full live cycle: three ranges in one call on
  cars, `get-filters` returned exactly those, and the next call with `price`
  preserved them.
- **F-064 — words in the description are an ordinary list of values, typed by
  hand.** The carrier is visible in the URL the owner sent:
  `searchCore.params[149569] = ["6000","6200"]` — both words in one filter. The
  serialisation is the multiselect's: `params[149569][0]=kingston&[1]=новая` →
  2874 → 284 listings, confirmed in both carriers; the hiding twin
  `params[164865][0]=kingston` → 2874 → 2274. Case, spaces and Cyrillic come back
  character for character (`Kingston HyperX`), so exact comparison in the
  postcondition is safe. The live cycle through the commands:
  `--set 'params[149569]=Kingston HyperX;params[164865]=б/у'` → 13 rows, and
  `get-filters` returned exactly those two rows. Incidentally: the `defaultTitle`
  of the second field contains a literal `\n` sequence — that is Avito's own
  vocabulary and it passes through unchanged.
- **F-065 — a `checkboxGroup` with an empty vocabulary is a group heading, not a
  filter.** On sofas, «Условия продажи» carries two filters in its `content`
  («Можно оптом» `params[198219]`, «Оптовая скидка» `params[198220]`); on movers,
  «Статус исполнителя» carries the banner checkbox `params[191434]` and a rating.
  In the visible form the heading has no control of its own — only a caption above
  its children — and its ID is synthetic and unstable: one route in one session
  returned `params[156269380000]` and `params[156272960000]`. That also explains
  the "accepted and not applied" of F-062: there is nothing there to apply. The
  children were always returned, so the class was closed without a code change.
- **F-066 — the car picker filters nothing; it fills in three ordinary filters.**
  `params[1216774800]` of type `garageEntrypoint` lives on one branch of the
  category — «Запчасти → Для автомобилей»; it is absent on the other ten routes of
  "Parts and accessories" that were checked. No `values`, no `inputs`; all content
  is `displaying`, and inside it Avito names what the picker controls:
  `carInfmParams = {brand: 110000, model: 110001, generation: 110005}`. The round
  trip is negative and unambiguous: `params[1216774800]=1` appears neither in
  `searchCore.params` nor in `currentValue`, and Avito drops the key from the
  canonical URL — so this is not even the "accepted and not applied" case of
  F-062, there is nothing to accept. All three filters it names were confirmed
  reachable the ordinary way and appear in a chain: `params[110000]=329202` (BMW)
  → «Модель авто» appears in the schema with 65 options, `params[110001]=331035`
  (X5) → «Поколение авто» appears with 10. The picker's `attrId` did not change
  across two consecutive reads, unlike the synthetic group headings (F-065), but
  that adds no applicability. The live cycle after the fix:
  `--set 'params[110000]=329202;params[817]=11618;params[114860]=1210859;price=10000..100000'`
  → the canonical `/zapchasti/dlya_avtomobiley/bmw/avtosvet`, and `get-filters`
  returned exactly those four keys. The same key passed to `apply-filters` by hand
  answers `ArgumentError` "has a type this command cannot serialize safely" — the
  refusal is typed, not silent.
- **F-067 — a vocabulary of 12150 values is Avito being normal, not broken data.**
  «Запчасти → Для грузовиков и спецтехники» returns 12150 options in
  `params[110548]` «Производитель»: all unique, not one duplicate value, not one
  name conflict, not one sectioned wrapper, the longest name 77 characters. The
  route carries 12202 values across 26 filters in total, meaning one control
  carries the entire volume. The former ceiling of 2000 stopped the command with
  "has malformed or implausible values" — that is, it refused a live page instead
  of a broken one. The neighbouring branch of the same tree gives no measure: on
  «Для автомобилей» the same key returns exactly 1000 options — the limit is drawn
  by Avito and it differs. The live round trip after raising the ceiling:
  `--set 'params[110548]=448904;params[121596]=2906246;price=..50000'` (KAMAZ,
  trucks) → 50 rows, `get-filters` on the resulting URL returned exactly those
  three keys, and the `options` column of that same filter stayed complete.
- **F-072 — the order of `get-filters` rows belongs to Avito and is not stable.**
  Two runs of the same command on the same URL return the same 31 rows and the
  same 6 columns, every value identical when matched by `key`, in a different
  order. Not a decoder difference. `filtersV2.Sections` arrives in a varying
  order between requests for the same URL: three runs of the same command on
  «Диваны» gave `main, locationGroup, checkboxes, displayOptions`, then
  `displayOptions` first, then `checkboxes, displayOptions` last. The sections
  and their contents are the same each time; only their sequence moves. So a row
  position means nothing here and two outputs must be compared by `key`, the way
  a listing page is compared by `itemId` (F-042). Sorting the rows to hide it was
  rejected for the same reason the alphabetized `attributes` was (F-070): an
  order Avito does not have is not ours to invent.
- **F-051 — two defects found by reading the code during the rebuild.** The old
  filter command did not carry `metro` / `district` / `radius` into the request and
  did not check them as preserved, so a filter on a URL with a metro station could
  silently return results for the whole city — and geo is exposed by no column, so
  there was nothing to notice it with. The old schema command loaded the whole
  catalog page for the sake of one JSON blob in the markup. Both are closed by
  construction. The common cause: the contract fixed a command's input and output
  but not what the command must carry across unchanged.

## Risks

- **What is still not applicable, and why.** Two kinds of key remain, and the
  question differs for each. `hidden` is a hidden constraint of the route rather
  than a filter: nobody asked to apply it, and the only question is whether it is
  ever a control. `footWalkingMetro` and `categoryId` are keys not of the
  `params[...]` form, whose carrier in `searchCore` is unconfirmed. The enum with
  an empty vocabulary left this list: it turned out to be a group heading whose
  values are returned as separate rows (F-065), and `keywords` applies as of
  2026-08-16 (F-064).
- **`footWalkingMetro` does not apply:** its carrier in `searchCore` is
  unconfirmed. Since 2026-08-16 it is not returned by `get-filters` either, so
  "walking distance from the metro" does not exist for the consumer even though
  the filter exists on Avito's page.
- **An unknown API type remains a stop** (D-040). It does not describe a filter —
  it reports that the type map has fallen behind Avito, and skipping it quietly
  would make the drift invisible. After `slider`, `bannerCheckBoxWithImage` and
  `garageEntrypoint` were decoded, the price of that honesty is zero known
  categories: no unknown types remain on the walked routes, and the next one will
  mean exactly what it says.
- **One row can carry a vocabulary of thousands of options** (F-067). The ceiling
  now catches only the implausible, so the caller must be ready for an `options`
  column of 12150 entries; trimming it on our side is not allowed — that would be
  a silent clamp. If such a response turns out to be inconvenient, the cure is a
  separate way to ask for the vocabulary, not quiet truncation.
- **A word containing `,` or `;` cannot be expressed through `--set`**, and a word
  written as `2015..2018` will be read by the grammar as a range and rejected by
  filter type (D-042). That is the price of one separator across the whole
  surface, not a defect of one command.
- **A range is checked against two carriers, and that is not belt and braces.**
  Avito puts a key it did not apply into `searchCore.params` too (F-062), so the
  confirmation is `filtersV2.currentValue`. The other side of that: if Avito ever
  stops sending `currentValue` for `params[...]` the way it already does for short
  keys (F-032), range application will start failing as drift.
- SSR completeness can degrade transiently: one and the same route once returned
  a payload with no valid `searchCore`, and an immediate independent read passed.
  The guard must not be weakened, and it must not be patched around one transient
  response either.
- For `sort`, "no ordering" is not the absence of the parameter but Avito's own
  option («По умолчанию»). So `sort=` may fail the clearing postcondition; the
  supported way to return to default ordering is to apply that option explicitly
  by its value from `get-filters`.
- Changing category invalidates the `params[...]` of the previous category: after
  `move-category` the schema must be re-read.
