# The page half

Everything a command runs *inside the page*, in two directories that differ by
who ships them:

```
commands/<name>.mjs   an entry point, serialized into the page on the call
prelude/*.mjs         shared by all of them, inlined into every call
```

The page fetches. It does not decide, check or decode: a carrier crosses to Node
as Avito sent it, and what it means is settled there against a schema in
`src/schemas/` (D-065, D-068, D-069). Only two things keep code here at all —
same-origin `fetch` with the user's cookies, and a real DOM.

## commands/

| File | What it is for |
|---|---|
| `carriers.mjs` | the two reads six commands share: one SSR document, and one URL the node half built |
| `get-item.mjs` | the item API, and the hydration state of a listing that was actually rendered |
| `get-coords.mjs` | one JSON read, plus the one classification only that endpoint makes |

`carriers.mjs` is what `search`, `get-page`, `apply-filters`, `move-category`,
`get-filters` and `get-categories` run. `readDocumentState` hands over the state
that was inside one document — the top-level keys the caller named, and nothing
interpreted. `readItemsApi` fetches one URL Node built and hands over the JSON.
Neither knows which command asked.

Each entry point is serialized on its own, so it may reach only for a prelude
name — a constant in its own file does not exist in the page.

## prelude/

| File | What it owns |
|---|---|
| `refusal.mjs` | the `{ success: false, stage, code, message }` envelope |
| `document.mjs` | reading one SSR document, and the challenge text |
| `json.mjs` | one same-origin JSON GET and the three ways a challenge arrives |

`src/site/carriers.mjs` is the other side of that envelope: it turns a refusal
into one of the five typed errors and a response into a decoded value.

## Two rules

These are not style, and they apply to `prelude/` only.
`Function.prototype.toString()` is what crosses the CDP boundary, and a
serialized function carries none of its imports — so every file in `prelude/` is
inlined into one scope by `src/runtime/browser-prelude.mjs`, which enforces both
rules and refuses to build a prelude that breaks them.

**1. Every top-level declaration is exported.** An unexported one is invisible to
the prelude, so it would exist in Node and be a `ReferenceError` in the page.
That is the worst available failure: every offline suite would stay green.

**2. An export is a function declaration or a JSON-serializable value.** An arrow
export inlines as an expression rather than a declaration, and a `RegExp` or a
`Map` at module level cannot be rebuilt from source at all. Anything of that kind
belongs inside a function — that is why the challenge pattern is
`looksLikeChallenge(text)` and not an exported regular expression.

Three files is small, and the machinery still earns its place: `document.mjs`
reaches into `refusal.mjs` and `json.mjs` into `document.mjs`, which is exactly
the cross-file call a serialized function cannot make on its own.
`tests/prelude.test.mjs` runs both of those edges twice — imported and inlined —
and compares the answers.

## The HTML stops here

`readDocument` is the only place that parses HTML, and what it hands over is the
JSON that was inside the state script — never the markup. There is one HTML
parser for a document and it is the browser's own (D-066). A document with no
state script is a refusal from there, not a value for a caller to classify: what
Avito serves as a verification page and what a missing bootstrap looks like are
the same 200 HTML page, and `looksLikeChallenge` is not run over it. That
function survives only where there is a real rendered page to read —
`get-item`'s hydration path and the text of a response that should have been
JSON.

## What does not belong here

Everything else: argument validation, the request a fetch is pointed at, the
postconditions on what came back, typed errors, and turning an Avito payload into
answer. All of it is Node, in `src/commands/`, `src/site/` and `src/schemas/`.

The guards that do remain here are hand-written because `zod` cannot cross
`Function.prototype.toString()` any more than any other import can. That is the
reason there are so few of them left.
