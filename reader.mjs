// cce-hazard-tables reader. Self-contained (no imports), so the app can vendor this one file.
//
// It answers the hazard questions the app sends to state and federal ArcGIS layers today, from
// the nightly California tiles, in the SAME feature shape ArcGIS returns
// (`{ attributes, geometry: { rings } }`, rings as [lng, lat] in WGS84). The app keeps every
// line of its own parsing (parseSeismic, parseCoastal, parseHabitat, the fire, fault and airport
// readings in hazards.ts), so the answers it builds are unchanged; only the source of the
// features moves:
//
//   intersects(layer, lat, lng)                 a point query (esriSpatialRelIntersects, point)
//   intersects(layer, lat, lng, { rings })      the same with the parcel outline as the geometry
//   nearby(layer, lat, lng, meters)             a point plus `distance` query; geometry returned
//
// Each resolves to { features, vintage, tile }. `vintage` carries the layer's own date as the
// agency last edited it (`published`) and the night CCE last confirmed that date (`checked`).
//
// WHEN IT REFUSES (throws, so the caller asks the live service instead; never an empty answer):
//   - no base URL or loader is configured,
//   - the tile for the site is not in the manifest (nothing was built there),
//   - the layer is not in the manifest, or the manifest was last checked more than `maxAgeDays` ago,
//   - the question reaches past the tile's margin (a very large parcel or radius),
//   - any HTTP failure other than a clean answer.
// An empty `features` list therefore always means "the layer has no feature there", which is
// what the live service's empty answer means.

export const SCHEMA = 1
export const TILE_DEG = 0.1
/** Every tile carries the polygons within this many degrees of its edges (about 2.2 to 2.8 km). */
export const BUFFER_DEG = 0.025
/** Where the lead publishes the data branch. The app keeps the tables OFF until a base URL is named. */
export const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/centralcoasteconomics/cce-hazard-tables/data'
/** A manifest not re-checked for this many days is refused (the nightly job re-checks every night). */
export const DEFAULT_MAX_AGE_DAYS = 14

const EARTH_M = 6371008.8
const RAD = Math.PI / 180

/**
 * The layers, by the key the reader is asked for. `source` is the name a fact cites; a `whole`
 * layer is one small file read whole and queried by distance; the rest are tiled.
 */
export const LAYERS = {
  liquefaction: { source: 'California Geological Survey, Seismic Hazard Zones (liquefaction)', license: 'California public record' },
  landslide: { source: 'California Geological Survey, Seismic Hazard Zones (earthquake-induced landslide)', license: 'California public record' },
  unevaluated: { source: 'California Geological Survey, Seismic Hazard Zones (areas not evaluated)', license: 'California public record' },
  faultZones: { source: 'California Geological Survey, Alquist-Priolo Earthquake Fault Zones', license: 'California public record' },
  coastalZone: { source: 'California Coastal Commission, Coastal Zone polygon', license: 'California public record' },
  fhszSra: { source: 'CAL FIRE Fire Hazard Severity Zones, State Responsibility Area (2023)', license: 'California public record' },
  fhszLra: { source: 'CAL FIRE Fire Hazard Severity Zones, Local Responsibility Area (map of March 24, 2025)', license: 'California public record' },
  criticalHabitat: { source: 'U.S. Fish and Wildlife Service, Critical Habitat (final designations)', license: 'U.S. Government work, public domain' },
  airports: { source: 'Caltrans Division of Aeronautics, Airport Boundaries', license: 'California public record', whole: true }
}

export class HazardTableRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'HazardTableRefusal'
  }
}

/** Tile id for a point: integer tenths of a degree, "<floor(lat*10)>_<floor(lng*10)>". */
export function tileKey(lat, lng) {
  return `${Math.floor(lat / TILE_DEG + 1e-9)}_${Math.floor(lng / TILE_DEG + 1e-9)}`
}

/** [south, west, north, east] of a tile id. */
export function tileBounds(id) {
  const [i, j] = id.split('_').map(Number)
  return [i * TILE_DEG, j * TILE_DEG, (i + 1) * TILE_DEG, (j + 1) * TILE_DEG]
}

// ---- geometry (degrees in, metres out; a local flat projection is exact enough at these scales) ----

