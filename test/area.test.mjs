// OPS-087 (2026-10-23): the area measure no longer depends on where a polygon's vertices are,
// and tile clipping keeps long thin polygons (the Coastal Zone deferral was the measure, not the clip).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polygonAreaKm2, polygonAreaKm2MeanLat } from '../lib/geom.mjs'
import { tileLayer, normalise } from '../lib/tiler.mjs'
import { pointInRings, tileKey } from '../reader.mjs'

const R = 6371008.8, RAD = Math.PI / 180
// A long, thin strip along a meridian from 32.5 to 42 degrees: 1,000 vertices on its southern
// half, 10 on its northern half (as a detailed coastline next to a straight survey line).
function strip(lng, w, dense = true) {
  const east = [], west = []
  const lats = []
  if (dense) for (let i = 0; i <= 1000; i++) lats.push(32.5 + (4.75 * i) / 1000)
  else lats.push(32.5, 37.25)
  for (let i = 1; i <= 10; i++) lats.push(37.25 + (4.75 * i) / 10)
  for (const y of lats) east.push([lng + w, y])
  for (const y of [...lats].reverse()) west.push([lng, y])
  const ring = [...east, ...west]
  ring.push(ring[0])
  return ring
}

test('area on the sphere: a band of latitude matches the closed form', () => {
  const ring = [[-120, 34], [-119, 34], [-119, 34.1], [-120, 34.1], [-120, 34]]
  const exact = R * R * (1 * RAD) * (Math.sin(34.1 * RAD) - Math.sin(34 * RAD)) / 1e6
  assert.ok(Math.abs(polygonAreaKm2([ring]) / exact - 1) < 2e-4, `${polygonAreaKm2([ring])} vs ${exact}`)
})

test('dropping collinear vertices leaves the area unchanged (the old mean-latitude measure moved)', () => {
  const dense = strip(-120, 0.02, true), sparse = strip(-120, 0.02, false)
  const a = polygonAreaKm2([dense]), b = polygonAreaKm2([sparse])
  assert.ok(Math.abs(b / a - 1) < 1e-6, `spherical moved ${(b / a - 1) * 100}%`)
  const c = polygonAreaKm2MeanLat([dense]), d = polygonAreaKm2MeanLat([sparse])
  assert.ok(Math.abs(d / c - 1) > 0.005, `the old measure moved only ${(d / c - 1) * 100}%; the regression this guards is gone`)
})

test('a long thin polygon tiled across many cells answers every inside point (clipping keeps it)', () => {
  const ring = strip(-120, 0.02, true)
  const recs = normalise([{ attributes: { OBJECTID: 1, FLD_ZONE: 'AE' }, geometry: { rings: [ring] } }], { fields: ['FLD_ZONE'], simplifyDeg: 0.000005 })
  const tiles = tileLayer(recs, [32.4, -124.5, 42.1, -114.1])
  assert.ok(tiles.size >= 95, `${tiles.size} tiles`)
  let inside = 0
  for (let k = 0; k <= 200; k++) {
    const lat = 32.51 + (9.48 * k) / 200
    for (const lng of [-119.995, -119.99, -119.985]) {
      const pieces = tiles.get(tileKey(lat, lng)) ?? []
      assert.ok(pieces.some((p) => pointInRings(lng, lat, p.r)), `lost at ${lat}, ${lng}`)
      inside++
    }
    const out = tiles.get(tileKey(lat, -119.97)) ?? []
    assert.ok(!out.some((p) => pointInRings(-119.97, lat, p.r)), `invented at ${lat}, -119.97`)
  }
  assert.equal(inside, 603)
})
