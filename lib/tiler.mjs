// Polygon features to 0.1 degree tiles. Every tile holds, per layer, each feature's rings
// clipped to the tile expanded by BUFFER_DEG, so one tile answers any question about a point in
// it that reaches no further than the margin (reader.mjs `withinMargin`).

import { TILE_DEG, BUFFER_DEG } from '../reader.mjs'
import { clipRing, bboxOf, simplifyRing } from './geom.mjs'

const fl = (x) => Math.floor(x / TILE_DEG + 1e-9)

/** Tile ids whose margin-expanded box meets [s, w, n, e], inside `scope` when given. */
export function tilesTouching([s, w, n, e], scope) {
  const out = []
  let i0 = fl(s - BUFFER_DEG), i1 = fl(n + BUFFER_DEG)
  let j0 = fl(w - BUFFER_DEG), j1 = fl(e + BUFFER_DEG)
  if (scope) {
    // Integer tile indices, so a scope edge on a tile edge never admits the neighbour by rounding.
    i0 = Math.max(i0, fl(scope[0]))
    i1 = Math.min(i1, Math.ceil(scope[2] / TILE_DEG - 1e-9) - 1)
    j0 = Math.max(j0, fl(scope[1]))
    j1 = Math.min(j1, Math.ceil(scope[3] / TILE_DEG - 1e-9) - 1)
  }
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(`${i}_${j}`)
  return out
}

export function marginBox(id) {
  const [i, j] = id.split('_').map(Number)
  return [i * TILE_DEG - BUFFER_DEG, j * TILE_DEG - BUFFER_DEG, (i + 1) * TILE_DEG + BUFFER_DEG, (j + 1) * TILE_DEG + BUFFER_DEG]
}

/** Keep only the listed attributes, in that order, with null for a missing one. */
export function pickAttrs(attrs, fields) {
  const out = {}
  for (const f of fields) out[f] = attrs?.[f] ?? null
  return out
}

/** ArcGIS features (f=json, outSR 4326) to simplified { i, a, r } records; empty or broken geometry dropped. */
export function normalise(features, src) {
  const out = []
  for (const f of features) {
    const rings = (f.geometry?.rings ?? [])
      .filter((r) => Array.isArray(r) && r.length >= 4)
      .map((r) => simplifyRing(r, src.simplifyDeg))
      .filter((r) => r.length >= 4)
    if (!rings.length) continue
    const id = f.attributes?.[src.oid ?? 'OBJECTID'] ?? out.length
    out.push({ i: id, a: pickAttrs(f.attributes, src.fields), r: rings })
  }
  out.sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0))
  return out
}

/** Records to Map<tileId, records clipped to that tile's margin box>. */
export function tileLayer(records, scope) {
  const tiles = new Map()
  for (const rec of records) {
    for (const id of tilesTouching(bboxOf(rec.r), scope)) {
      const box = marginBox(id)
      const rings = rec.r.map((r) => clipRing(r, box)).filter((r) => r.length)
      if (!rings.length) continue
      if (!tiles.has(id)) tiles.set(id, [])
      tiles.get(id).push({ i: rec.i, a: rec.a, r: rings })
    }
  }
  return tiles
}
