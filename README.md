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
src/runtime/              the CDP client, the broker, the descriptor and row contract, typed errors
src/commands/             the Node half of each command: arguments, guards, postconditions
src/browser/commands/     the page half of each command, shipped into the page and run there
src/browser/prelude/      page-side code shared by all of them, inlined into every call
src/site/                 shared Avito knowledge that runs in Node
tests/                    the offline suite — no network, no browser
scripts/                  the static checks, and the live verify runner
verify/                   one fixture per command: what a live run must answer with
evidence/                 anonymised response samples, dated, never edited
docs/                     project memory — state, plan, one file per command domain
skills/avito/             the consumer skill: how an agent uses the finished CLI
.agents/skills/           the development skills: write-command, fix-command
```

## Checks

```sh
npm install
npm run check      # lint, every gate, and the offline suite
npm run lint       # eslint, including the four rules in scripts/lib/eslint-rules.mjs
npm test           # the offline suite alone
npm run verify     # live: a command against its verify fixture (needs Chrome)
```

`scripts/README.md` explains what each gate defends. In short: a command declares
its output as a schema and every row is parsed through it before the caller sees
it, so a row cannot carry a key the descriptor does not; arguments are refused
rather than clamped; missing data never becomes a fallback value; Avito's
identifiers are never hardcoded; nothing session-bound is committed; and every
command has a verify fixture saying what its own request must come back with.

## Working here

Read [AGENTS.md](AGENTS.md) first, then [docs/STATUS.md](docs/STATUS.md) and the
domain file for whatever you are touching.

- Writing or changing a command → [.agents/skills/write-command/SKILL.md](.agents/skills/write-command/SKILL.md)
- A command that broke → [.agents/skills/fix-command/SKILL.md](.agents/skills/fix-command/SKILL.md)
- Using the finished CLI → [skills/avito/SKILL.md](skills/avito/SKILL.md)

Development drives Chrome through the Chrome DevTools MCP tools. The shipped code
does not: it talks to Chrome through `src/runtime/cdp.mjs`.

## The rule the rest follow from

A command returns correct data or it throws a typed error. There is no third
outcome — no fallback value, no sentinel row, no empty array standing in for a
failed fetch. A command that returns plausible, wrong data is worse than one that
fails, because nobody goes looking.
