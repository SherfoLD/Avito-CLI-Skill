---
name: cdp-command-author
description: Use when writing a new command for this repository, or changing what an existing one returns. Takes you from first look at a page, through picking a carrier and decoding fields, to a green offline suite and a live verify fixture. For a command that used to work and now fails, use cdp-command-repair instead.
allowed-tools: Read, Edit, Write, Grep, Bash(npm:*), Bash(node:*), Bash(git:*)
---

# Writing a command

You are adding or changing a read-only command that drives the user's own Chrome
over the DevTools Protocol. The target is one closed loop: **evidence you
replayed yourself → a decoded carrier → a command → a green offline suite → a
live verify fixture you tightened by hand.**

Nothing here is finished at "it returned rows". A command that returns
plausible, wrong data is worse than one that fails, because nobody goes looking.

## Before anything

Read [AGENTS.md](../../../AGENTS.md), [docs/STATUS.md](../../../docs/STATUS.md)
and [docs/areas/_platform.md](../../../docs/areas/_platform.md). Then the domain
file for whatever you are touching. If you are about to write network logic and
you have not replayed the response yourself in this session, stop — that is D-004
and it is the rule everything else here rests on.

While developing you drive Chrome through the Chrome DevTools MCP tools: open a
page, take a snapshot, evaluate a script in page context, list network requests,
read one response. That is how you *look*. The shipped command never goes through
MCP — it talks to Chrome through `src/runtime/cdp.mjs`.

## The hard stops

These are not style. Each one exists because ignoring it produced wrong data
that survived a green check.

- A challenge — CAPTCHA, `429`, an IP block — is a full stop. No interaction, no
  retry, no weakened validation. Record what you saw and stop.
- Never text-scan the primed origin for a challenge. `robots.txt` contains the
  word `captcha` in its own directives (F-044), so the detector always matches.
- Never hardcode an identifier Avito owns: region, category, filter, saved
  search, photo size, sort label. `npm run check:conventions` fails the build
  over it.
- Never render the catalog. Prime `robots.txt`, then same-origin fetch.
- One request per call. The one exception in the whole repository is the bounded
  bootstrap recovery in `search`.

## Step 0 — is this in scope?

Three questions:

1. Is the data visible in a normal browser to this user? If not, stop — nothing
   here works around access control.
2. Does it arrive as HTML, JSON, or hydration state? If not, it is out of scope.
3. Does it need a push channel? If yes, find the HTTP equivalent; if there is
   none, stop.

## The carrier note

**Pick the carrier before you write code.** Every time you reach Step 4, produce
this note. Without it, do not create a file in `src/commands/`.

```md
Carrier: SSR_BOOTSTRAP | PAGE_FETCH_JSON | HYDRATION | VISIBLE_DOM
Contract: visible-ui | internal-unstable
Evidence:
- observed request/state: <endpoint or state path>
- replay result: <status + content-type + the shape of a non-empty sample>
- postcondition carrier: <what proves the request actually applied>
Fallbacks: <what happens when the primary drifts, and why that is not a guess>
```

The question is never "is an API better than the DOM". It is **does this source
have a contract with anyone**. On this site the answer is already known and
written down: the SSR bootstrap is the primary carrier for everything catalog
shaped, the internal JSON endpoints are `internal-unstable` and validated
fail-closed, and the visible DOM is the last fallback. See
[references/carrier-selection.md](references/carrier-selection.md) before you
deviate from that.

## Decision tree

