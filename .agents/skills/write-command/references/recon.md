# Recon: looking at the page

You drive the user's own Chrome through the Chrome DevTools MCP tools. That
browser carries the real profile, which matters: an anonymous session is handed
different data (F-049), so recon done in a clean profile can be wrong about
fields that exist.

Check the tool list your session actually exposes before you start. The server
normally offers roughly: opening and selecting pages, navigating, taking a text
snapshot of the accessibility tree, taking a screenshot, clicking / filling /
hovering, evaluating a script in page context, listing network requests, fetching
one request's detail, and listing console messages.

## Order of looking

Cheapest first, and stop as soon as you have the carrier.

1. **The network list.** Load the page, then list requests and look for the one
   whose response holds the data a human sees. Ignore telemetry, ads, fonts and
   images. On this site, the one that matters is usually the document itself.
2. **The document's SSR bootstrap.** This site ships state in an inert script:
   `script[type="mime/invalid"][data-mfe-state="true"]` → `loaderData.data`.
   The client parses it and **removes it during hydration**, so it exists in the
   fetched HTML and not in the live DOM. Read the raw response, not the DOM.
3. **The hydration global.** For listing pages the same object is reachable at
   `window.__staticRouterHydrationData`. Useful for cross-checking a decode; not
   a carrier a command should depend on when a document fetch will do.
4. **The visible DOM.** The last resort, and the only carrier that survives a
   value being computed at render time. Anchor on `data-marker` attributes, never
   on CSS-module class names and never on visible text.

## Rules while looking

- **Do not navigate to the catalog to read data.** A catalog page load pulls
  hundreds of requests. Prime `https://www.avito.ru/robots.txt` and fetch
  same-origin from there — that is the whole transport model, and recon that
  ignores it measures a page the command will never load.
- **One tab, one purpose.** A tab you have been issuing fetches from can hang;
  the same fetch then times out at ~115 s while a fresh tab answers in 2 s. That
  is an environment fault, not a rate limit, and it must never be recorded as
  one. Open a new tab instead of theorising.
- **Read one response completely.** A summary of a response tells you the keys
  that survived summarising. Half the traps on this site are fields that exist
  and are wrong, not fields that are missing.
- **Never interact with a challenge.** If a CAPTCHA or an IP-block page appears,
  close the tab and stop. Do not check the box, do not reload, do not "just try
  once more".

## Comparing two records

This is the technique that decodes almost everything here. To learn what a field
means, do not read its name — find two records that differ in exactly one way
you can see on the page, and diff their payloads.

Worked example from this repository: `params[110000]=329202` was applied on cars,
and the schema grew a new filter, «Модель авто», with 65 options. Applying
`params[110001]=331035` grew «Поколение авто» with 10. That is what proved the car
picker fills three ordinary filters rather than filtering anything itself (F-066).

## Recording what you found

An anonymised full sample of the response goes to
`evidence/<name>-<YYYYMMDDHHMM>.json`. Strip cookies, tokens, and anything
personal — a phone number, an email, a nickname, a user id — before saving.
`npm run check:secrets` will catch the obvious cases; it cannot catch a nickname.

Raw HTML dumps, HAR files and traces stay out of the repository entirely. They
are large, they are unreviewable, and they carry session headers.
