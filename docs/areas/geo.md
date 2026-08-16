# Geo — `get-location`, `get-coords`

Confirmed live: 2026-08-15

Transport and the shared rules are in [_platform.md](_platform.md). Geo is
applied by `search` (see [search.md](search.md)); these two only resolve
identifiers.

## Contract

`get-location <query>` resolves a visible name into an Avito location ID. The
`--geo metro|districts` mode turns it into a directory of geo IDs for one exactly
matched location; `--geo-query` filters by the visible station or district name.
Columns: `rank`, `locationId`, `locationName`, `geoMode`, `geoId`, `geoName`,
`geoGroup`.

The columns are split deliberately: `locationName` always means a city or a
region, `geoName` a station or a district. Neither changes meaning between modes.

`--limit` is `1..10` in resolver mode (matching the observed UI request) and
`1..400` in `--geo` mode, defaulting to 400. The default matters: without it,
Moscow with its 357 stations would return an `ArgumentError` rather than a list.

`get-coords <address>` is a pure resolver: one address in, one point out.
Columns: `address`, `kind`, `locality`, `latitude`, `longitude`, `postalCode`.
Budget: 2 requests. It touches neither the region, nor the search context, nor
the radius.

The `address` it returns is Avito's own `normalizedAddress`, not what was passed in.

## How it works

Three undocumented directories, all read-only through the browser context:

- `/web/1/slocations` — name suggestions, `{id, names["1"]}`;
- `/web/1/search/locations?locationId=<id>` — the location's capabilities
  (`hasMetro`, `hasDistricts`) and the visible list of `smallRadius` kilometres;
- `/web/2/locations/{metro,districts}?locationId=<id>` — the ID lists themselves.

`--geo` requires exactly one exact name match among the suggestions and is only
available if the fresh location configuration reports the corresponding
capability: for a city with no metro, `--geo metro` returns an `ArgumentError`
rather than an empty list. A truncated slice is never passed off as a complete
directory: if `--geo-query` leaves more rows than `--limit`, the command returns
an `ArgumentError` stating the actual count.

`get-coords` calls `/web/1/coords/by_address?address=<string>` in one request,
with no suggest, no `jwt`, no `categoryId`, no `locationId`. An address that
cannot be found is an `EmptyResultError` (exit 66), not a fall back to the city
centre.

## Facts

- **F-014 — there is no stable marker of location type.** `/web/1/slocations`
  mixes settlements, regions and aggregates: the query `Тверь` yields `Тверь`,
  `Тверская область` and `Все регионы`; `Москва` yields the city, the
  city-plus-region, the region and `Новая Москва`. The `parent` field is not
  always present, and `suggestType=history` describes selection history rather
  than a type. So Avito's answers cannot be heuristically discarded as "not
  settlements".
- **F-037 — geo reduces to stable IDs, and Avito validates none of them.** Four
  confirmed traps: an unknown `metro=999999` returns `200` with an empty
  `metroId`; a station from another city is accepted even where there is no metro
  at all; `metro` and `district` are accepted together even though they are tabs
  of one filter in the UI; `radius` without `geoCoords` is silently ignored
  (`searchRadius: null`). None of these mistakes is reported, so all validation
  lives on our side.
- **Directory scale differs by orders of magnitude:** Kazan has 11 stations and 7
  districts, Moscow 357 stations across 19 lines and 147 districts across 12
  okrugs. No global list exists, so the command must group and bound.
- **A city cannot be applied by editing a URL.** `?locationId=650400` on
  `/moskva/telefony` is silently ignored, the pathname wins, and
  `searchCore.locationId` does not change. No confirmed endpoint hands over a
  region slug. The only working path is the items API, and the same call applies
  the city together with the stations.
- **F-045 — coordinates come from a separate endpoint, and it silently amends the
  address.** The suggest carries no coordinates at all (`{jwt, kind, subtitle,
  title}`, where `jwt` is the address string again), and picking a suggestion
  produces no request. Two confirmed silent amendments: `Москва, Тверская улица,
  1` comes back as house `3`, with the requested house nowhere in the response;
  `Тверская улица, 6` exists in at least four cities and resolves to the Moscow
  one with no marker of ambiguity. Hence the contract: the command returns the
  point together with `normalizedAddress`, `kind` and `locality` so the caller
  sees Avito's decision **before** searching, and `search` accepts only a ready
  pair of coordinates.
- **A neighbouring endpoint is excluded:** `/js/v2/geo/position` maps an address
  to `locationId` plus metro and district in one call, but it is a write request
  against the session (GET answers `405`), so it is not taken into a read-only
  contract.

## Risks

- Three endpoints are undocumented; their shape is treated as internal-unstable
  and checked fail-closed. A change of response shape is an execution error, not
  a degradation.
- `searchCore.activeTab` is not proof that a mode was applied: `smallRadius`
  arrives even on a request with no geo parameters at all. The postconditions are
  `searchCore.metroId` / `districtId` / `geoCoords` / `searchRadius` by exact
  equality, and nothing else.
- Validation of geo IDs against the target location's fresh directory must not be
  weakened under any circumstances: Avito's silent pass makes a caller's mistake
  indistinguishable from a correct request.
