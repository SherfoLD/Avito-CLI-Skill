# Checks

Everything here runs without a browser and without Avito, except `verify.mjs`.
`npm run check` runs them all plus the linter and the offline suites.

| Script | Gate? | What it defends |
|---|---|---|
| `eslint .` (`npm run lint`) | yes | the ordinary mistakes, plus the four repository rules in `lib/eslint-rules.mjs`: `no-silent-clamp`, `no-empty-catch-fallback`, `no-silent-sentinel`, `no-site-vocabulary` |
| `check-commands.mjs` | yes | every command imports and declares a reviewable contract; a write command ships with the command that undoes it |
| `check-verify-fixtures.mjs` | yes | every command has a fixture, every fixture loads, every column it names exists, and it constrains something the row schema does not |
| `check-no-secrets.mjs` | yes | nothing session-bound is committed |
| `check-doc-coverage.mjs` | yes | every command is claimed by exactly one `docs/areas/*.md` |
| `advise-listing-id-pairing.mjs` | no, always exits 0 | a listing row carries something a detail command accepts |
| `verify.mjs` | live | runs a command for real and applies its `verify/<command>.mjs` |

`scripts/lib/` holds the parts the scripts share: `manifest.mjs` loads the
command descriptors, `verify-fixture.mjs` loads a fixture and applies it,
`eslint-rules.mjs` holds the four custom rules.

## Where the row contract is checked

Not here — it is the `row` schema in the command's own descriptor, enforced by
`defineCommand` at import and by `bin/avito.mjs` on every row it prints (D-048).
No script needs to look at a row.

`tests/schema.test.mjs`, `tests/lint-rules.test.mjs` and
`tests/verify-fixtures.test.mjs` exercise the machinery above, because a gate
that cannot fail looks exactly like one that passes.

## The one rule about fixtures

A failing `verify/<command>.mjs` means the command is wrong. Tighten the command
until the fixture passes; do not widen the fixture's schema to accept what the
command currently returns — that converts a caught regression into a silent one.

The single legitimate reason to edit a fixture is that Avito itself changed
shape. When that happens, the fact goes into the domain file in the same commit
as the fixture edit, and the commit message says what was observed.

## verify.mjs

`verify.mjs` is the only live check: it runs the CLI as a subprocess, parses its
JSON output and applies the fixture. It does not re-check the row shape — the CLI
already parsed every row through the command's schema, so a shape failure has
ended the run with a non-zero exit code before verify sees anything.
