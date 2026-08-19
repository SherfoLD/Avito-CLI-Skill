# Typed errors

Read this before writing the body of a command.

A command has exactly two honest outcomes: correct data, or one of five typed
errors. There is no third. Every silent middle ground — an empty array standing
in for a failed fetch, a row with `unknown` in it, an argument bent into range —
converts a caught failure into an uncaught one.

## The five classes

| Class | Exit | Means | Thrown when |
|---|---|---|---|
| `ArgumentError` | 2 | the caller passed something this command cannot act on | before the network, always |
| `CommandExecutionError` | 1 | the request went out and the answer cannot be trusted | HTTP refusal, shape drift, failed postcondition |
| `EmptyResultError` | 66 | the request succeeded and there is genuinely nothing | Avito returned zero matching records |
| `TimeoutError` | 75 | a browser or network operation did not answer in time | the CDP call or the fetch exceeded its budget |
| `AccessError` | 77 | Avito is not serving this session at all | a rate limit, a verification page, a document with no state |

They live in `src/runtime/errors.mjs`. Import them; do not invent a sixth.

## Where each one goes

**`ArgumentError` — everything you can check without the network.**

Validate first, then request. A geo ID is checked against the target location's
fresh directory before the search runs, because Avito accepts an unknown
`metro=999999` with `200` and an empty `metroId` — the caller's mistake would
otherwise be indistinguishable from a correct request (F-037).

Mutual exclusion is an `ArgumentError` too, and the message says why rather than
just what: `--metro` and `--district` are tabs of one Avito filter, so passing
both is refused even though the server accepts both.

**`CommandExecutionError` — the answer is not trustworthy.**

This is the class that carries almost all of this repository's weight. It covers:

- an HTTP status you did not expect;
- a response whose shape does not match what the decoder needs: an absent
  `searchCore`, a filter type that is not in the type map;
- a postcondition that did not hold: the applied value is not in the carrier that
  proves application, or a field the call did not change came back changed.

An unknown filter type stays in this class deliberately. It does not describe a
filter — it reports that the type map has fallen behind Avito, and skipping it
quietly would make the drift invisible (D-040).

**`EmptyResultError` — a real, empty answer.**

Reserved for "the request worked and there is nothing". A search that matches
nothing. A review feed page past the end. A category route that is a storefront
hub with no listings at all.

Not for a failed fetch. Not for a decoder that found no rows in a payload that
clearly has some — that is drift, and drift is `CommandExecutionError`.

**`TimeoutError` — no answer in time.**

Carries the label and the budget so the message says what timed out. Do not
retry behind it.

**`AccessError` — Avito is not answering this session.**

A `429`, a verification page, or a 200 HTML document with no state script. The
last two are the same answer and are not told apart: the page text is never
scanned to try (F-044). This is the one refusal a caller can neither retry nor
fix, and it stops looking like drift so nobody tries. Everything in
`src/site/carriers.mjs` maps `access` and `no_state` onto it.

## The three silent anti-patterns

### Silent empty

```js
try {
  return decodeRows(payload);
} catch {
  return [];            // ← the caller now believes Avito has nothing
}
```

`npm run lint` fails on `return []` inside a catch. The fix is to
throw `CommandExecutionError` with what actually went wrong.

### Sentinel row

```js
sellerName: payload.seller?.name ?? 'unknown',
price: raw.price || 0,
```

Both turn missing data into data. The first is caught by the linter; the second
is caught by requiring the column to be positive in the verify fixture, which is
why a numeric column that this request always fills belongs there.

There is a real distinction to hold here. `sellerName` is `null` when Avito
withholds it, and that `null` is correct and load-bearing (D-028) — the wrong
move would have been mapping the placeholder `Пользователь` to `null`, since some
seller may genuinely be called that. `null` means "Avito did not send a name".
`'unknown'` means "we did not look properly and hid it".

### Silent clamp

```js
const page = Math.min(requested, 50);   // ← the caller asked for 80 and got 50
```

An out-of-range argument is an `ArgumentError`. The caller has to be able to tell
"I asked for something impossible" from "I got what I asked for". This one is
also why `--limit` does not exist anywhere: the request is paid for in full
regardless, so the argument only threw away rows already received (D-022).

## Failing closed under drift

The general rule: when the shape of a response is not what the decoder needs,
stop. Do not fall back to a value.

Two calibrations from live experience, both worth copying:

- A ceiling is a guard against implausible data, not a size policy. The
  vocabulary ceiling of 2000 options refused a live page that honestly listed
  12150 manufacturers; trimming the list would have been a silent clamp, and
  failing on it was refusing reality. It was raised to catch broken data, not big
  data (F-067).
- Do not open a new failure class casually. A missing `sortTimeStamp` yields
  `null` rather than a stop, because adding a fail-closed class that could
  disable whole categories was not worth an unmeasured risk — while an impossible
  timestamp (seconds instead of milliseconds, a string, a negative) still stops
  the call (D-039).

Both directions are judgment. What is not judgment: the failure has to be
*visible*, either as a typed error or as a `null` the contract declares.
