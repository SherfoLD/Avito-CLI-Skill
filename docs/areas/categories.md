# Categories — `get-categories`, `move-category`

Confirmed live: 2026-08-19

The shared listing decoder, the item shape and the transport are in
[_platform.md](_platform.md).

## Contract

`get-categories <searchUrl>` answers `{ query, locationId, searchUrl,
categories }` — the whole sidebar tree of the current route, in the order Avito
drew it: array position is the reading order, `depth` the indentation and
`parent` the visible name of the node above, so the tree is reconstructible
without this command inventing one. It performs no transition and does not change
its input. `name` is what `move-category --to` accepts, and `navigable` says
whether it will take it (D-075).

`move-category <searchUrl> --to <name>` moves the listing into another category
by its visible name and answers `{ query, category, locationId, locationName,
searchUrl, itemsCount, medianPrice, items }`, the last two describing the page it
came back with (D-077). `category` is the name as Avito renders it. Accepts page 1.
Plus `--remove-reserved`. Budget: 4 requests.

The move changes both the listing and the set of available filters, so the
previous category's `params[...]` are invalid afterwards and `get-filters` must
be re-read.

## How it works

The only source is `loaderData.data.rubricators.side.nodes` of the same SSR
document the other commands read. `type=1` becomes `role=option` or `back`,
`type=0` is `role=branch`, `type=2` is `role=current`; all three carry a route
of their own and all three are handed out (D-057).

`navigable` is not the type: an entry can be moved to when it has a route and that
route is not the one the search is already on. `current=true` is a node Avito
draws in bold — on a search it placed in a category that is the one node, and on
a search it placed nowhere it is every group head (F-084).

`move-category` resolves `--to` by exact match of the visible name: no match and
several same-named candidates both yield an `ArgumentError` listing the visible
names. Silently picking the first match is forbidden. The target URL is never
constructed — only taken from Avito's own state. After the move, the target's SSR
document is read and cross-checked fail-closed: the route must be the one Avito
named, the page must be the first, the location must be unchanged. That document
proves the move; the listings of the category it landed on come from the items
API, addressed by its own `searchCore` and `context` (D-063). So a move costs
three same-origin calls: the sidebar, the target, its listings.

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
  field was deleted once it became constant, and `role` lost its `root` and
  `ancestor` values. D-033 remains the guard: tree entries always carry the query, so
  the rule does not fire in normal operation, but drift at Avito will become a
  visible refusal instead of a quietly widened listing.
- **D-075 — `get-categories` hands over no routes.** Each entry used to carry
  `targetUrl`, the URL following it would land on. Nothing consumes it:
  `move-category` takes a **name** and resolves the route itself, from the same
  sidebar, so a caller passing a `targetUrl` anywhere is passing it to a command
  that ignores it. What it cost was a second URL vocabulary in the hands of
  agents — one route per node, up to forty of them, none of which any command
  accepts — beside the one `searchUrl` on the envelope that every command does.
  `navigable` survives it: that was the only question a caller asked the route,
  and it is now answered without handing the route over.

- **D-046 — the two sidebar readers share the node, its meaning and the walk
  around it.** Both commands read `rubricators.side.nodes`, and none of it exists
  twice: `SIDEBAR_NODE` in `src/schemas/rubricator.mjs` says what a node has to
  carry, and `src/site/rubricator.mjs` says that `type` 0 is a branch, 1 an
  option, 2 the current category, that a fourth kind stops the call, and that a
  node can be followed when it carries a route other than this one. `sidebarWalk`
  in the same file is the traversal (D-071), so what the two commands still hold
  separately is only what they do with a node: `get-categories` describes it,
  `move-category` follows it.
- **D-057 — an entry is navigable when it has a route, not when Avito draws it as a
  link.** The page renders only `type=1` as an anchor, and the old reading
  followed that: a branch was a control and its URL was withheld. But the URL is
  there on every node and it works — `/moskva/predlozheniya_uslug?cd=1&q=…`
  answers with `categoryId: 114`, the query and the city intact (F-083). So
  `navigable` now means "`move-category` can be pointed here": a route exists,
  Avito does not mark the node as the current category, and the route's pathname
  is not the one the search is already on. The comparison is by pathname because
  the sidebar's copy of the current route carries a `cd=1` the request did not —
  and it is the pathname *requested*, so `type=2` is still asked as well: a
  canonical route spelled differently would otherwise come back as a move to
  where the search already is (F-052). What this bought: the group head on a
  search Avito placed nowhere, and going *up* one level while keeping the query
  on a search it did.
- **D-058 — what a node's state means is Avito's to say.** `get-categories`
  refused a `type=0` node that was not `isOpened` and any sidebar with two
  `isCurrent` nodes, as contradictions. Both are shapes Avito draws (F-084), and
  the second one refused the command on the one route where it is the only way
  out. The invariants are gone; the state travels as `current` and `hasChildren`
  and the caller reads it. What still stops the call is a node neither command
  can describe at all: an unknown `type`, a repeated ID, a missing name, a URL
  off the site.

