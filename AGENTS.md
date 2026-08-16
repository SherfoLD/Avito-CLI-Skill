# Agent instructions

Private Avito CLI: ten read-only commands driving a user-owned Chrome over the
DevTools Protocol. Code in [src/](src/), project memory in [docs/](docs/), live
checks in [verify/](verify/), anonymised response samples in [evidence/](evidence/).

## Before you work

Read [docs/STATUS.md](docs/STATUS.md) and the domain file for whatever you are
about to touch: [docs/areas/](docs/areas/). Everything else is behind a link,
when you need it. The document map and the rules for writing into it are in
[docs/README.md](docs/README.md).

Writing or changing a command: [.agents/skills/write-command/SKILL.md](.agents/skills/write-command/SKILL.md).
A command that broke: [.agents/skills/fix-command/SKILL.md](.agents/skills/fix-command/SKILL.md).

## The rule the rest follow from

A command returns correct data or it throws a typed error. There is no third
outcome — no fallback value, no sentinel row, no empty array standing in for a
failed fetch. A command that returns plausible, wrong data is worse than one
that fails, because nobody goes looking.

## Rules

- Do not write network logic without fresh evidence you replayed yourself
  (D-004). Memory older than 30 days is stale by rule and gets replayed too.
- Do not work around CAPTCHA, rate limits, signatures or access control. A
  challenge is a full stop: no interaction with it, no repeated request, no
  weakened validation.
- Do not text-scan a primed origin for a challenge. Avito's own `robots.txt`
  contains the word `captcha` in its `Clean-param` directives (F-044), so the
  detector matches every time. Look for a challenge where it is visible: in the
  response to a data request and in the rendered page.
- Do not treat an echo as an application. Avito puts keys it did not apply into
  `searchCore` (F-062) and accepts geo IDs it ignores (F-037). Every
  postcondition names the carrier that proves the value took effect, by exact
  equality.
- Do not add command arguments without a confirmed need. Do not start a write
  command without a separate contract and its own safeguards.
- Do not hardcode a cookie, a token, or the ID of a region, category, filter or
  saved search. Photo sizes and sort labels are not named in code either — that
  vocabulary belongs to Avito.
- Response-shape drift ends the call with a typed error, never with a fallback
  value. On the Node side that is `decode(schema, payload, subject)`; inside the
  page it is hand-written, because a serialized function carries no imports.
- The row contract is the `row` schema in the descriptor and nowhere else.
  `columns` is derived from it, the CLI parses every row through it, and a
  verify fixture says only what is true of its own request.
- Do not relax a `verify/` fixture to get green, and do not weaken an offline
  assertion. A failing rule means the command is wrong. The one legitimate
  reason to edit a fixture is that Avito changed shape, and then the fact goes
  into the domain file in the same commit.
- Do not widen a guard past what you can justify. When the seller-slug alphabet
  failed on `agent.pc`, adding a dot would have failed on the next slug.
- Look for the other copies before declaring a fix done. A rule that exists in
  one command usually exists in four, and the fifth holds it as `continue`
  instead of `throw`.
- Raw responses, HTML and trace artefacts live in `evidence/` (anonymised,
  committed) or `/tmp`. Traces never enter the repository.
- Drive the browser through the Chrome DevTools MCP tools. The shipped code does
  not: it talks to Chrome through `src/runtime/cdp.mjs`. Open tabs without a
  side panel.

## Comments

A comment earns its place by saying something the code cannot. Two kinds fail
that test and keep coming back.

**Narrating your own change.** The next agent starts from the tree as it is and
has never seen what you replaced. "Everything is *now* checked where it is
declared", "the part of the old convention audit a schema cannot replace",
"*since* the row contract moved into the schema", "before the merge this file
rewrote source with a regex" — each describes a repository that does not exist,
to a reader who cannot check the claim. Write what is true. Git holds what
changed, and the commit message is where the change gets described.

The same applies to defending a road not taken. "Nothing about formatting is
configured here on purpose", "merging the two decoders would mean…", "a shared
traversal would have to be parameterised until it was a `for` loop" — nobody
asked. If the choice was load-bearing it is a `D-0xx` in `docs/areas/`; if it was
not, it needs no monument.

**Restating the code.** `// The visible name, falling back to its ID` above a
body that reads `name || String(locationId)` costs a line and adds nothing.
Neither does a header that lists which commands import this file, tours the
directory layout, or explains the split between `src/browser/` and `src/site/`
for the fourth time.

What does earn a comment: a fact about Avito that is not in the code (`robots.txt`
contains the word `captcha`; an unknown rating key answers `200` with an empty
feed), a trap in the shape (`{ requestError }` alone, with no status to mistake
for a zero), a contract invisible from the signature (`card.mjs` throws where
`item.mjs` returns `null`), and the `F-0xx` / `D-0xx` a reader would otherwise
have to go looking for.

Two tests before you write one. **Would this sentence make sense to somebody who
opened the repository today?** If it only makes sense to somebody who watched you
edit it, delete it. **Is this the fourth copy?** If the same paragraph belongs in
eight files, it belongs in one of them, in one line.

## Done means

```sh
npm run check                # every static gate plus the offline suite
npm run verify <command>     # live, against verify/<command>.mjs
```

Both green, **and** the values compared against the visible page field by field.
"It returned rows" is not a result; "this is the same number the page prints" is.

## After you work

- A new fact or decision goes into its domain file, one line of "what we
  observed → what follows". `F-0xx` / `D-0xx` numbers are global and never
  reused: the command source cites them.
- Changed state goes into `STATUS.md`. Fixed a problem — delete it from the
  risks rather than rewriting it in past tense. Dropped a decision — delete it;
  the reason stays in git.
- Everything still to do goes into `PLAN.md`, and nothing else does: it is the
  future only.
- The session narrative goes into the commit message. There is no separate
  journal, no log file, no dated "what we did today" section in any document —
  and there is no reason to start one. A document holds what is true now; git
  holds how it got that way.
- Do not duplicate across layers: the flag list and the column list live in
  `--help`, generated from the descriptor and its row schema, not in markdown.

## Stop and ask

- A fix needs a new argument, a new column, a retry, or a fallback value.
- Output would differ from what the command returned before, on any field, for a
  reason you cannot explain.
- A data shape appears that is in no `docs/areas/*` file.
- Three diagnose → fix → retry rounds are up. A fourth is where fixtures start
  getting relaxed.
