# FEMA flood zones in CCE's own copy (OPS-087)

Plan section 3.4 of `~/Developer/CCE_DATA_IN_HOUSE_PLAN_2026-10-23.md`, phase 3. Written
2026-10-23 with a one-county local proof. Nothing here is published or scheduled.

## 1. What the app does today (no snapshot)

- Live first: FEMA's NFHL service (layer 28), then the hosted republication when FEMA's host
  refuses the connection (it resets the TLS handshake for non-browser clients; still true from
  Node on 2026-10-23).
- When both fail, the last good answer: the flood fact from this account's own most recent
  screening of the same parcel (`src/shared/lastGood.ts`, at most 365 days old, never chained).
  Since OPS-087 every place the zone is printed says so in words:
  "FEMA NFHL as of 2026-10-09 (last good answer; the live service did not answer on this run)",
  with the zone marked "(earlier answer)" and the badge Preliminary (`src/shared/floodAnswer.ts`:
  report screen, HTML/PDF report, site risk score row, deal documents, application starter).
- No earlier answer: "not checked", never "not in a flood zone".

## 2. Does tile clipping lose flood zone polygons? No.

The Coastal Zone layer was deferred on 2026-10-23 because "tile clipping lost the long coastal
polygons". Re-examined here with the downloaded polygon: **clipping was not the cause**.

- `polygonAreaKm2` scaled the planar area by cos(mean latitude of the vertices). The Coastal
  Zone's largest feature spans 32.5 to 42 degrees; simplification drops vertices unevenly along
  the coast, the mean latitude shifts, and the measured area moved -0.818% (layer -0.708%, the
  "0.7%" in `state/history.json`) while the shape did not change (on the sphere: 0.000%).
- The simplification guard (0.5%) held the layer; a held layer with no previous copy is not
  written, so the golden probes then read nothing ("got []"), which looked like a clipping loss.
- The statewide tiles of the same polygon (all 7,000 cells) answer Venice and Topanga correctly.
- Fixed on this branch: `polygonAreaKm2` is now the spherical ring area (Chamberlain and Duquette),
  independent of vertex density; `test/area.test.mjs` keeps the regression and checks that a
  long thin strip tiled over 95 cells loses and invents no point. Coastal Zone stays deferred
  until one green statewide run with the fixed measure (the lead's call).

Flood zones, one county (Ventura County mainland, scope 34.0,-119.5 to 34.9,-118.6, the hosted
republication, 5,388 polygons, 1,005 km2), through this repo's own build and reader
(`node build.mjs --layers floodZones ...`, then `node scripts/nfhl-proof.mjs`):

| Check | Result |
|---|---|
| 4,000 random points, tiles vs point-in-polygon on the raw polygons | 4,000 of 4,000 equal (284 inside a zone) |
| The 25 longest polygons (river strips and coastal V zones, the longest about 85 km), 880 points inside them | 879 found, 1 within 1 m of an edge (simplification hairline), 0 lost |
| Simplification area change (limit 0.5%) | -0.0009% spherical (old measure -0.0025%) |
| 30 live point queries, the app's own question (point intersects, FLD_ZONE) | 29 equal; 1 differs on a polygon edge (1 cm: the live service counts the boundary as inside) |
| Size | 63 tiles, 7.64 MB gzip, median 49 KB, largest 596 KB |

So flood zones do not have that problem: the clipper keeps long polygons, and county-sized
features are far too short in latitude for the old measure to matter (and it is fixed anyway).

## 3. The snapshot (phase 3), proposed

- **Source.** FEMA's own data, not the republication: its edit date was 2026-03-11 when probed
  (seven months behind; FEMA revises the NFHL weekly through LOMRs), so it is fit for the proof
  and as the app's live fallback, not as the copy of record. FEMA publishes a statewide NFHL
  download for California (file geodatabase in a zip, from the Map Service Center). A runner can
  read it with GDAL (`ogr2ogr -f GeoJSONSeq` of `S_FLD_HAZ_AR`, `S_FIRM_PAN`, `S_LOMR`), which the
  Mac cannot do cheaply. Before committing: a HEAD request for the zip's size and date, and a
  check that the download host accepts non-browser clients (the service host does not).
- **Content.** `S_FLD_HAZ_AR` with the app's fields (FLD_ZONE, ZONE_SUBTY, SFHA_TF) plus
  DFIRM_ID; the FIRM panel effective date (`S_FIRM_PAN.EFF_DATE`, joined by panel) on each
  polygon or tile; `S_LOMR` (case number and effective date) as a "map revised here" note. Zone X
  minimal-hazard areas are in FEMA's file but not in the republication; either keep them (bigger)
  or drop them and keep today's meaning of "no zone mapped".
- **Tiles.** The same 0.1 degree cells and 0.025 degree margin (proved above), but a separate
  prefix (`flood/`) so the nine-layer site tile the app reads every run does not grow by 50 to
  600 KB. Statewide estimate from the proof: about 2,000 to 3,000 cells with flood polygons at
  50 to 150 KB, **about 150 to 400 MB gzip** (more with zone X kept). Measure on the first run.
- **Cadence and guards.** Weekly rebuild, daily metadata check. Count and area guards against the
  published copy, the simplification guard (now measured on the sphere), schema check, golden
  probes (`golden.json` has the two proof points, both answered the same live and from the
  tiles: zone AE at 34.26801, -118.93446 and zone VE at 34.03281, -118.87732; add one per region
  before the first statewide run).
- **App read order.** CCE copy (when checked within 14 days) then FEMA live, then the
  republication, then the last good answer. The label carries both dates:
  "FEMA NFHL, FIRM panel effective <panel date> (CCE copy of <check date>)". A copy older than its
  limit is refused, never shown as current.
- **Effort.** About 1 day for the pipeline and reader wiring, plus the size measurement. Not
  scheduled; `floodZones` is in `DEFERRED_LAYERS` and builds only with `--layers floodZones`.

## 4. Open for Ryan

1. Whether to keep zone X (minimal hazard) polygons in the copy.
2. Where the copy lives (this repo's data branch at 150 to 400 MB, or R2).
3. Re-enable the Coastal Zone after one green statewide run with the fixed area measure.