## Facts

- **F-034 — navigation belongs to the current search URL.** The SSR bootstrap of
  a search route hands over `rubricators.side.nodes` next to `searchCore` and the
  canonical URL; no global endpoint and no UI mutation are needed at runtime. The
  semantics of the types were checked against the visible page: `type=0` is drawn
  as a `/expandable` span with an expander arrow and no link, `type=1` as an
  `/clickable` anchor, `type=2` as a bold `/current` span.
- **F-083 — the route a node is not drawn as a link to still works.** Every
  sidebar node carries a URL, including the two kinds the page draws as spans.
  Replayed: `/moskva/predlozheniya_uslug?cd=1&q=замена аккумулятора macbook air
  m2` answers `categoryId: 114` with the query and `locationId` unchanged, and
  `move-category --to Услуги` passes every postcondition on it. On a route that
  has a category the ancestors are `type=0` too and carry the query the same way,
  so "go up one level and keep the search" exists and was simply not handed over.
- **F-084 — a search Avito places in no category is drawn as several current
  branches.** With `searchCore.categoryId: null` the sidebar has no `type=2` node
  at all: it has group heads, each `type=0` with `isCurrent: true`, one of them
  `isOpened: false` with its children `aria-hidden="true"`. `isOpened` is the
  expander state (`expandless` / `expandmore`), not a claim about the type, and
  `isCurrent` on a head is what the page bolds. Both were refusals until D-058.
- **F-096 — `searchCore.categoryId` is a coarser level than the sidebar
  navigates.** Replayed 2026-08-19 on `…/komplektuyuschie/operativnaya_pamyat-…?q=ddr5
  32gb`: `categoryId: 101` is carried by the current node, by its parent, by its
  grandparent and by all three of its siblings alike. What identifies the current
  category is the microcategory — `mcId: 3845` on the node, the same number on the
  document's own top-level `mcId` and on `analytics.microCategoryId` — and the
  name «Оперативная память» belongs to that, not to 101. `rootCategoryId: 6` and
  `verticalCategoryId: 4` are coarser again. So a `{categoryId, categoryName}`
  pair would be an ID naming one thing beside a name meaning another, and the
  whole vocabulary this CLI navigates by — what `get-categories` prints, what
  `move-category --to` takes, what `search` answers with (D-076) — is the name.

- **F-053 — Avito changes the tree's shape by route mode, and going up exists in
  both.** On a search page the ancestors arrive as `type=0` and one `back` entry
  «Все категории», all of them carrying `?cd=1&q=…`. On a route **without** a
  query, that same section returns the whole ancestor chain as `back` entries. That
  removed the only objection to deleting the breadcrumbs.
- **F-052 — two `move-category` defects found live.** It accepted the current
  category through its breadcrumb — a breadcrumb's URL drops the query where the
  tree entry's keeps it — and returned the same category **without the query**
  disguised as a successful move. That is why the node Avito marks as the current
  category is refused by that mark and not only by its route (D-057). And it treated the text query itself as a category: the last
  breadcrumb of a search is `ddr5 32gb`, and it made it into the candidates even
  though `get-categories` discarded it by an explicit rule. Two decoders of the
  same node disagreed.
- **Breadcrumbs do not carry a search across at all.** Measured on a live route:
  5 breadcrumbs of 5 lose `q`, 5 navigable tree entries of 5 carry `?cd=1&q=…`.
  Moving into `Комплектующие` by breadcrumb returned cases and power supplies.
- **Breadcrumbs and the tree disagree about the hierarchy itself.** On a
  dissolved `iphone`, the breadcrumbs name `Apple` as the ancestor while the
  tree's current category is `Мобильные телефоны`. Breadcrumbs encode a marketing
  path; the tree encodes the rubricator the command actually walks.

## Risks

- Category navigation depends entirely on `rubricators.side.nodes`: there is no
  backup source any more. If Avito stops attaching `?cd=1&q=…` to tree entries, a
  move with a live query becomes impossible outright rather than "sometimes"; if
  the `back` entries on a query-less route disappear, going up from there vanishes.
  Both are visible refusals, not a quietly widened listing.
- The upper nodes of the tree are storefront hubs with no `catalog.items` when
  no query is on them: `/moskva/bytovaya_elektronika` and the city root `/moskva`
  return `EmptyResultError` in both `move-category` and `get-page`. With a query
  they are ordinary listings — the sidebar's copy carries one, so a move to a
  branch answers with listings. That is Avito's shape, not the decoder's, but "this
  route is not a listing" cannot be told from "the query found nothing" by the
  error code.
