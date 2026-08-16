# Choosing a carrier

A carrier is where a value actually lives. Choosing one is the decision that
determines how often this command breaks, so it is written down before the code
exists.

The useful question is not "API or DOM". It is **does this source have a contract
with anybody**. A public, documented endpoint has one. A rendered page has one
with its own users — a site cannot silently change what a human reads. An
internal XHR has a contract with nothing but the site's own frontend build, and
it changes whenever that build does.

| Carrier | Contract | Use when | Evidence required |
|---|---|---|---|
| `SSR_BOOTSTRAP` | visible-ui | the state the page renders from is in the document | the script node and the path inside `loaderData` |
| `HYDRATION` | visible-ui | the same object is only reachable after hydration | the global path plus proof the document does not carry it |
| `PAGE_FETCH_JSON` | internal-unstable | only a same-origin fetch from a live session returns it | a replay you ran, with status, content type and a non-empty sample |
| `VISIBLE_DOM` | visible-ui | the value is computed at render time and exists nowhere else | a semantic anchor, and a typed error when it is missing |

On this site the ranking is already settled by evidence, and you should have a
reason before departing from it:

- The SSR bootstrap is the primary carrier for listings, filters and the category
  tree. One document fetch gives rows, postconditions, the filter schema and the
  navigation tree at once.
- The seven internal JSON endpoints are `internal-unstable` by declaration. They
  are validated fail-closed, called once, and never retried.
- The visible DOM is the final fallback in `get-item` and nowhere else.

## Why the ranking is not "API first"

An internal endpoint is not more reliable for being JSON. On this site the
document carries strictly more than the endpoint does, at the same cost, and
`/web/1/js/items` is the one that answers `429`. "Fetch the JSON API" would have
been the natural instinct and it would have been the fragile choice.

The one thing an internal endpoint does buy is applying state that a URL cannot
express. A city cannot be applied by editing a URL — the pathname wins and
`locationId` is silently ignored — so geo has to go through the items API. That
is a reason. "It returns JSON" is not.

## Postconditions belong to the carrier note

Naming the carrier is half the note. The other half is naming **what proves the
request did what you asked**, because on this site an accepted request is not an
applied one.

Two confirmed traps:

- Avito echoes a `params[...]` key it did not apply. The key appears in
  `searchCore.params`, the result count does not move, and
  `filtersV2.currentValue` stays empty (F-062). So `searchCore` alone proves
  nothing about `params[...]`; the schema is what separates applied from echoed.
- The reverse holds for the five short keys: their `filtersV2.currentValue`
  arrives stale or missing on a correct response, so for those `searchCore` is
  the authority and the schema is only a vocabulary (F-032).

A postcondition also has to be checked against the right thing. An applied
`price` is serialised by Avito into the opaque `f=` blob rather than back into
`pmin` / `pmax`, so a check over URL shape would have been wrong even though the
request was correct (F-052).

## What the note must contain

```md
Carrier: SSR_BOOTSTRAP | PAGE_FETCH_JSON | HYDRATION | VISIBLE_DOM
Contract: visible-ui | internal-unstable
Evidence:
- observed request/state: <endpoint or path inside loaderData>
- replay result: <status + content-type + shape of a non-empty sample>
- postcondition carrier: <the field that proves application, and why that one>
Fallbacks: <what happens on drift — and it is a typed error unless you can
            explain why a second carrier is not a guess>
```

If you pick `PAGE_FETCH_JSON`, the note also answers: why the document does not
carry this, and why the extra maintenance cost is worth it. If you pick
`VISIBLE_DOM`, you do not have to defend it against an API — say what the
semantic anchor is and what typed error fires when the anchor is gone.

## Fallbacks are not free

`get-item` has three layers — API, then hydration, then DOM — and that is
deliberate: the primary is an undocumented endpoint, so a second reading of the
same state bounds the risk. But every fallback is also a way for the command to
keep answering with different semantics after the primary drifts.

The listing row shows the cost directly. The flat `item.description`,
`item.priceDetailed` and `item.location.name` all still exist and are all wrong
in a specific way — empty, base price, and null on most rows. They stay as
fallbacks, which is exactly why carrier drift there produces different data
rather than a refusal. The only defence is a fixture rule that fires when the
fallback value shows up, and the price has no such rule today.

So: a fallback needs a reason, and the reason has to be that the fallback is
*equivalent*, not merely *present*.
