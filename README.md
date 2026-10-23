# cce-hazard-tables

Nightly California copy of the rarely changing state and federal hazard polygons Site Due
Diligence (Central Coast Economics) queries live today, published as 0.1 degree gzip JSON tiles
with a reader that answers in ArcGIS's own feature shape, so the app swaps the source and keeps
every parser. Design: section 3.3 of `~/Developer/CCE_DATA_IN_HOUSE_PLAN_2026-10-23.md`
(OPS-084). Pattern: `cce-amenity-tables`.

## Layers

| Key | Source (probed 2026-10-23) | Fields kept (= the app's outFields) | App question it replaces |
|---|---|---|---|
| `liquefaction`, `landslide` | CGS Seismic Hazard Zones | QUAD_NAME, RELEASED, REVISED | siteRisk.ts seismic (parcel polygon intersects) |
| `unevaluated` | CGS SHZ Unevaluated Areas | QUAD_NAME, LABEL | siteRisk.ts seismic (point) |
| `faultZones` | CGS Alquist-Priolo Fault Zones | QUAD_NAME, ZN_RELEASED, ZN_REVISED | hazards.ts fault (point) |
| `coastalZone` | Coastal Commission Coastal Zone polygon | FID | siteRisk.ts coastal (parcel intersects) |
| `fhszSra` | CAL FIRE FHSZ SRA 2023 | SRA, FHSZ, FHSZ_Description | hazards.ts fire (point) |
| `fhszLra` | CAL FIRE FHSZ LRA, map of 2025-03-24 (new coverage) | SRA, FHSZ, FHSZ_Description | hazards.ts fire; closes "verify LRA zones" (SDD-269) |
| `criticalHabitat` | USFWS final critical habitat (designations reaching the CA box) | comname, sciname, status, listing_status, unitname, subunitname, fedreg | siteRisk.ts habitat (distance 1/2 mi + parcel reach) |
| `airports` (whole file) | Caltrans Airport Boundaries | FACILITY | hazards.ts airport (distance 3,200 m) |

Licenses and the citation the app must print: `ATTRIBUTION.md`. All are public records or US
Government works; each keeps its "official map governs" disclaimer.

Not included (yet): Caltrans HQTA and USDA rural areas (plan 3.3 lists them; add to
`lib/layers.mjs` with golden probes), freeway lines (phase 2).

## Files on the data branch

- `tiles/<floor(lat*10)>_<floor(lng*10)>.json.gz`: `{ schema, tile, layers: { <layer>: [{ i, a, r }] } }`,
  each polygon clipped to the tile expanded by a 0.025 degree margin (about 2.2 to 2.8 km), so
  one tile answers any question about a point in it that reaches no further than the margin.
  `i` source object id, `a` attributes, `r` rings `[lng, lat]`, 6 decimals.
- `whole/airports.json.gz`: the 221 airport polygons, read whole.
- `manifest.json`: `generatedAt` (last content change), `checkedAt` (last nightly check),
  `scope`, per layer `lastEditDate` (the agency's own), `checkedAt`, `builtAt`, `featureCount`,
  `areaKm2`, `sha256`, license and attribution; `held`; `golden`; `tiles` (id to bytes).
  A tile not listed was never built, and the reader refuses it rather than answer "none".

## Reader

`reader.mjs` is self-contained (Workers and Node 20+), typed by `reader.d.ts`. The app vendors
it as `src/main/connectors/hazardTables.mjs`.

```js
const tables = createReader({ baseUrl })            // or { loadFile } for R2, KV or disk
await tables.intersects('liquefaction', lat, lng, { rings })   // parcel outline optional
await tables.nearby('criticalHabitat', lat, lng, meters)
// -> { features: [{ attributes, geometry: { rings } }], vintage: { published, checked, ... }, tile }
```

It REFUSES (throws) when the tile was not built, the layer is missing, the manifest was not
re-checked in 14 days, or the question reaches past the tile margin; the app then asks the live
service. An empty `features` list means what the live service's empty answer means.

## Pipeline and guards

`.github/workflows/nightly.yml`, 09:23 UTC (before the app's 10:17 UTC source check), plus manual
dispatch (with a "force" input).

1. `npm test` (unit tests and an end-to-end build of one Venice tile from recorded answers).
2. Clone the published `data` branch into `prev/`.
3. `node build.mjs --prev prev --out out`: one metadata call per layer. A layer whose agency edit
   date did not move is carried from `prev/` without downloading (airports, which publish no edit
   date, are downloaded and compared by hash). A layer that moved, or has no previous copy, or was
   last built over 30 days ago, is downloaded (paged Esri JSON in WGS84, a margin past the scope),
   simplified (Douglas-Peucker 0.000005 degrees, about 0.5 m; habitat about 1 m) and tiled.
4. Guards (`lib/guards.mjs`), any of which HOLDS the layer and carries its previous copy:
   statewide floor on the first night; count under 98% of the published one (90% with a newer
   agency edit date); area moved over 2% (10% with a newer date); download count different from
   the server's own count; simplification moving area over 0.5%; a field the app reads gone
   (schema drift); an older agency date; any golden probe flipping (`golden.json`, 22 points
   probed live 2026-10-23: Venice liquefaction and Coastal Zone, Fresno unevaluated, downtown
   Oakland in neither, Topanga landslide and SRA Very High, Paradise LRA Very High, Berkeley
   stadium in the Hayward fault zone, Coal Oil Point snowy plover habitat, SFO and LAX).
   A source that fails to answer keeps its previous tiles and turns the run red only after 3
   nights in a row or more than half of 14 (flapping rule). A held layer with no previous copy
   holds the whole run and nothing is published.
5. status `publish` (a layer rebuilt) or `checked` (only the check date moved): `out/` replaces
   the data branch as one amended commit (only changed files travel). `record.mjs` commits
   `state/published.json` (the guard baseline) and `state/history.json` to main.

## Size

Measured on the Venice tile: 9 layers, 59 KB gzip for one tile with 77 landslide polygons.
Statewide estimate from the plan's section 1.3: about 80 to 120 MB gzip across about 4,000
tiles, the landslide layer dominating; most tiles 5 to 500 KB. The first real run's manifest
gives the actual figure. Do not build the state on the 8 GB Mac.

## Local development

```sh
npm test
node build.mjs --scope 33.9,-118.5,34.0,-118.4 --out .work/out --published .work/none.json --history .work/none.json
node scripts/record-fixture.mjs --scope 33.9,-118.5,34.0,-118.4   # re-record the test fixture (tiny areas only)
```

Live parity, 2026-10-23: 16 points across the Venice tile by 7 polygon layers, 112 of 112
answers equal to the live services; habitat and airport distance questions equal too.

## Publishing (for the lead)

1. Review the files, then create the repo and push:
   ```sh
   cd ~/Developer/cce-hazard-tables
   git init -b main && git add -A && git commit -m "cce-hazard-tables: nightly California hazard tiles, reader, guards, golden probes"
   gh repo create centralcoasteconomics/cce-hazard-tables --public --description "Nightly California hazard polygons for Site Due Diligence"
   git remote add origin https://github.com/centralcoasteconomics/cce-hazard-tables.git
   git config credential.helper '' && git config --add credential.helper '!gh auth git-credential'   # primer trap #4
   git push -u origin main
   ```
2. Settings, Actions, General: Workflow permissions "Read and write".
3. `gh workflow run nightly-hazard-tiles -R centralcoasteconomics/cce-hazard-tables`, then
   `gh run watch`. The first run downloads every layer (landslide is the long one).
4. Check `https://raw.githubusercontent.com/centralcoasteconomics/cce-hazard-tables/data/manifest.json`
   (every golden probe ok, counts near the plan's figures) and one tile, for example `tiles/339_-1185.json.gz`.
5. Turn the app on: set the `hazard_table_url` setting (or `CCE_HAZARD_TABLE_URL`) to
   `https://raw.githubusercontent.com/centralcoasteconomics/cce-hazard-tables/data`. The value
   `off` turns it off again. No deploy needed for the setting.