/** Even-odd point in polygon over every ring (outer rings and holes alike), [lng, lat] rings. */
export function pointInRings(lng, lat, rings) {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

function proj(lat0) {
  const kx = Math.cos(lat0 * RAD) * RAD * EARTH_M
  const ky = RAD * EARTH_M
  return (p) => [p[0] * kx, p[1] * ky]
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
  const x = ax + t * dx - px, y = ay + t * dy - py
  return Math.sqrt(x * x + y * y)
}

/** Metres from a point to a polygon: 0 inside, else to the nearest edge. */
export function distanceToRings(lat, lng, rings) {
  if (pointInRings(lng, lat, rings)) return 0
  const P = proj(lat)
  const [px, py] = P([lng, lat])
  let best = Infinity
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = P(ring[i - 1])
      const [bx, by] = P(ring[i])
      const d = segDist(px, py, ax, ay, bx, by)
      if (d < best) best = d
    }
  }
  return best
}

function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}
function segmentsCross(a, b, c, d) {
  const d1 = cross(c[0], c[1], d[0], d[1], a[0], a[1])
  const d2 = cross(c[0], c[1], d[0], d[1], b[0], b[1])
  const d3 = cross(a[0], a[1], b[0], b[1], c[0], c[1])
  const d4 = cross(a[0], a[1], b[0], b[1], d[0], d[1])
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** [south, west, north, east] of a set of [lng, lat] rings. */
export function ringsBBox(rings) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  for (const r of rings) {
    for (const [x, y] of r) {
      if (y < s) s = y
      if (y > n) n = y
      if (x < w) w = x
      if (x > e) e = x
    }
  }
  return [s, w, n, e]
}

const boxesTouch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/** Do two polygons share any area (the ArcGIS "intersects" test for a polygon on a polygon)? */
export function ringsIntersect(a, b) {
  if (!boxesTouch(ringsBBox(a), ringsBBox(b))) return false
  for (const r of a) for (const p of r) if (pointInRings(p[0], p[1], b)) return true
  for (const r of b) for (const p of r) if (pointInRings(p[0], p[1], a)) return true
  for (const ra of a) {
    for (let i = 1; i < ra.length; i++) {
      for (const rb of b) for (let j = 1; j < rb.length; j++) if (segmentsCross(ra[i - 1], ra[i], rb[j - 1], rb[j])) return true
    }
  }
  return false
}

export function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** How far (metres) a parcel outline reaches from the site point. */
export function reachMeters(lat, lng, rings) {
  if (!rings?.length) return 0
  let best = 0
  for (const r of rings) for (const [x, y] of r) best = Math.max(best, haversineM(lat, lng, y, x))
  return best
}

/** Is a circle of `meters` around the point inside the tile plus its margin (with 5% to spare)? */
export function withinMargin(id, lat, lng, meters) {
  const [s, w, n, e] = tileBounds(id)
  const dLat = ((meters * 1.05) / EARTH_M) / RAD
  const dLng = dLat / Math.max(0.01, Math.cos(lat * RAD))
  return lat - dLat >= s - BUFFER_DEG && lat + dLat <= n + BUFFER_DEG && lng - dLng >= w - BUFFER_DEG && lng + dLng <= e + BUFFER_DEG
}

const isoOf = (v) => (v == null ? null : typeof v === 'number' ? new Date(v).toISOString() : String(v))

async function gunzipToText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // gzip magic 1f 8b; a server (or a disk read) may hand over the plain body already.
  if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return new TextDecoder().decode(u8)
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  }
  const { gunzipSync } = await import('node:zlib')
  return gunzipSync(u8).toString('utf8')
}

/** One piece per source feature id (a tile holds one piece per feature; this is a guard). */
function dedupe(pieces) {
  const seen = new Set()
  return pieces.filter((p) => {
    if (p.i == null) return true
    if (seen.has(p.i)) return false
    seen.add(p.i)
    return true
  })
}

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch, loadFile?: (path: string) => Promise<Uint8Array|null>, cacheTiles?: number, maxAgeDays?: number, now?: () => number }} opts
 *   `loadFile(path)` reads "manifest.json", "tiles/<id>.json.gz" or "whole/<layer>.json.gz" from
 *   R2, KV or disk instead of HTTP; null means not found.
 */
