# Project memory

## Map

- [STATUS.md](STATUS.md) — what works right now, the register of failures, category coverage, standing blockers.
- [PLAN.md](PLAN.md) — the future only: phases, open questions, quality gates.
- [areas/](areas/) — one file per command domain. Everything about that domain lives inside it: contract, mechanics, decisions, facts, risks.
  - [_platform.md](areas/_platform.md) — cross-cutting: transport, anti-bot, the SSR carrier, the shared listing decoder, output shape, repository rules.
  - [search.md](areas/search.md) — `search`, `get-page`
  - [filters.md](areas/filters.md) — `get-filters`, `apply-filters`
  - [categories.md](areas/categories.md) — `get-categories`, `move-category`
  - [geo.md](areas/geo.md) — `get-location`, `get-coords`
  - [item.md](areas/item.md) — `get-item`, `get-seller-reviews`
- [site-memory.md](site-memory.md) — what any author working against Avito runs into, independent of this codebase.
- [endpoints.json](endpoints.json), [field-map.json](field-map.json) — the undocumented endpoints and the field codes decoded so far.

Decisions (`D-0xx`) and facts (`F-0xx`) live in their own domain file and keep
their numbers: the command source cites them. Numbers are never reused and gaps
in the numbering are normal — a dropped decision is deleted, not rewritten.

## Where things go

| What | Where | Who reads it |
|---|---|---|
| command contract: arguments, output type, description | the descriptor in `src/commands/`, printed by `--help` | anyone calling it |
| installation, command list, exit codes, examples | [../README.md](../README.md) | anyone installing the CLI |
| a fact about Avito, or a decision about us | the domain file in [areas/](areas/) | anyone editing a command |
| what any Avito author will hit, ours or not | [site-memory.md](site-memory.md) | the next project |
| an anonymised response sample | `../evidence/<name>-<YYYYMMDDHHMM>.json` | whoever proves the site drifted |
| how we got here | the commit message | git |

The flag list and the output type are never duplicated here: that is a rotting
copy of `--help`. Documentation says only what a flag cannot say about itself —
why it is shaped that way, what it is mutually exclusive with, what happens when
it is omitted.

Raw responses, HTML and trace artefacts go into no document at all — only into
`evidence/` or `/tmp`.

## Session ritual

Read: `STATUS.md` plus the domain file you are touching. Everything else behind
a link, when you need it.

Write: the same places. A new fact or decision goes into its domain file;
changed state into `STATUS.md`; everything still to do into `PLAN.md`.

**There is no journal.** No dated session sections, no "what we did today", no
running log in any document. A document holds what is true now; the commit
message holds the narrative that produced it. This rule has been broken once
already, and the file that broke it grew to five hundred lines of superseded
observations before anyone noticed.

The rules that keep these files small:

- fixed a problem — delete it from "Risks" rather than rewriting it in past tense;
- dropped a decision — delete it, the reason stays in git;
- a fact that a later fact supersedes is edited in place, not appended to;
- evidence older than 30 days is stale and gets re-checked;
- prose wraps at 80 columns, so a line count is not a size — the measure is one
  entry per fact and no entry that has stopped being one. A domain file that has
  outgrown a single reading is holding history, not fact.
