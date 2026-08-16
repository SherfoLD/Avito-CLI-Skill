# Checks

Everything here runs without a browser and without Avito, except `verify.mjs`.
`npm run check` runs them all plus the offline suites.

| Script | Gate? | What it defends |
|---|---|---|
| `check-conventions.mjs` | fails on four rules | the full convention report; blocks on `missing-access-metadata`, `column-naming`, `hardcoded-site-vocabulary`, `write-without-delete-pair` |
| `check-typed-error-lint.mjs` | yes, against a baseline | `silent-clamp`, `silent-empty-fallback`, `silent-sentinel` — code that succeeds while lying |
| `check-silent-column-drop.mjs` | yes, against a baseline | a row emitting a key the descriptor never declares |
| `check-verify-fixtures.mjs` | yes | every command has a fixture, every fixture is well formed, `expect.columns` still matches the descriptor |
| `check-no-secrets.mjs` | yes | nothing session-bound is committed |
| `check-doc-coverage.mjs` | yes | every command is claimed by exactly one `docs/areas/*.md` |
| `advise-listing-id-pairing.mjs` | no, always exits 0 | a listing row carries something a detail command accepts |
| `verify.mjs` | live | runs a command for real and applies its `verify/<command>.json` |

`scripts/lib/` holds the parts the scripts share: `manifest.mjs` loads the
command descriptors, `convention-audit.mjs` holds the static rules,
`verify-fixture.mjs` holds the fixture schema and the matcher.

## Both baselines are empty, and should stay that way

`typed-error-lint-baseline.json` and `silent-column-drop-baseline.json` carry no
entries. There is no historical debt in this repository, and a command written
to the rules in `AGENTS.md` adds none.

`--update-baseline` exists for a reviewed decision that a particular violation
is correct despite the rule. It is not a way to make a red build green — that
path ends with a gate that reports zero problems while the problems are all in
a JSON file nobody reads.

## The one rule about fixtures

A failing `verify/<command>.json` means the command is wrong. Tighten the
command until the fixture passes; do not relax `patterns`, `notEmpty`,
`mustBeTruthy` or `rowCount` to accept what it currently returns — that converts
a caught regression into a silent one.

The single legitimate reason to edit a fixture is that Avito itself changed
shape. When that happens, the fact goes into the domain file in the same commit
as the fixture edit, and the commit message says what was observed.

## verify.mjs

`verify.mjs` is the only live check: it runs a command against a real Chrome,
parses its JSON output and applies the fixture. It imports `validateRows`,
`validateRowShape` and `expandFixtureArgs` from `lib/verify-fixture.mjs` — the
rules have one implementation and gain no second one.
