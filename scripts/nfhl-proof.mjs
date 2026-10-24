#!/usr/bin/env node
// OPS-087 one-county proof for an in-house FEMA flood zone layer (NFHL_PLAN.md). Local only:
// nothing is published. It answers three questions on real data:
//   1. Does tile clipping lose or change flood zone polygons, long river strips included?
//      (every answer from the tiles against point-in-polygon on the raw downloaded polygons)
//   2. Do the tiles answer as the live service does? (a few dozen live point queries)
//   3. How big is it? (bytes per tile, scaled to the state)
//
//   node build.mjs --scope 34.0,-119.5,34.9,-118.6 --layers floodZones --out .work/nfhl --published .work/none.json --history .work/none.json --golden none --result .work/nfhl-result.json
//   node scripts/nfhl-proof.mjs --out .work/nfhl --scope 34.0,-119.5,34.9,-118.6 [--points 4000] [--live 30]

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createReader, pointInRings, BUFFER_DEG } from '../reader.mjs'
import { LAYER_SOURCES } from '../lib/layers.mjs'
import { layerFeatures } from '../lib/arcgis.mjs'
import { polygonAreaKm2, polygonAreaKm2MeanLat, simplifyRing, bboxOf } from '../lib/geom.mjs'

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []))
const out = a.out ?? '.work/nfhl'
const scope = (a.scope ?? '34.0,-119.5,34.9,-118.6').split(',').map(Number)
const N = Number(a.points ?? 4000)
const LIVE = Number(a.live ?? 30)
const src = LAYER_SOURCES.floodZones
let seed = 11
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)

// The raw polygons, as the build downloaded them (cached beside the output).
const rawPath = join(out, '..', 'nfhl-raw.json')
let raw
if (existsSync(rawPath)) raw = JSON.parse(readFileSync(rawPath, 'utf8'))
else {
  const box = [scope[0] - BUFFER_DEG, scope[1] - BUFFER_DEG, scope[2] + BUFFER_DEG, scope[3] + BUFFER_DEG]
  raw = await layerFeatures(fetch, src.url, { bbox: box, fields: src.fields, pageSize: src.pageSize, timeoutMs: 180000 })
  writeFileSync(rawPath, JSON.stringify(raw))
}
const rawPolys = raw.filter((f) => f.geometry?.rings?.length).map((f) => ({ a: f.attributes, r: f.geometry.rings, b: bboxOf(f.geometry.rings) }))
const zonesAtRaw = (lat, lng) => [...new Set(rawPolys.filter((p) => lat >= p.b[0] && lat <= p.b[2] && lng >= p.b[1] && lng <= p.b[3] && pointInRings(lng, lat, p.r)).map((p) => p.a.FLD_ZONE))].sort()

const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
const reader = createReader({ loadFile: async (p) => (existsSync(join(out, p)) ? readFileSync(join(out, p)) : null), now: () => Date.parse(manifest.checkedAt) })
// A tile with no flood polygon is not built in a floodZones-only run (the nightly set builds every
// cell, because other layers cover the state); the reader refuses it, which the proof counts apart.
let refusedNoTile = 0
const zonesAtTiles = async (lat, lng) => {
  try { return [...new Set((await reader.intersects('floodZones', lat, lng)).features.map((f) => f.attributes.FLD_ZONE))].sort() } catch (e) {
    if (/no hazard tile was built/.test(e.message)) { refusedNoTile++; return ['(no tile)'] }
    throw e
  }
}

// Distance (m) from a point to the nearest raw polygon edge, to tell a simplification hairline from a loss.
const RAD = Math.PI / 180
function edgeDistM(lat, lng) {
  const kx = Math.cos(lat * RAD) * RAD * 6371008.8, ky = RAD * 6371008.8
  let best = Infinity
  for (const p of rawPolys) {
    if (lat < p.b[0] - 0.001 || lat > p.b[2] + 0.001 || lng < p.b[1] - 0.001 || lng > p.b[3] + 0.001) continue
    for (const r of p.r) for (let i = 1; i < r.length; i++) {
      const ax = (r[i - 1][0] - lng) * kx, ay = (r[i - 1][1] - lat) * ky, bx = (r[i][0] - lng) * kx, by = (r[i][1] - lat) * ky
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
      const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy))
    }
  }
  return best
}

const report = { scope, source: src.url, lastEditDate: new Date(manifest.layers.floodZones.lastEditDate).toISOString().slice(0, 10), features: rawPolys.length }

// 1a. Random points across the county.
let same = 0, differ = 0, hairline = 0
const examples = []
let inAZone = 0
for (let i = 0; i < N; i++) {
  const lat = scope[0] + rnd() * (scope[2] - scope[0]), lng = scope[1] + rnd() * (scope[3] - scope[1])
  const r = zonesAtRaw(lat, lng), t = await zonesAtTiles(lat, lng)
  if (r.length) inAZone++
  if (JSON.stringify(r) === JSON.stringify(t)) { same++; continue }
  if (t[0] === '(no tile)' && !r.length) { same++; continue }
  const d = edgeDistM(lat, lng)
  if (d < 1) hairline++
  else { differ++; if (examples.length < 5) examples.push({ lat, lng, raw: r, tiles: t, edgeM: Math.round(d * 10) / 10 }) }
}
report.randomPoints = { asked: N, inAZone, same, withinOneMetreOfAnEdge: hairline, differ, examples, refusedNoTile }

