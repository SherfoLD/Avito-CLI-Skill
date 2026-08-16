# Shared browser-side code

Everything a command runs *inside the page* and does not own alone. The previous
system could not have this directory: it required one command per file and the
browser half lived inside a template literal, so the card decoder existed in
four copies and every fix had to be applied four times.

| File | What it owns |
|---|---|
| `refusal.mjs` | the `{ success: false, stage, code, message }` envelope |
| `text.mjs` | scalar comparison, ranges, what "cleared" and "unset" mean |
| `document.mjs` | reading one SSR document, challenge text, search-URL guards |
| `json.mjs` | one same-origin JSON GET and the three ways a challenge arrives |
| `filters.mjs` | the `filtersV2` tree: the walk, and the options of one filter |
| `rubricator.mjs` | what a node of the category sidebar means (D-046) |
| `card.mjs` | the catalog-card decoder shared by the four listing commands |

`filters.mjs` is the one file here with two kinds of caller. `get-filters` and
`apply-filters` read the tree as data; `get-page` and `move-category` walk it
only to refuse a document whose filter state is malformed, and read no filter at
all. A shape check is worth sharing even where the meaning is not — which is
also why nothing in that file knows which type is a range or takes several
values. That vocabulary belongs to the command applying it.

## Two rules

These are not style. `Function.prototype.toString()` is what crosses the CDP
boundary, and a serialized function carries none of its imports — so these files
are inlined into one scope by `src/runtime/browser-prelude.mjs`, which enforces
both rules and refuses to build a prelude that breaks them.

**1. Every top-level declaration is exported.** An unexported one is invisible to
the prelude, so it would exist in Node and be a `ReferenceError` in the page.
That is the worst available failure: every offline suite would stay green.

**2. An export is a function declaration or a JSON-serializable value.** An arrow
export inlines as an expression rather than a declaration, and a `RegExp` or a
`Map` at module level cannot be rebuilt from source at all. Anything of that kind
belongs inside a function — that is why the challenge pattern is
`looksLikeChallenge(text)` and not an exported regular expression.

Both rules are covered by `tests/browser-prelude.test.mjs`, which also decodes a
synthetic catalog twice — once through the imports, once through the inlined
prelude — and compares the rows. If the two copies ever diverge, that is where it
shows.

## What does not belong here

Anything that runs in Node: argument validation, the navigation budget, typed
errors, mapping the decoder's `api*` rows onto declared columns. That is the
command's half, in `src/commands/`.

Avito knowledge that runs in Node is a third thing again, and it has its own
place: `src/site/` (D-047). The geo directories live there because they are
plain JSON reads that never have to happen in a page.

A helper used by exactly one command also does not belong here yet. Shared code
earns its place by being shared; moved too early, it becomes a parameter list
that describes one caller.
