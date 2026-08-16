---
name: avito
description: Read listings, filters, categories, locations and seller reviews from Avito through the local `avito` CLI. Use when the task involves finding or reading Avito listings — searching, narrowing a search with filters, paging through results, opening one listing in full, or reading a seller's reviews. Ten read-only commands; the CLI does the browsing and the decoding.
allowed-tools: Bash(avito:*)
---

# Avito

Ten read-only commands over the user's own Chrome. **You call the CLI.** You do
not open pages, inject scripts, assemble requests or decode responses — every
command already does that, with the guards that make its answer trustworthy.

Add `-f json` when you need to read fields programmatically.

## Before the first command

Every read happens inside a browser the user already owns, so the CLI has to be
told which one. It remembers the answer in a file, which is the only thing that
survives between your shells — an `export` in the user's terminal never reaches
you. This is once per machine.

Run `avito browser`. It prints which browser will be used, whether that endpoint
is actually there, and every browser on this machine offering a connection right
now.

- **Reachable already** — nothing to do.
- **Candidates listed, none remembered** — do not choose for the user. Show them
  the list, ask which browser they want Avito read through, and then run
  `avito browser use --profile <dir>` with their answer.
- **Nothing listed** — no browser here has debugging on. Ask the user to open
  `chrome://inspect/#remote-debugging` in the browser they actually use and turn
  it on there, then run `avito browser` again.

Never launch a browser yourself, and never point this at a fresh profile. Avito
refuses a profile with no history outright, and the page it answers with blames
the IP, which sends you to debug the wrong thing.

The first command of a session opens the connection and the browser asks the
person in front of it to approve it — one prompt per session, and until they
click it the connection simply waits.

## The chain

State travels in one carrier: the canonical `searchUrl`, which every listing row
repeats. Take it from a row and hand it to the next command.

```
avito get-location "Тверь"                          → locationId
avito search "ddr5 32gb" --location-id 637640       → rows + searchUrl
avito get-filters <searchUrl>                       → keys, options, what is applied
avito apply-filters <searchUrl> --set 'price=1000..5000'  → rows + a new searchUrl
avito get-page <searchUrl> --page 2                 → the next page
avito get-item <url>                                → full text and original photos
```

One ordering rule: `apply-filters` and `move-category` accept page 1 only and
refuse a URL carrying `p=<n>`. So filters and category first, depth after.

## The commands

| Command | Subject | Gives you |
|---|---|---|
| `search <query>` | a query | the first page, plus the `searchUrl` everything else takes. Geo lives here: `--location-id`, `--metro`, `--district`, `--coords`, `--radius` |
| `get-page <searchUrl> --page <n>` | a search URL | another page of the same search |
| `get-filters <searchUrl>` | a search URL | every filter you can apply here, with its values and what is already set |
| `apply-filters <searchUrl> --set <selections>` | a search URL | the narrowed listing and a new `searchUrl` |
| `get-categories <searchUrl>` | a search URL | where you can move from here; feed a `name` into `move-category` |
| `move-category <searchUrl> --to <name>` | a search URL | the listing in another category |
| `get-item <url>` | a listing URL | the full description and the original-size photos |
| `get-seller-reviews <itemUrl>` | a listing URL | the seller's review feed |
| `get-location <query>` | a city or region name | the location ID `search` needs, and metro/district IDs |
| `get-coords <address>` | an address | the coordinate pair `--coords` needs |

Run `avito <command> --help` for the arguments. That is the contract; this file
does not restate it.

## Reading the output

**A listing row is a card, not a listing.** Two of its columns are deliberately
partial: `descriptionPreview` is text Avito already truncated for the card, and
`imagesPreviews` are catalog-size previews. The originals come only from
`get-item`, and neither can be derived from a row — every photo size has its own
opaque URL.

**`searchUrl` tells you what you actually got.** Avito canonicalises any query
into a category route, and sometimes the text query dissolves into that category
entirely. So a result is not guaranteed to be a text match for what you asked;
read `searchUrl` to see whether you received a search or a category.

**`price` is the price the card prints large**, bonuses applied.

**`published` is an exact instant** (ISO 8601, UTC) in a listing row.
`publishedText` in `get-item` is Avito's rendered string — no year, no seconds,
Moscow time. If you need the date as a value, use the row.

**`null` means Avito did not send it.** `sellerName` is null for private sellers
when the browser session is not logged in — that is Avito withholding identity,
not a missing seller.

## Applying filters

Keys and values come from `get-filters` exactly as it prints them. `valueSyntax`
tells you what to write after `key=`.

```
avito apply-filters <searchUrl> --set 'price=1000..5000;params[112691]=757883,757884'
```

- `;` separates filters, `,` separates values of one filter, `..` is a range with
  optional ends, and `key=` with no value clears it.
- Pass every filter you want in **one** call. Chaining does not accumulate values
  of the same filter — the second call replaces the first.
- A range's `options` column tells you what its bounds are: empty means numbers,
  non-empty means you pick from those values.
- A word containing `,` or `;` cannot be expressed in this grammar.
- After `move-category`, re-read `get-filters`: the previous category's keys are
  no longer valid.

## Reservation

`--remove-reserved` drops the listings Avito marks as reserved. Avito has no
server-side filter for it, so the page simply comes back shorter, and nothing in
the output says which rows were dropped.

It is **per call**. If you want reserved listings gone, pass it to every command
in the chain — `search`, `get-page`, `apply-filters`, `move-category`. A missed
flag silently brings them back.

## When a command refuses

Refusals are typed and they mean what they say. Do not retry, do not work around
them.

| Exit | Meaning | What to do |
|---|---|---|
| 2 | you passed something the command cannot act on | read the message; it names the constraint |
| 66 | the request worked and there is nothing to return | that is an answer — report it |
| 1 | the answer could not be trusted: an HTTP refusal, a challenge, a shape that drifted, a postcondition that failed | stop and report. Never retry. |
| 75 | no answer in time | report it |

A CAPTCHA or a rate limit is a full stop. Do not interact with it, do not repeat
the request, do not try a different route to the same data.

One refusal is not about Avito at all: **`could not reach the browser: …`** means
the CLI never got as far as the site. The message names the endpoint it tried.
Run `avito session status` to see which browser is configured and whether it is
there, then take it to the user — a browser that is closed, or has debugging
switched off, or an approval prompt nobody clicked, is theirs to fix, not
something to retry around.

Two known rough edges: `get-page` past the last page of results reports a
CAPTCHA or rate-limit cooldown when it usually means "there is no such page", and
two Avito categories — real estate and jobs — currently refuse entirely on some
routes. `docs/STATUS.md` has the current register.