```
START
  │
  ▼
Read the domain file + docs/site-memory.md + docs/endpoints.json
  │  hit: the endpoint and the fields are already known
  │       → still replay it. Memory older than 30 days is stale by rule.
  │  miss → keep going
  ▼
Look at the page with the Chrome DevTools MCP tools (references/recon.md)
  │
  ▼
Find the carrier: network → hydration state → SSR script → visible DOM
  │
  ▼
Replay it yourself, same-origin, from a primed page
  │  401/403 → the session, not the code. Stop and say so.
  │  200 + HTML where JSON was expected → wrong carrier, go back
  │  200 + empty → is that Avito's answer or your parameters? Prove which.
  ▼
Write the carrier note
  │
  ▼
Decode the fields — compare at least one against the visible page by eye
  │  (references/silent-failures.md before you trust anything)
  ▼
Design the columns (references/output-design.md)
  │
  ▼
Write src/commands/<name>.mjs + src/decoders/<name>.mjs
  │  (references/command-template.md, references/typed-errors.md)
  ▼
Offline suite: npm test          ── red ──→ fix the command, never the assertion
  │
  ▼
Live: npm run verify <name>      ── red ──→ cdp-command-repair skill
  │
  ▼
Seed the fixture, then TIGHTEN IT BY HAND (references/verify-fixtures.md)
  │
  ▼
Compare the values against the visible page, field by field
  │  wrong → back to decoding
  ▼
Write the memory: docs/areas/<domain>.md, docs/STATUS.md, the commit message
  │
  ▼
npm run check                    ── green ──→ DONE
```

## Runbook

```
[ ] 1. Read docs/STATUS.md and the domain file. Check docs/PLAN.md for whether
       this work is already scoped as a phase.
[ ] 2. Read the site memory:
       [ ] docs/endpoints.json — is the endpoint already known?
       [ ] docs/site-memory.md — the pitfalls section, in full
       [ ] fixtures/ — grep the stored samples for the field names you are
           about to use; that is what a stored sample is for
       [ ] a hit does NOT let you skip the replay; it lets you skip the search
[ ] 3. Recon with the Chrome DevTools MCP tools (references/recon.md):
       [ ] open the page in a tab of the user's own Chrome
       [ ] list the network requests, find the one that carries the data
       [ ] read one response in full, not a summary of it
       [ ] if the data is in the document rather than an XHR, read the SSR
           bootstrap script, not the hydrated DOM
[ ] 4. Replay the candidate yourself from a primed origin:
       [ ] status 200
       [ ] the payload contains the target data, not markup or telemetry
       [ ] you can name the field that will serve as the postcondition
[ ] 5. Write the carrier note. Mandatory artefact before any code.
[ ] 6. Decode the fields:
       [ ] self-describing → use the key
       [ ] known code → docs/field-map.json
       [ ] unknown code → compare two records that differ in exactly one visible
           way; never guess from the name
       [ ] check at least one decoded value against the visible page by eye
[ ] 7. Design the columns (references/output-design.md):
       [ ] camelCase, aligned with the neighbouring commands
       [ ] at most 12, nesting depth at most 1
       [ ] order: identity → the business numbers → metadata
       [ ] if this is a listing command, the 12 keys and their order are fixed
[ ] 8. Write the command:
       [ ] copy the closest existing neighbour rather than starting blank
       [ ] descriptor first: description, args with help text, columns, example
       [ ] the browser-side script is a module, not a template string
       [ ] the decoder is a pure function over the payload, in src/decoders/
       [ ] every known failure throws a typed error (references/typed-errors.md)
[ ] 9. Offline suite:
       [ ] add a suite that runs the real decoder against a synthetic carrier
       [ ] assert the navigation budget: how many requests, and which
       [ ] assert the declared columns against a returned row
       [ ] npm test green
[ ] 10. Live verify:
        [ ] run it once for real and read the rows
        [ ] seed verify/<name>.json from that run
        [ ] then TIGHTEN: patterns for URL / date / ID formats, notEmpty for the
            fields that cannot be empty on any row, mustBeTruthy for numbers,
            mustNotContain for the bleed you saw, a real rowCount range
        [ ] run verify again and confirm it still passes
[ ] 11. Compare the values against the visible page, field by field. Not
        "did it return rows" — "is this the same number the page prints".
[ ] 12. Write the memory:
        [ ] a new fact or decision → its domain file, one line of
            "what we observed → what follows", with the next free F-0xx / D-0xx
        [ ] the session narrative → the commit message. There is no journal
            file and you are not to start one (AGENTS.md)
        [ ] changed state → docs/STATUS.md; remaining work → docs/PLAN.md
        [ ] an anonymised full response sample →
            fixtures/<name>-<YYYYMMDDHHMM>.json, with cookies, tokens and
            personal fields stripped before saving
        [ ] delete any scratch dumps you left outside fixtures/ and /tmp
[ ] 13. npm run check
```

