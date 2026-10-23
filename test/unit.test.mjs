import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { clipRing, simplifyRing, polygonAreaKm2, ringSignedArea } from '../lib/geom.mjs'
import { tileLayer, tilesTouching, normalise } from '../lib/tiler.mjs'
import { checkLayer, flapIsRed, goldenProbe } from '../lib/guards.mjs'
import { createReader, tileKey, tileBounds, pointInRings, distanceToRings, ringsIntersect, withinMargin, sourceLabel, HazardTableRefusal, SCHEMA } from '../reader.mjs'

// A concave "C" shape spanning two tiles (lng -118.52 to -118.38, lat 33.92 to 33.98).
const C = [[-118.52, 33.92], [-118.38, 33.92], [-118.38, 33.94], [-118.48, 33.94], [-118.48, 33.96], [-118.38, 33.96], [-118.38, 33.98], [-118.52, 33.98], [-118.52, 33.92]]

test('tile ids and bounds', () => {
  assert.equal(tileKey(33.985, -118.4695), '339_-1185')
  assert.deepEqual(tileBounds('339_-1185').map((x) => Math.round(x * 10) / 10), [33.9, -118.5, 34, -118.4])
  assert.equal(tileKey(34.0, -118.4), '340_-1184')
})

test('clipping keeps every answer inside the box exact, even for a concave ring', () => {
  const box = [33.9, -118.5, 34.0, -118.4]
  const clipped = clipRing(C, box)
  assert.ok(clipped.length >= 4)
  let checked = 0
  for (let i = 0; i < 400; i++) {
    const lat = 33.9 + ((i * 7919) % 1000) / 10000
    const lng = -118.5 + ((i * 104729) % 1000) / 10000
    assert.equal(pointInRings(lng, lat, [clipped]), pointInRings(lng, lat, [C]), `${lat},${lng}`)
    checked++
  }
  assert.equal(checked, 400)
  assert.deepEqual(clipRing(C, [35, -118, 35.1, -117.9]), [], 'a ring wholly outside the box clips to nothing')
})

test('simplification is conservative: closed ring, area within 0.5%, no vertex moves past the tolerance', () => {
  const ring = []
  for (let k = 0; k <= 360; k++) {
    const t = (k * Math.PI) / 180
    ring.push([-118.45 + 0.01 * Math.cos(t) + (k % 2 ? 0.0000001 : 0), 33.95 + 0.01 * Math.sin(t)])
  }
  ring[ring.length - 1] = [...ring[0]]
  const s = simplifyRing(ring, 0.000005)
  assert.deepEqual(s[0], s[s.length - 1])
  assert.ok(s.length < ring.length, 'drops near-collinear vertices')
  assert.ok(Math.abs(polygonAreaKm2([s]) / polygonAreaKm2([ring]) - 1) < 0.005)
})

test('a polygon is stored in every tile its margin box reaches, and answers the same from each', () => {
  const recs = normalise([{ attributes: { OBJECTID: 7, QUAD_NAME: 'Venice' }, geometry: { rings: [C] } }], { fields: ['QUAD_NAME'], simplifyDeg: 0 })
  const tiles = tileLayer(recs, null)
  assert.ok(tiles.has('339_-1185') && tiles.has('339_-1184'))
  for (const [id, pieces] of tiles) {
    const [s, w, n, e] = tileBounds(id)
    for (let k = 0; k < 50; k++) {
      const lat = s + ((k * 37) % 100) / 1000, lng = w + ((k * 61) % 100) / 1000
      if (lat > n || lng > e) continue
      assert.equal(pointInRings(lng, lat, pieces[0].r), pointInRings(lng, lat, [C]))
    }
  }
  assert.deepEqual(tilesTouching([33.95, -118.45, 33.95, -118.45], [33.9, -118.5, 34.0, -118.4]), ['339_-1185'], 'scope edges are integer tile edges')
})

