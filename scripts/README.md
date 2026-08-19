# Checks

Everything here runs without a browser and without Avito, except `verify.mjs`.
`npm run check` runs them all plus the linter and the offline suites.

| Script | Gate? | What it defends |
|---|---|---|
| `eslint .` (`npm run lint`) | yes | the ordinary mistakes, plus the four repository rules in `lib/eslint-rules.mjs`: `no-silent-clamp`, `no-empty-catch-fallback`, `no-silent-sentinel`, `no-site-vocabulary` |
| `check-commands.mjs` | yes | every command imports and declares a reviewable contract; a write command ships with the command that undoes it |
| `check-expectations.mjs` | yes | every command has an expectation, every one loads, every field it names exists at the path it names it, and it constrains something the output schema does not |
| `check-no-secrets.mjs` | yes | nothing session-bound is committed |
| `check-doc-coverage.mjs` | yes | every command is claimed by exactly one `docs/areas/*.md` |
| `advise-listing-id-pairing.mjs` | no, always exits 0 | a listing carries something a detail command accepts |
| `verify.mjs` | live | runs a command for real and applies its `expectations/<command>.mjs` |

`scripts/lib/` holds the parts the scripts share: `manifest.mjs` loads the
command descriptors, `expectation.mjs` loads an expectation and applies it,
`eslint-rules.mjs` holds the four custom rules.

`check-commands.mjs` also holds the one rule that needs two declarations to see:
`type` is written by hand while `output` is what the CLI enforces, so a name in
one and not the other is refused.

## Where the output contract is checked

Not here — it is the `output` schema in the command's own descriptor, enforced by
`defineCommand` at import and by `bin/avito.mjs` on every answer it prints
(D-048). No script needs to look at the data.

`tests/schema.test.mjs`, `tests/lint-rules.test.mjs` and
`tests/expectations.test.mjs` exercise the machinery above, because a gate that
cannot fail looks exactly like one that passes.

## The one rule about expectations

A failing `expectations/<command>.mjs` means the command is wrong. Tighten the
command until it passes; do not widen the expectation to accept what the command
currently returns — that converts a caught regression into a silent one.

The single legitimate reason to edit one is that Avito itself changed shape. When
that happens, the fact goes into the domain file in the same commit as the edit,
and the commit message says what was observed.

## verify.mjs

`verify.mjs` is the only live check: it runs the CLI as a subprocess, parses the
JSON object it printed and applies the expectation. It does not re-check the
shape — the CLI already parsed the whole answer through the command's schema, so
a shape failure has ended the run with a non-zero exit code before verify sees
anything.
