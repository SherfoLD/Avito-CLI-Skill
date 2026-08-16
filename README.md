# avito-cdp

A private, read-only Avito CLI driving the user's own Chrome over the DevTools
Protocol. Ten commands: search, page, filters, categories, listing detail, seller
reviews, and the resolvers those need.

Nothing here works around access control. Anonymous requests from Node are
refused by the site (`429`, `server: QRATOR`, a CAPTCHA), so every read happens
inside a browser the user is already logged into, and a challenge is a full stop
rather than something to get past.

## State

All ten commands run, and each passes a strict live verify against its fixture.
Two Avito categories out of twelve currently refuse entirely and two more have
never been checked — the refusal arrives on the call rather than being visible
in advance. `docs/STATUS.md` carries the register and the standing blockers.

The browser has to be one you already use, with debugging enabled at
`chrome://inspect/#remote-debugging`. A browser launched for automation carries
an empty profile, and Avito refuses an empty profile outright.

## Layout

```
bin/avito.mjs             CLI entry — argument parsing, --help, exit codes
src/runtime/              the CDP client, the broker, the descriptor contract, the typed errors
src/commands/             one file per command: navigation, guards, postconditions
src/decoders/             pure functions over a payload, no network
src/browser/              shared code that runs inside the page
src/site/                 shared Avito knowledge that runs in Node
tests/                    the offline suite — no network, no browser
scripts/                  the static checks, and the live verify runner
verify/                   one fixture per command: what a live run must satisfy
fixtures/                 anonymised response samples, dated, never edited
docs/                     project memory — state, plan, one file per command domain
skills/avito/             the consumer skill: how an agent uses the finished CLI
.agents/skills/           the development skills: writing a command, repairing one
```

## Checks

```sh
npm install
npm run check      # every gate plus the offline suite
npm test           # the offline suite alone
npm run verify     # live: a command against its verify fixture (needs Chrome)
```

`scripts/README.md` explains what each gate defends. In short: commands declare
their contract in a descriptor, rows may not carry keys the descriptor does not,
arguments are refused rather than clamped, missing data never becomes a fallback
value, Avito's identifiers are never hardcoded, nothing session-bound is
committed, and every command has a verify fixture that was tightened by hand.

## Working here

Read [AGENTS.md](AGENTS.md) first, then [docs/STATUS.md](docs/STATUS.md) and the
domain file for whatever you are touching.

- Writing or changing a command → [.agents/skills/cdp-command-author/SKILL.md](.agents/skills/cdp-command-author/SKILL.md)
- A command that broke → [.agents/skills/cdp-command-repair/SKILL.md](.agents/skills/cdp-command-repair/SKILL.md)
- Using the finished CLI → [skills/avito/SKILL.md](skills/avito/SKILL.md)

Development drives Chrome through the Chrome DevTools MCP tools. The shipped code
does not: it talks to Chrome through `src/runtime/cdp.mjs`.

## The rule the rest follow from

A command returns correct data or it throws a typed error. There is no third
outcome — no fallback value, no sentinel row, no empty array standing in for a
failed fetch. A command that returns plausible, wrong data is worse than one that
fails, because nobody goes looking.