test('geometry: distance, intersects, margin', () => {
  const sq = [[[-118.46, 33.94], [-118.44, 33.94], [-118.44, 33.96], [-118.46, 33.96], [-118.46, 33.94]]]
  assert.equal(distanceToRings(33.95, -118.45, sq), 0)
  const d = distanceToRings(33.95, -118.43, sq)
  assert.ok(d > 900 && d < 940, `about 925 m east, got ${d}`)
  const parcel = [[[-118.4405, 33.949], [-118.4395, 33.949], [-118.4395, 33.951], [-118.4405, 33.951], [-118.4405, 33.949]]]
  assert.equal(ringsIntersect(parcel, sq), true, 'a parcel straddling the edge intersects')
  const away = [[[-118.43, 33.949], [-118.42, 33.949], [-118.42, 33.951], [-118.43, 33.951], [-118.43, 33.949]]]
  assert.equal(ringsIntersect(away, sq), false)
  assert.equal(withinMargin('339_-1185', 33.95, -118.45, 1000), true)
  assert.equal(withinMargin('339_-1185', 33.95, -118.45, 9000), false, 'a 9 km question reaches past a 2.5 km margin')
})

test('guards: collapse, area, schema, vintage, incomplete download, statewide floor', () => {
  const prev = { lastEditDate: 1000, featureCount: 1000, areaKm2: 500 }
  const ok = { lastEditDate: 1000, featureCount: 999, sourceCount: 999, areaKm2: 500, rawAreaKm2: 500.1, missingFields: [] }
  assert.deepEqual(checkLayer(prev, ok).hold, [])
  assert.match(checkLayer(prev, { ...ok, featureCount: 950, sourceCount: 950 }).hold.join(), /COLLAPSED/)
  assert.deepEqual(checkLayer(prev, { ...ok, lastEditDate: 2000, featureCount: 950, sourceCount: 950, areaKm2: 480, rawAreaKm2: 480 }).hold, [], 'a newer edit date allows a real 5% change')
  assert.match(checkLayer(prev, { ...ok, lastEditDate: 2000, featureCount: 800, sourceCount: 800 }).hold.join(), /COLLAPSED/)
  assert.match(checkLayer(prev, { ...ok, areaKm2: 450, rawAreaKm2: 450 }).hold.join(), /area moved/)
  assert.match(checkLayer(prev, { ...ok, missingFields: ['QUAD_NAME'] }).hold.join(), /schema/)
  assert.match(checkLayer(prev, { ...ok, lastEditDate: 10 }).hold.join(), /backwards/)
  assert.match(checkLayer(prev, { ...ok, sourceCount: 1000 }).hold.join(), /incomplete download/)
  assert.match(checkLayer(prev, { ...ok, rawAreaKm2: 520 }).hold.join(), /simplification/)
  assert.match(checkLayer(null, { ...ok, featureCount: 5, sourceCount: 5 }, { minCount: 1900 }).hold.join(), /statewide floor/)
  assert.deepEqual(checkLayer(null, { ...ok, featureCount: 0, sourceCount: 0, areaKm2: 0, rawAreaKm2: 0 }).hold, [], 'a tiny area may hold none')
})

test('flapping source: red after 3 nights in a row or more than half of 14', () => {
  const h = (n, f) => Array.from({ length: n }, (_, i) => ({ downloadFailed: f(i) ? ['coastalZone'] : [] }))
  assert.equal(flapIsRed(h(13, () => false), 'coastalZone', true), false)
  assert.equal(flapIsRed(h(13, (i) => i >= 11), 'coastalZone', true), true)
  assert.equal(flapIsRed(h(13, (i) => i % 2 === 0), 'coastalZone', true), true)
  assert.equal(flapIsRed(h(13, (i) => i % 3 === 0), 'coastalZone', false), false)
})

