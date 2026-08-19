---
name: fix-command
description: Use when a command that used to work now fails — a typed error at runtime, a red offline suite, or a live expectation that stopped matching. Guides diagnosis, a bounded repair, and writing the result into memory. For writing a new command, use write-command instead.
allowed-tools: Read, Edit, Write, Grep, Bash(npm:*), Bash(node:*), Bash(git:*)
---

# Repairing a command

A command failed. Diagnose it, fix it, and record what changed — do not just
report the error, and do not start editing before you know which of four things
happened.

## Hard stops, checked first

Not every failure is a bug in the code, and three of them must never be answered
with an edit.

- **A challenge — CAPTCHA, `429`, `Доступ ограничен: проблема с IP`.** Stop.
  Close the tab without touching the challenge. Do not repeat the request. This
  is not a code defect and no code change is the right response. Tell the user
  what you saw.
- **The browser is not reachable.** Stop. That is the user's Chrome, their
  profile, or the debugging port — say which and let them fix it.
- **A session-shaped answer.** `401`, `403`, or a payload where identity fields
  are blank. An anonymous session is handed different data on this site (F-049);
  the fix is logging in, not decoding around it.

**Repair budget: three rounds.** If diagnose → fix → retry has not resolved it in
three, stop and report what was tried. A fourth round is where expectations start
getting relaxed.

## "Empty" is not "broken"

An `EmptyResultError` is often the correct answer. Rule that out before
committing to a repair:

- **Was the request answered?** A `200` with an empty result set is an answer.
  Report "nothing matches" rather than patching a working command.
- **Does it reproduce?** Try a neighbouring input. If one query returns nothing
  and a similar one returns fifty listings, the command is fine.
- **Is it a boundary rather than a failure?** On this site the page past the last
  page of results answers `429`, not an empty page (F-061). A `429` at the end of
  a listing is a known false alarm about rate limiting.
- **Can you see the data in a normal tab?** If yes and the command cannot, look
  at session state before code.

Only proceed if the failure is reproducible across retries and inputs. Otherwise
you are patching a working command to chase noise, and the patch breaks the path
that worked.

## Step 1 — Name the failure class

| Symptom | Class | Where to look |
|---|---|---|
| `ArgumentError` | the caller, or a guard that got stricter than reality | the guard, and whether Avito really refuses that input |
| `CommandExecutionError` about shape | drift: Avito changed the payload | the carrier, compared against a stored evidence sample. The message names the path that broke (`point.latitude`, `stations.0.name`) — start there. |
| `... breaks its own contract` | drift on our side of the boundary | the answer no longer satisfies the descriptor's `output` schema, and the message names the path. Either a field stopped arriving, or a mapping changed. Never widen the schema to make it pass. |
| `CommandExecutionError` about a postcondition | drift, or applied-vs-echoed | which carrier proves application for that key |
| `EmptyResultError` | usually not a defect | the section above |
| `TimeoutError` | the browser, the tab, or one slow endpoint | a fresh tab first — a hung recon tab looks exactly like this |
| red offline suite | the change you just made | the assertion is right until proven otherwise |
| red live expectation | the value, or the rule | compare against the visible page **before** anything else |

## Step 2 — Get the evidence

Reproduce with the smallest input that fails. Then look at the response with the
Chrome DevTools MCP tools: open the same route, read the same carrier, compare it
against the stored sample in `evidence/` for that command.

The comparison is the point. `evidence/` exists so that "Avito changed" is a
thing you can demonstrate rather than assume. If there is no relevant sample, say
so — and save one now, anonymised, so the next repair has it.

## Step 3 — Decide what actually changed

Four possibilities, and they have different fixes:

1. **Avito changed shape.** The decoder needs to learn the new shape. The
   consequence goes into the domain file as a fact, and the anonymised sample
   that shows the new shape goes into `evidence/`.
2. **Our guard was wrong.** It was written from two categories and treated as the
   shape of Avito. The ceiling of 2000 filter options refused a live page with
   12150; the `sellerId` alphabet refused a real seller slug. The fix widens the
   guard to what is actually implausible — and never past that.
3. **Our mapping was wrong all along.** The command was reading a field that
   happened to agree. This is the dangerous case: it means past output was wrong
   and probably satisfied its live expectation. Check whether that expectation was
   written from the same assumption as the code.
4. **Nothing changed.** Session, tab, or boundary. See the hard stops.

Say which one out loud before editing. The fix for (2) and the fix for (3) look
similar and mean opposite things.

## Step 4 — Patch

- **Change only the command and its decoder.** Not the runtime, not the checks,
  not `package.json`.
- **Do not widen a guard past what you can justify.** When the seller-slug
  alphabet failed on `agent.pc`, adding a dot would have failed on the next slug.
  The guard was replaced with the only property that was actually required — that
  the value is still the single route segment it was read from.
- **Look for the other copies.** A rule that exists in one command usually exists
  in four. When the slug check was fixed, five commands held it — and the fifth
  had it as `continue` instead of `throw`, so it had been quietly returning the
  wrong value rather than failing. Grep before you declare it fixed.
- **Never relax a live expectation to silence a failure.** A rule that fires means
  the output is broken. Tighten the command. The one legitimate reason to edit an
  expectation during a repair is that the site changed shape — and then the fact
  is written into the domain file in the same commit. Otherwise the edit converts a caught
  regression into a silent one.
- **Never weaken an offline assertion.** If one genuinely has to change, that is
  a contract change with a `D-0xx` number, not a repair.
- **No retry as a fix.** An intermittent failure gets recorded, not wrapped in a
  loop. This repository has exactly one bounded retry and adding a second needs
  its own argument.

## Step 5 — Verify

```
npm test                  # offline, every suite
npm run verify <command>  # live, against expectations/<command>.mjs
npm run check             # lint and the static gates
```

Then compare the values against the visible page. A repair that makes verify
green without anyone looking at the data is how case (3) survives.

If the expectation needed to become stricter as a result — because the failure
showed a hole in it — make it stricter now. A repair that leaves the same class of bug
undetectable next time is half a repair.

## Step 6 — Write it down

- The consequence, in the domain file: a new `F-0xx` if it is a fact about Avito,
  a new `D-0xx` if it is a decision about us. If it supersedes an existing entry,
  edit that entry rather than appending a second one beside it.
- The evidence, in `evidence/`: the anonymised sample you compared against, so
  the next repair can demonstrate drift instead of assuming it.
- `docs/STATUS.md`: if this changed what works, update it. If you fixed a listed
  risk, **delete** the risk rather than rewriting it in past tense.
- The commit message carries the narrative.

Two things worth stating in the write-up because they are easy to get wrong later:
whether the defect's shape belongs to the category or to the seller (a green
category proves nothing about a defect that belongs to a seller — F-057), and
whether the expectation would have caught it if it had been written independently.

## When to stop and ask

- The fix requires adding an argument, an output field, a retry or a fallback value.
- The output would differ from what the command returned before, on any field,
  for a reason you cannot explain.
- Three rounds are up.
- A data shape appears that is in no `docs/areas/*` file.