## When a step stalls

| Stuck at | What you see | Go to |
|---|---|---|
| 3, recon | no XHR carries the data | the SSR bootstrap script in the document |
| | the document has no bootstrap either | the hydration global, then the visible DOM |
| 4, replay | 401 / 403 | the session, not the code. Stop and tell the user. |
| | 200 but HTML | wrong carrier — back to step 3 |
| | 200 but empty | prove which: change one parameter and see if it moves |
| 6, decoding | two fields both look right | [references/silent-failures.md](references/silent-failures.md) §3 — compare against a record whose value you can read on the page |
| 9, offline | an assertion is in the way | the assertion is right until proven otherwise. Fix the command. |
| 10, verify | a `pattern` rule fails | check the value against the page **first**. Value right → the pattern is too tight. Value wrong → your mapping is wrong. Never relax the fixture to get green. |
| | `missing column "X"` | either the response no longer has it, or your args changed the shape. Find out which before touching anything. |
| | a column is always `null` | the field path is wrong — back to step 6 |
| 11, comparison | the number is off by a factor | units. Avito's and yours disagree. |

## References

| File | When |
|---|---|
| [references/recon.md](references/recon.md) | Step 3: driving Chrome through MCP, and what to look at in what order |
| [references/carrier-selection.md](references/carrier-selection.md) | Step 5: the carrier classes, their contracts and their real maintenance cost |
| [references/output-design.md](references/output-design.md) | Step 7: naming, types, order, the 12-key ceiling |
| [references/command-template.md](references/command-template.md) | Step 8: file layout, the descriptor, the split between command and decoder |
| [references/typed-errors.md](references/typed-errors.md) | Step 8, before writing the body: which error goes where, and the three silent anti-patterns |
| [references/offline-suites.md](references/offline-suites.md) | Step 9: synthetic carriers, budget assertions, what an offline suite can and cannot prove |
| [references/verify-fixtures.md](references/verify-fixtures.md) | Step 10: seeding a fixture and then making it worth having |
| [references/silent-failures.md](references/silent-failures.md) | Step 6 and Step 11: the ways a green check hides wrong data |

## Conventions this repository holds to

- A command module default-exports `defineCommand({...})`. The descriptor is the
  contract: `--help` prints it, the checks read it, the fixture pins it.
- The `columns` array and the keys of a returned row match exactly, order
  included. An intermediate parsing object must not reuse a column name — that
  makes the column-drop check misread the file. Name it separately and
  destructure when you build the row.
- A decoder is a pure function in `src/decoders/`. If it needs the network, it
  is not a decoder.
- Known failures throw one of the four typed errors. Never `return []` from a
  catch, never a sentinel row, never `Math.min` on an argument the caller gave you.
- Raw dumps live in `fixtures/` (anonymised, committed) or `/tmp` (anything
  else). Never in `src/`, never in the repository root.
- Site memory is written every round. No memory → use this skill → memory
  exists → next time the same work is five minutes.

## Stuck

- Diagnosis: `npm run check`, then the domain file, then the repair skill.
- Field decoding: compare two records that differ in exactly one visible way. If
  that fails, return the raw value and iterate — do not name it something you
  cannot prove.
- Endpoint missing: it is probably in the SSR bootstrap rather than an XHR. This
  site puts almost everything there.

Do not guess. A wrong guess passes verify and the user finds out from garbage.
