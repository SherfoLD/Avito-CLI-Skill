# Categories — `get-categories`, `move-category`

Confirmed live: 2026-08-15

The shared row decoder, the row shape and the transport are in
[_platform.md](_platform.md).

## Contract

`get-categories <searchUrl>` shows where you can go from the current route.
Columns: `rank`, `role`, `name`, `depth`, `current`, `hasChildren`, `navigable`,
`preservesQuery`, `searchUrl`. It performs no transition and does not change its
input. The value of the `name` column is what `move-category --to` accepts.

`move-category <searchUrl> --to <name>` moves the listing into another category
by its visible name and returns that category's rows. Accepts page 1. Plus
`--remove-reserved`. Budget: 3 requests.

The move changes both the listing and the set of available filters, so the
previous category's `params[...]` are invalid afterwards and `get-filters` must
be re-read.

## How it works

The only source is `loaderData.data.rubricators.side.nodes` of the same SSR
document the other commands read. `type=1` becomes `role=option` or `back` and
has a navigation URL; `type=0` is `role=expanded`, `type=2` is `role=current`,
neither is navigable, and the URLs hidden for them in the bootstrap are not
handed out.

`current=true` is the category Avito determined for the query by itself.

`move-category` resolves `--to` by exact match of the visible name: no match and
several same-named candidates both yield an `ArgumentError` listing the visible
names. Silently picking the first row is forbidden. The target URL is never
constructed — only taken from Avito's own state. After the move, the target's SSR
document is read and cross-checked fail-closed: the route must be the one Avito
named, the page must be the first, the location must be unchanged.

Query preservation is checked twice: by the URL before the move and by
`searchCore.query` of the response after it. The URL promises, the state proves.

Widening while a query is live is `Все категории` (`role=back`): the same query
across all categories, from where the tree unfolds again and you can descend
without losing the query.

## Decisions

- **D-015 — categories are navigation of the current search context**, not a
  global directory. The former `categories --parent <nodeId>` called
  `/web/3/category/tree` and made the agent redo the site's work without handing
  it a usable URL. Avito already picks a category for most searches, and
  navigation is contextual to the canonical URL, the location, the query and the
  server's opaque state.
- **D-033 — a route that loses the text query is not taken.** The rule is stated
  through an invariant rather than through a carrier: reject any candidate where
  the original search has a non-empty `q` and the target URL does not carry it.
  Plus a postcondition on `searchCore.query` of the response.
- **D-034 — breadcrumbs are not read at all.** The shape checks on
  `seoNavigation.breadcrumbs.links` were removed along with the reading: failing
  on the shape of data you do not read is a spare failure mode. The `source`
  column was deleted once it became constant, and `role` lost its `root` and
  `ancestor` values. D-033 remains the guard: tree rows always carry the query, so
  the rule does not fire in normal operation, but drift at Avito will become a
  visible refusal instead of a quietly widened listing.
- **D-046 — the two sidebar readers share what a node *means*, not how it is
  walked.** Both commands read `rubricators.side.nodes`, and the temptation is
  to lift the whole traversal into `src/browser/`. What is
  actually common is one thing: `type` 0 is an expanded branch, 1 an option that
  carries a route, 2 the current category. That is Avito's vocabulary, it must
  not exist in two copies with two opinions, and it now lives in
  `src/browser/prelude/rubricator.mjs` — where an unknown type returns `null` so each
  caller refuses it in its own terms. The walk stayed in both files: they
  validate different things (`get-categories` checks node IDs, the three state
  booleans and their agreement with the type, and names the ID in every message;
  `move-category` needs a usable name and a navigable URL) and a shared
  traversal would have to be parameterised until it was a `for` loop with extra
  steps, paid for in diagnostics. The rule this follows is the one in
  `src/browser/README.md`: shared code earns its place by being shared.

## Facts

- **F-034 — navigation belongs to the current search URL.** The SSR bootstrap of
  a search route hands over `rubricators.side.nodes` next to `searchCore` and the
  canonical URL; no global endpoint and no UI mutation are needed at runtime. The
  semantics of the types were checked against the visible page: `type=0` is drawn
  as an arrow with no link, `type=1` as an anchor, `type=2` as the current
  category.
- **F-053 — Avito changes the tree's shape by route mode, and going up exists in
  both.** On a search page the ancestors arrive as `type=0` with no URL, and one
  `back` row «Все категории» with `?cd=1&q=…` leads upwards. On a route **without**
  a query, that same section returns the whole ancestor chain as navigable `back`
  rows. That removed the only objection to deleting the breadcrumbs.
- **F-052 — two `move-category` defects found live.** It accepted the current
  category through its breadcrumb — a breadcrumb has a URL that the tree row does
  not — and returned the same category **without the query** disguised as a
  successful move. And it treated the text query itself as a category: the last
  breadcrumb of a search is `ddr5 32gb`, and it made it into the candidates even
  though `get-categories` discarded it by an explicit rule. Two decoders of the
  same node disagreed.
- **Breadcrumbs do not carry a search across at all.** Measured on a live route:
  5 breadcrumbs of 5 lose `q`, 5 navigable tree rows of 5 carry `?cd=1&q=…`.
  Moving into `Комплектующие` by breadcrumb returned cases and power supplies.
- **Breadcrumbs and the tree disagree about the hierarchy itself.** On a
  dissolved `iphone`, the breadcrumbs name `Apple` as the ancestor while the
  tree's current category is `Мобильные телефоны`. Breadcrumbs encode a marketing
  path; the tree encodes the rubricator the command actually walks.

## Risks

- Category navigation depends entirely on `rubricators.side.nodes`: there is no
  backup source any more. If Avito stops attaching `?cd=1&q=…` to tree rows, a
  move with a live query becomes impossible outright rather than "sometimes"; if
  the `back` rows on a query-less route disappear, going up from there vanishes.
  Both are visible refusals, not a quietly widened listing.
- The upper nodes of the tree are storefront hubs with no `catalog.items`:
  `/moskva/bytovaya_elektronika` and the city root `/moskva` return
  `EmptyResultError` in both `move-category` and `get-page`. That is Avito's
  shape, not the decoder's, but "this route is not a listing" cannot be told from
  "the query found nothing" by the error code.