export function createReader(opts = {}) {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '')
  const doFetch = opts.fetch ?? ((...a) => fetch(...a))
  const cacheMax = opts.cacheTiles ?? 32
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const now = opts.now ?? (() => Date.now())
  const cache = new Map()
  let manifestP = null

  async function read(path) {
    if (opts.loadFile) return opts.loadFile(path)
    if (!baseUrl) throw new HazardTableRefusal('no hazard table base URL is configured')
    const res = await doFetch(`${baseUrl}/${path}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`hazard tables: HTTP ${res.status} for ${path}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async function manifest() {
    if (!manifestP) {
      const p = (async () => {
        const b = await read('manifest.json')
        if (!b) throw new HazardTableRefusal('the hazard tables have no manifest')
        const m = JSON.parse(await gunzipToText(b))
        if (m.schema !== SCHEMA) throw new HazardTableRefusal(`hazard tables schema ${m.schema}; this reader reads ${SCHEMA}`)
        return m
      })()
      manifestP = p
      p.catch(() => { if (manifestP === p) manifestP = null })
    }
    const m = await manifestP
    const age = (now() - Date.parse(m.checkedAt ?? m.generatedAt)) / 86400000
    if (!(age <= maxAgeDays)) throw new HazardTableRefusal(`the hazard tables were last checked ${Math.round(age)} days ago (limit ${maxAgeDays})`)
    return m
  }

  async function cached(path) {
    if (cache.has(path)) {
      const v = cache.get(path)
      cache.delete(path)
      cache.set(path, v)
      return v
    }
    const p = (async () => {
      const b = await read(path)
      return b ? JSON.parse(await gunzipToText(b)) : null
    })()
    cache.set(path, p)
    p.catch(() => cache.delete(path))
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value)
    return p
  }

  function vintageOf(m, layer) {
    const L = m.layers?.[layer]
    if (!L || typeof L.featureCount !== 'number') throw new HazardTableRefusal(`layer ${layer} is not in the hazard tables`)
    return {
      layer,
      source: LAYERS[layer]?.source ?? layer,
      published: isoOf(L.lastEditDate),
      checked: isoOf(L.checkedAt ?? m.checkedAt ?? m.generatedAt),
      built: isoOf(L.builtAt ?? m.generatedAt),
      held: !!m.held?.[layer]
    }
  }

  async function piecesFor(layer, lat, lng, reach) {
    if (!LAYERS[layer]) throw new HazardTableRefusal(`unknown hazard layer ${layer}`)
    const m = await manifest()
    const vintage = vintageOf(m, layer)
    if (LAYERS[layer].whole) {
      const body = await cached(`whole/${layer}.json.gz`)
      if (!body) throw new HazardTableRefusal(`the ${layer} file is missing`)
      return { pieces: body.features ?? [], vintage, tile: `whole/${layer}` }
    }
    const id = tileKey(lat, lng)
    if (!m.tiles?.[id]) throw new HazardTableRefusal(`no hazard tile was built for ${id}`)
    if (!withinMargin(id, lat, lng, reach)) throw new HazardTableRefusal(`the question reaches ${Math.round(reach)} m, past the margin of tile ${id}`)
    const body = await cached(`tiles/${id}.json.gz`)
    if (!body) throw new HazardTableRefusal(`tile ${id} is listed but missing`)
    return { pieces: body.layers?.[layer] ?? [], vintage, tile: id }
  }

  const asFeature = (p) => ({ attributes: { ...p.a }, geometry: { rings: p.r } })

  return {
    manifest,
    /** Features whose polygon contains the point, or meets the parcel outline when `rings` is given. */
    async intersects(layer, lat, lng, q = {}) {
      const rings = q.rings?.length ? q.rings : null
      const { pieces, vintage, tile } = await piecesFor(layer, lat, lng, reachMeters(lat, lng, rings))
      const hit = pieces.filter((p) => (rings ? ringsIntersect(rings, p.r) : pointInRings(lng, lat, p.r)))
      return { features: dedupe(hit).map(asFeature), vintage, tile }
    },
    /** Features within `meters` of the point (the live `distance` query), with geometry. */
    async nearby(layer, lat, lng, meters) {
      const { pieces, vintage, tile } = await piecesFor(layer, lat, lng, meters)
      const hit = pieces.filter((p) => distanceToRings(lat, lng, p.r) <= meters)
      return { features: dedupe(hit).map(asFeature), vintage, tile }
    }
  }
}

/** The source string a fact cites for a layer read from the tables. Never "live" or "current". */
export function sourceLabel(vintage) {
  const d = (v) => (v ? String(v).slice(0, 10) : 'unknown date')
  return `${vintage.source}, as published ${d(vintage.published)} (CCE copy checked ${d(vintage.checked)})`
}