// 1b. The long polygons: the 25 with the largest box (river strips, coastal V zones), 40 points each,
// placed inside the raw polygon (rejection sampling in its box).
const longest = rawPolys.map((p) => ({ p, span: Math.hypot(p.b[2] - p.b[0], (p.b[3] - p.b[1]) * Math.cos(p.b[0] * RAD)) })).sort((x, y) => y.span - x.span).slice(0, 25)
let lInside = 0, lFound = 0, lLost = 0, lHair = 0
for (const { p } of longest) {
  let got = 0
  for (let k = 0; k < 4000 && got < 40; k++) {
    const lat = p.b[0] + rnd() * (p.b[2] - p.b[0]), lng = p.b[1] + rnd() * (p.b[3] - p.b[1])
    if (lat < scope[0] || lat > scope[2] || lng < scope[1] || lng > scope[3] || !pointInRings(lng, lat, p.r)) continue
    got++; lInside++
    const t = await zonesAtTiles(lat, lng)
    if (t.includes(p.a.FLD_ZONE)) lFound++
    else if (edgeDistM(lat, lng) < 1) lHair++
    else lLost++
  }
}
report.longPolygons = { polygons: longest.length, longestKm: Math.round(longest[0].span * 111), pointsInside: lInside, found: lFound, withinOneMetreOfAnEdge: lHair, lost: lLost }

// 1c. The area guard, both measures.
const simpArea = (m) => rawPolys.reduce((s, p) => s + m(p.r.map((r) => simplifyRing(r, src.simplifyDeg))), 0)
const rawArea = (m) => rawPolys.reduce((s, p) => s + m(p.r), 0)
report.simplificationAreaChange = { spherical: `${((simpArea(polygonAreaKm2) / rawArea(polygonAreaKm2) - 1) * 100).toFixed(4)}%`, oldMeanLatitude: `${((simpArea(polygonAreaKm2MeanLat) / rawArea(polygonAreaKm2MeanLat) - 1) * 100).toFixed(4)}%`, limit: '0.5%' }

// 2. Live parity: the app's own question (a point, intersects, FLD_ZONE) to the live service.
// Half the points inside a flood zone polygon, half anywhere.
const live = { asked: 0, same: 0, differ: [], failed: 0 }
const inZone = rawPolys.filter((p) => p.a.FLD_ZONE !== 'X' && p.a.FLD_ZONE !== 'D')
for (let i = 0; i < LIVE; i++) {
  let lat, lng
  if (i % 2 === 0 && inZone.length) {
    const p = inZone[Math.floor(rnd() * inZone.length)]
    for (let k = 0; k < 2000; k++) { lat = p.b[0] + rnd() * (p.b[2] - p.b[0]); lng = p.b[1] + rnd() * (p.b[3] - p.b[1]); if (pointInRings(lng, lat, p.r) && lat > scope[0] && lat < scope[2] && lng > scope[1] && lng < scope[3]) break }
  } else { lat = scope[0] + rnd() * (scope[2] - scope[0]); lng = scope[1] + rnd() * (scope[3] - scope[1]) }
  const q = new URLSearchParams({ geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'FLD_ZONE', returnGeometry: 'false', f: 'json' })
  try {
    const j = await (await fetch(`${src.url}/query?${q}`)).json()
    const l = [...new Set((j.features ?? []).map((f) => f.attributes.FLD_ZONE))].sort()
    const t = await zonesAtTiles(lat, lng)
    live.asked++
    if (JSON.stringify(l) === JSON.stringify(t) || (t[0] === '(no tile)' && !l.length)) {
      live.same++
      // Candidates for golden probes: answered the same, live and tiles, and well inside the zone.
      if (l.length && edgeDistM(lat, lng) > 25) (live.agreedInZone ??= []).push({ lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, zones: l })
    }
    else {
      const d = edgeDistM(lat, lng)
      if (d < 1) live.withinOneMetreOfAnEdge = (live.withinOneMetreOfAnEdge ?? 0) + 1
      live.differ.push({ lat, lng, live: l, tiles: t, edgeM: Math.round(d * 100) / 100 })
    }
  } catch { live.failed++ }
  await new Promise((r) => setTimeout(r, 300))
}
report.live = live

// 3. Size.
const tileDir = join(out, 'tiles')
const sizes = readdirSync(tileDir).map((f) => statSync(join(tileDir, f)).size).sort((x, y) => x - y)
const total = sizes.reduce((s, x) => s + x, 0)
report.size = { tiles: sizes.length, gzipMB: Math.round(total / 1e4) / 100, medianKB: Math.round(sizes[Math.floor(sizes.length / 2)] / 1e3), largestKB: Math.round(sizes[sizes.length - 1] / 1e3) }
console.log(JSON.stringify(report, null, 1))