function memoryReader(manifest, files, now = Date.parse('2026-10-23T12:00:00Z')) {
  return createReader({
    now: () => now,
    loadFile: async (p) => (p === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : files[p] ? gzipSync(JSON.stringify(files[p])) : null)
  })
}
const manifest = {
  schema: SCHEMA,
  generatedAt: '2026-10-22T10:00:00Z',
  checkedAt: '2026-10-23T10:00:00Z',
  layers: { liquefaction: { featureCount: 1, lastEditDate: 1763574392920, checkedAt: '2026-10-23T10:00:00Z' }, airports: { featureCount: 1, lastEditDate: null } },
  tiles: { '339_-1185': 100 }
}
const tileBody = { schema: SCHEMA, tile: '339_-1185', layers: { liquefaction: [{ i: 7, a: { QUAD_NAME: 'Venice', RELEASED: '1999-03-25', REVISED: 'N' }, r: [C] }] } }

test('reader: ArcGIS feature shape, vintage, and empty means none', async () => {
  const r = memoryReader(manifest, { 'tiles/339_-1185.json.gz': tileBody })
  const hit = await r.intersects('liquefaction', 33.93, -118.45)
  assert.equal(hit.features.length, 1)
  assert.deepEqual(hit.features[0].attributes, { QUAD_NAME: 'Venice', RELEASED: '1999-03-25', REVISED: 'N' })
  assert.ok(Array.isArray(hit.features[0].geometry.rings))
  assert.equal(hit.vintage.published.slice(0, 10), '2025-11-19')
  assert.equal(hit.vintage.checked.slice(0, 10), '2026-10-23')
  assert.match(sourceLabel(hit.vintage), /as published 2025-11-19 \(CCE copy checked 2026-10-23\)/)
  const miss = await r.intersects('liquefaction', 33.95, -118.45) // inside the C's notch
  assert.equal(miss.features.length, 0)
  const parcel = [[[-118.4705, 33.949], [-118.4695, 33.949], [-118.4695, 33.951], [-118.4705, 33.951], [-118.4705, 33.949]]]
  assert.equal((await r.intersects('liquefaction', 33.95, -118.47, { rings: parcel })).features.length, 0)
  assert.equal((await r.nearby('liquefaction', 33.95, -118.45, 2500)).features.length, 1)
})

test('reader refuses rather than answer empty (trap #26)', async () => {
  const r = memoryReader(manifest, { 'tiles/339_-1185.json.gz': tileBody })
  await assert.rejects(r.intersects('liquefaction', 36.7, -119.8), HazardTableRefusal, 'no tile built there')
  await assert.rejects(r.intersects('coastalZone', 33.93, -118.45), HazardTableRefusal, 'layer not in the manifest')
  await assert.rejects(r.nearby('liquefaction', 33.95, -118.45, 9000), HazardTableRefusal, 'past the margin')
  await assert.rejects(r.nearby('airports', 33.95, -118.45, 3200), HazardTableRefusal, 'whole file missing')
  const stale = memoryReader(manifest, { 'tiles/339_-1185.json.gz': tileBody }, Date.parse('2026-11-30T00:00:00Z'))
  await assert.rejects(stale.intersects('liquefaction', 33.93, -118.45), /last checked/)
  const http = createReader({ baseUrl: 'https://example.invalid/data', fetch: async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }) })
  await assert.rejects(http.intersects('liquefaction', 33.93, -118.45), /HTTP 503/)
  await assert.rejects(createReader({}).intersects('liquefaction', 33.93, -118.45), /no hazard table base URL/)
})

test('golden probe reports a flip', async () => {
  const r = memoryReader(manifest, { 'tiles/339_-1185.json.gz': tileBody })
  const res = await goldenProbe(r, [
    { label: 'in', layer: 'liquefaction', lat: 33.93, lng: -118.45, expect: true, field: 'QUAD_NAME', match: '^Venice$' },
    { label: 'wrong quad', layer: 'liquefaction', lat: 33.93, lng: -118.45, expect: true, field: 'QUAD_NAME', match: '^Inglewood$' },
    { label: 'out', layer: 'liquefaction', lat: 33.93, lng: -118.45, expect: false }
  ])
  assert.deepEqual(res.map((x) => x.ok), [true, false, false])
  assert.ok(ringSignedArea(C) !== 0)
})
