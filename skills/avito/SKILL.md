---
name: avito
description: Read listings, filters, categories, locations and seller reviews from Avito through the local `avito` CLI. Use when the task involves finding or reading Avito listings — searching, narrowing a search with filters, paging through results, opening one listing in full, or reading a seller's reviews. Ten read-only commands; the CLI does the browsing and the decoding.
allowed-tools: Bash(avito:*)
---

# Avito

Ten read-only commands over the user's own Chrome. **You call the CLI.** You do
not open pages, inject scripts, assemble requests or decode responses — every
command already does that, with the guards that make its answer trustworthy.

The output is already JSON — a plain array of rows, one element per result, and
an array even when a command returns exactly one. `-f table` is the option, for
showing a person; `avito <command> --help` prints the type of the rows.

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
avito get-item <url> --images-dir <dir>             → full text, and the photos as files
```

One ordering rule: `apply-filters` and `move-category` accept page 1 only and
refuse a URL carrying `p=<n>`. So filters and category first, depth after.

`get-categories` answers with the whole sidebar tree: `depth` and `parent` say
where a row hangs, and `navigable` says whether the row has a route to move to
at all — a branch heading is a destination like any other, and what is never one
is the category the search is already in. `move-category` takes a row that is
`navigable` **and** `preservesQuery: true`; it refuses the rest with the reason.
When Avito could not place a query in any category at all, several rows come
back with `current: true`: those are the candidate groups it drew instead, and
moving into one of them is how you choose.

## The commands

| Command | Subject | Gives you |
|---|---|---|
| `search <query>` | a query | the first page, plus the `searchUrl` everything else takes. Geo lives here: `--location-id`, `--metro`, `--district`, `--coords`, `--radius` |
| `get-page <searchUrl> --page <n>` | a search URL | another page of the same search |
| `get-filters <searchUrl>` | a search URL | every filter you can apply here, with its values and what is already set |
| `apply-filters <searchUrl> --set <selections>` | a search URL | the narrowed listing and a new `searchUrl` |
| `get-categories <searchUrl>` | a search URL | where you can move from here; feed a `name` into `move-category` |
| `move-category <searchUrl> --to <name>` | a search URL | the listing in another category |
| `get-item <url>` | a listing URL | the full description, a service's price table, and the original photos written to a directory you name |
| `get-seller-reviews <itemUrl>` | a listing URL | the seller's review feed |
| `get-location <query>` | a city or region name | the location ID `search` needs, and metro/district IDs |
| `get-coords <address>` | an address | the coordinate pair `--coords` needs |

Run `avito <command> --help` for the arguments and for the row type it answers
with. That is the contract; this file does not restate it — what follows is only
what a type cannot say.

## Reading the output

**A listing row is a card, not a listing.** `descriptionPreview` is text Avito
already truncated for the card, and `imageCount` is a number of photos, not the
photos. Both are complete only in `get-item`, and neither can be derived from a
row.

**Some pages arrive complete for twenty rows and thin for the other thirty.**
`get-page`, `move-category` and a `search` with no geo argument read the page
Avito renders, and it carries only its first twenty cards in full: after that
`descriptionPreview`, `location`, `sellerName` and `imageCount` are `null` — not
because the listing lacks them, but because the page did not carry them.
`itemId`, `title`, `price`, `published` and the URL are on every row regardless.
A `search` with `--location-id` (or another geo argument) and `apply-filters` go
through a different source and return all fifty complete, so narrowing a search
also thickens it. If a thin row matters, open it with `get-item`.

**`searchUrl` tells you what you actually got.** Avito canonicalises any query
into a category route, and sometimes the text query dissolves into that category
entirely. So a result is not guaranteed to be a text match for what you asked;
read `searchUrl` to see whether you received a search or a category.

**`price` is a price or it is `null`** — it is never a teaser. On services Avito
usually advertises a floor or a whole price list, and neither is what the work
costs, so:

- `minPrice` instead of `price` means the number Avito showed is not what the
  work costs — it printed «от 500 ₽», or it priced the listing by a table and put
  one number on the card. Treat it as a starting point, never as a price.
- `hasPriceList: true` means that table exists. `get-item` returns it as
  `priceList`; the row does not carry it, because the copy search holds can be
  out of date.
- both `null` means Avito printed a phrase — «Цена договорная». `price: 0` is not
  that: it means the listing really is free.

One thing the row still does not tell you: whether a number is a rate. «150 ₽ за
м²» arrives as `price: 150` like any other 150, so on services do not compare
prices across listings without opening them.

**`published` is an exact instant** (ISO 8601, UTC) in a listing row.
`publishedText` in `get-item` is Avito's rendered string — no year, no seconds,
Moscow time. If you need the date as a value, use the row.

**A `null` the type allows is Avito withholding, not a gap in the decoding.**
`sellerName` is null for private sellers when the browser session is not logged
in — that is Avito hiding identity, and the rating still arrives beside it.

## Photos

You cannot read a photo out of any command's output, because no command returns
one: a photo URL is a binary you have no way to open. `get-item` writes the files
instead.

```
avito get-item <url> --images-dir /tmp/<your-own-dir> -f json
```

Pass a directory of your own that already exists, given as an absolute path — a
temporary one you made for this task is exactly right. The command creates
`<dir>/<itemId>/` inside it and fills that with `01.jpg`, `02.jpg` … in gallery
order, so photos of different listings never mix, and puts the absolute paths in
`images`. They are ordinary JPEGs; open them the way you open any local image.

Two columns say two different things:

- `imageCount` — how many photos the listing has. Every listing row carries it,
  and so does `get-item`, whether or not you asked for the files. `null` is not
  zero: in a listing row it means the page did not carry that card's photo block
  (see the twenty/thirty split above), and in `get-item` it means the answer came
  from the visible page, which does not open the gallery.
- `images` — the files that were written. `null` means you did not pass
  `--images-dir`, an empty list means the listing has no photos, and otherwise
  it is one path per photo.

So the cheap move is to read the listing first and only spend a download on the
one or two candidates that survive the text.

If any single photo cannot be fetched, the whole call fails rather than handing
you part of a gallery. The text is one run away — repeat the command without
`--images-dir` and you get everything but the files.

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

## Known rough edges

Three, and none of them corrupts what you get — each either refuses or hands you
the wrong reason for a refusal. Read them as "expected here", not as something to
retry through.

- **`get-page` past the last page of results** reports a CAPTCHA or a rate-limit
  cooldown when it usually means there is no such page. Check the row count of
  the page you have before asking for the next one.
- **Real estate, and vacancies in jobs**: `get-filters` refuses the whole
  category when Avito ships a named filter without a name. Flat rentals, garages
  and vacancies are the confirmed routes. Search itself works; narrowing does not.
- **Jobs**: a query that mixes résumés and vacancies can refuse with "invalid
  item URL". The résumé listing itself reads — reach it through its own route
  rather than through a mixed query.

Two more categories — business equipment and Business 360 — have never been
checked, so anything there is unknown rather than known-good.
