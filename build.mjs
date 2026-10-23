#!/usr/bin/env node
// Build the California hazard tiles, check them, and say whether to publish.
//
//   node build.mjs --prev prev --out out                    the nightly run (the workflow checks out
//                                                          the data branch into prev/ first)
//   node build.mjs --scope 33.9,-118.5,34.0,-118.4 ...      a tiny area (local development)
//   node build.mjs --fixtures test/fixtures/venice.json     replay recorded answers (tests; no network)
//
// Every night: one metadata call per layer (the agency's last edit date and field names). A
// layer whose edit date has not moved is CARRIED from the previous tiles without downloading
// it; a layer whose date moved (or that has no previous copy, or `--force`, or a previous build
// more than 30 days old) is downloaded, simplified, tiled and checked. When nothing moved, the
// tiles are byte-identical and only the manifest's check date advances, so the reader can tell
// the copy is still current.
//
// Writes:  out/tiles/<lat10>_<lng10>.json.gz, out/whole/airports.json.gz, out/manifest.json,
//          out/ATTRIBUTION.md, result.json  { status: publish | checked | held, red[], warn[] }
// Exit 1 when anything is red. The workflow publishes when status is publish or checked (held
// layers are carried inside a published set) and nothing when status is held.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYER_SOURCES, LAYER_IDS, CA_SCOPE } from './lib/layers.mjs'
import { layerMetadata, layerCount, layerFeatures } from './lib/arcgis.mjs'
import { normalise, tileLayer } from './lib/tiler.mjs'
import { polygonAreaKm2 } from './lib/geom.mjs'
import { checkLayer, goldenProbe, flapIsRed } from './lib/guards.mjs'
import { createReader, SCHEMA, TILE_DEG, BUFFER_DEG, LAYERS } from './reader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MONTHLY_REBUILD_DAYS = 30

function args(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    a[k] = v
  }
  return a
}

const readJson = (p, dflt = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt)
const sha = (s) => createHash('sha256').update(s).digest('hex')
const gz = (obj) => gzipSync(JSON.stringify(obj), { level: 9 }) // no name, zero mtime: an unchanged file is byte-identical

/** A fetch that answers from a recorded file ({ "<url>": <json> }); anything unrecorded is a network error. */
export function replayFetch(recorded) {
  return async (url) => {
    const key = String(url)
    if (!(key in recorded)) return { ok: false, status: 599, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => recorded[key] }
  }
}

/** The previous published set: its manifest and a lazy per-tile reader. */
function previous(prevDir) {
  if (!prevDir || !existsSync(join(prevDir, 'manifest.json'))) return null
  const manifest = JSON.parse(readFileSync(join(prevDir, 'manifest.json'), 'utf8'))
  if (manifest.schema !== SCHEMA) return null
  const tileCache = new Map()
  const tile = (id) => {
    if (!tileCache.has(id)) {
      const p = join(prevDir, 'tiles', `${id}.json.gz`)
      tileCache.set(id, existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')) : null)
    }
    return tileCache.get(id)
  }
  const whole = (layer) => {
    const p = join(prevDir, 'whole', `${layer}.json.gz`)
    return existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString('utf8')).features ?? [] : null
  }
  return { manifest, tile, whole, tileIds: Object.keys(manifest.tiles ?? {}) }
}

/** The previous set's pieces of one layer, by tile (or the whole list). */
function carriedPieces(prev, layer) {
  if (!prev?.manifest.layers?.[layer]) return null
  if (LAYERS[layer]?.whole) {
    const w = prev.whole(layer)
    return w ? { whole: w } : null
  }
  const tiles = new Map()
  for (const id of prev.tileIds) {
    const t = prev.tile(id)
    const p = t?.layers?.[layer]
    if (p?.length) tiles.set(id, p)
  }
  return { tiles }
}

const ringsArea = (features) => features.reduce((s, f) => s + polygonAreaKm2(f.geometry?.rings ?? []), 0)
const recsArea = (recs) => recs.reduce((s, r) => s + polygonAreaKm2(r.r), 0)

export async function build(opts) {
  const out = opts.out ?? join(HERE, 'out')
  const now = opts.now ?? new Date().toISOString()
  const scope = opts.scope ?? CA_SCOPE
  const layerIds = opts.layers ?? LAYER_IDS
  const fetchImpl = opts.fetch ?? ((...a) => fetch(...a))
  const netOpts = opts.netOpts ?? {}
  const log = opts.log ?? ((...a) => console.log(...a))
  const prev = previous(opts.prev)
  const published = readJson(opts.published ?? join(HERE, 'state', 'published.json'), null)
  const history = readJson(opts.history ?? join(HERE, 'state', 'history.json'), [])
  const sameScope = prev && JSON.stringify(prev.manifest.scope) === JSON.stringify(scope)
  const red = []
  const warn = []
  const held = { ...(sameScope ? prev.manifest.held ?? {} : {}) }
  const downloadFailed = []
  const layers = {}
  /** layer -> { tiles: Map } | { whole: [] } */
  const content = {}
  let rebuilt = 0

  for (const id of layerIds) {
    const src = LAYER_SOURCES[id]
    const before = sameScope ? prev.manifest.layers?.[id] : null
    const carry = () => (sameScope ? carriedPieces(prev, id) : null)
    let meta
    try {
      meta = await layerMetadata(fetchImpl, src.url, netOpts)
    } catch (e) {
      downloadFailed.push(id)
      const c = carry()
      if (!c) { red.push(`${id}: the layer did not answer and there is no previous copy (${e.message})`); continue }
      content[id] = c
      layers[id] = { ...before, carried: true, note: `not checked tonight: ${e.message}` }
      if (flapIsRed(history, id, true)) red.push(`${id}: the source has failed repeatedly (flapping rule); previous tiles kept`)
      else warn.push(`${id}: did not answer tonight; previous tiles kept (${e.message})`)
      continue
    }
    const missingFields = src.fields.filter((f) => !meta.fields.includes(f))
    const age = before?.builtAt ? (Date.parse(now) - Date.parse(before.builtAt)) / 86400000 : Infinity
    const changed = opts.force || !before || meta.lastEditDate == null || meta.lastEditDate !== before.lastEditDate || age > MONTHLY_REBUILD_DAYS || missingFields.length
    if (!changed) {
      const c = carry()
      if (c) {
        content[id] = c
        layers[id] = { ...before, checkedAt: now, carried: false }
        log(`  ${id}: unchanged since ${new Date(meta.lastEditDate).toISOString().slice(0, 10)}; kept`)
        continue
      }
    }
    // Rebuild.
    let feats, sourceCount
    // Download a little past the scope: a tile's margin needs the polygons just outside it, and a
    // whole-file layer answers distance questions (airports, 3,200 m) from sites near the edge.
    const pad = src.whole ? 0.05 : BUFFER_DEG
    const box = [scope[0] - pad, scope[1] - pad, scope[2] + pad, scope[3] + pad]
    try {
      sourceCount = await layerCount(fetchImpl, src.url, box, src.where, netOpts)
      feats = await layerFeatures(fetchImpl, src.url, { bbox: box, fields: src.fields, oid: src.oid, pageSize: src.pageSize, where: src.where, ...netOpts })
    } catch (e) {
      downloadFailed.push(id)
      const c = carry()
      if (!c) { red.push(`${id}: download failed and there is no previous copy (${e.message})`); continue }
      content[id] = c
      layers[id] = { ...before, carried: true, note: `download failed tonight: ${e.message}` }
      if (flapIsRed(history, id, true)) red.push(`${id}: the download has failed repeatedly (flapping rule); previous tiles kept`)
      else warn.push(`${id}: download failed tonight; previous tiles kept (${e.message})`)
      continue
    }
    const recs = normalise(feats, src)
    const next = {
      lastEditDate: meta.lastEditDate,
      featureCount: recs.length,
      sourceCount,
      areaKm2: recsArea(recs),
      rawAreaKm2: ringsArea(feats),
      missingFields
    }
    // Features with no usable geometry are dropped by normalise; they are not part of the count either.
    next.sourceCount -= feats.length - recs.length
    const statewide = JSON.stringify(scope) === JSON.stringify(CA_SCOPE)
    const g = checkLayer(published?.layers?.[id], next, { minCount: statewide ? src.minStatewide ?? 1 : 0 })
    for (const w of g.warn) warn.push(`${id}: ${w}`)
    const entry = {
      source: LAYERS[id].source,
      url: src.url,
      license: LAYERS[id].license,
      attribution: src.attribution,
      lastEditDate: meta.lastEditDate,
      featureCount: next.featureCount,
      areaKm2: Math.round(next.areaKm2 * 1000) / 1000,
      builtAt: now,
      checkedAt: now,
      sha256: sha(JSON.stringify(recs))
    }
    if (g.hold.length) {
      const c = carry()
      for (const h of g.hold) red.push(`${id}: ${h}`)
      if (!c) { red.push(`${id}: held with no previous copy to carry; nothing is published`); layers[id] = { ...entry, heldWithoutCopy: true }; continue }
      content[id] = c
      layers[id] = { ...before, carried: true, note: `held tonight: ${g.hold.join('; ')}` }
      held[id] = held[id] ?? now
      continue
    }
    content[id] = src.whole ? { whole: recs } : { tiles: tileLayer(recs, scope) }
    delete held[id]
    // A layer with no edit date (Caltrans airports) is downloaded every night; identical content is not a rebuild.
    if (before?.sha256 === entry.sha256 && !before.carried) {
      layers[id] = { ...entry, builtAt: before.builtAt ?? now }
      log(`  ${id}: downloaded, identical to the published copy`)
      continue
    }
    layers[id] = entry
    rebuilt++
    log(`  ${id}: ${recs.length} features, ${entry.areaKm2} km2, edit date ${meta.lastEditDate ? new Date(meta.lastEditDate).toISOString().slice(0, 10) : 'none'}`)
  }

  // Assemble the tiles (one file per cell, every layer in it) and probe them.
  const assemble = () => {
    const tiles = new Map()
    for (const [layer, c] of Object.entries(content)) {
      if (!c.tiles) continue
      for (const [tid, pieces] of c.tiles) {
        if (!tiles.has(tid)) tiles.set(tid, {})
        tiles.get(tid)[layer] = pieces
      }
    }
    return tiles
  }
  let tiles = assemble()
  const manifestOf = (tileBytes) => ({
    schema: SCHEMA,
    generatedAt: rebuilt ? now : prev?.manifest.generatedAt ?? now,
    checkedAt: now,
    scope,
    tileDeg: TILE_DEG,
    bufferDeg: BUFFER_DEG,
    layers,
    held,
    tiles: tileBytes
  })
  const memReader = () => {
    const files = new Map()
    const tileBytes = {}
    for (const [tid, L] of tiles) tileBytes[tid] = 1
    files.set('manifest.json', Buffer.from(JSON.stringify(manifestOf(tileBytes))))
    return createReader({
      now: () => Date.parse(now),
      loadFile: async (p) => {
        if (files.has(p)) return files.get(p)
        const m = /^tiles\/(.+)\.json\.gz$/.exec(p)
        if (m && tiles.has(m[1])) return Buffer.from(JSON.stringify({ schema: SCHEMA, tile: m[1], layers: tiles.get(m[1]) }))
        const w = /^whole\/(.+)\.json\.gz$/.exec(p)
        if (w && content[w[1]]?.whole) return Buffer.from(JSON.stringify({ features: content[w[1]].whole }))
        return null
      }
    })
  }
  const inScope = (g) => g.lat >= scope[0] && g.lat <= scope[2] && g.lng >= scope[1] && g.lng <= scope[3]
  const probes = opts.golden === false ? [] : readJson(opts.golden ?? join(HERE, 'golden.json'), { probes: [] }).probes.filter((g) => inScope(g) && layers[g.layer])
  let golden = await goldenProbe(memReader(), probes)
  const flipped = [...new Set(golden.filter((g) => !g.ok).map((g) => g.layer))]
  if (flipped.length) {
    for (const layer of flipped) {
      for (const g of golden.filter((x) => !x.ok && x.layer === layer)) red.push(`${layer}: golden probe ${g.label} failed (got ${JSON.stringify(g.got)})`)
      if (!layers[layer]?.carried) {
        const c = sameScope ? carriedPieces(prev, layer) : null
        if (c) {
          content[layer] = c
          layers[layer] = { ...prev.manifest.layers[layer], carried: true, note: 'held tonight: golden probe' }
          held[layer] = held[layer] ?? now
          rebuilt = Math.max(0, rebuilt - 1)
        } else layers[layer] = { ...layers[layer], heldWithoutCopy: true }
      }
    }
    tiles = assemble()
    golden = await goldenProbe(memReader(), probes)
  }

  const blocking = Object.entries(layers).filter(([, l]) => l.heldWithoutCopy).map(([k]) => k)
  const status = blocking.length || red.some((r) => /no previous copy/.test(r)) ? 'held' : rebuilt ? 'publish' : 'checked'

  // Write.
  let bytes = 0
  const tileBytes = {}
  if (status !== 'held') {
    rmSync(out, { recursive: true, force: true })
    mkdirSync(join(out, 'tiles'), { recursive: true })
    mkdirSync(join(out, 'whole'), { recursive: true })
    for (const tid of [...tiles.keys()].sort()) {
      const body = gz({ schema: SCHEMA, tile: tid, layers: Object.fromEntries(Object.entries(tiles.get(tid)).sort()) })
      writeFileSync(join(out, 'tiles', `${tid}.json.gz`), body)
      tileBytes[tid] = body.length
      bytes += body.length
    }
    for (const [layer, c] of Object.entries(content)) {
      if (!c.whole) continue
      const body = gz({ schema: SCHEMA, layer, features: c.whole })
      writeFileSync(join(out, 'whole', `${layer}.json.gz`), body)
      bytes += body.length
    }
    const manifest = { ...manifestOf(tileBytes), golden, totals: { tiles: Object.keys(tileBytes).length, bytes } }
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
    copyFileSync(join(HERE, 'ATTRIBUTION.md'), join(out, 'ATTRIBUTION.md'))
  }

  const result = {
    status,
    red,
    warn,
    now,
    scope,
    rebuilt,
    downloadFailed,
    held,
    golden,
    summary: { layers: Object.fromEntries(Object.entries(layers).map(([k, l]) => [k, { lastEditDate: l.lastEditDate ?? null, featureCount: l.featureCount ?? null, areaKm2: l.areaKm2 ?? null, carried: !!l.carried }])), tiles: Object.keys(tileBytes).length, bytes }
  }
  writeFileSync(opts.result ?? join(HERE, 'result.json'), JSON.stringify(result, null, 1) + '\n')
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2))
  const r = await build({
    out: a.out,
    prev: a.prev,
    published: a.published,
    history: a.history,
    result: a.result,
    force: a.force === 'true',
    now: a.now,
    scope: a.scope ? a.scope.split(',').map(Number) : undefined,
    layers: a.layers ? a.layers.split(',') : undefined,
    golden: a.golden === 'none' ? false : a.golden,
    fetch: a.fixtures ? replayFetch(JSON.parse(readFileSync(a.fixtures, 'utf8'))) : undefined,
    netOpts: a.fixtures ? { attempts: 1, waitMs: 0 } : undefined
  })
  console.log(`\n${r.status}: ${r.rebuilt} layer(s) rebuilt, ${r.summary.tiles} tiles, ${(r.summary.bytes / 1e6).toFixed(2)} MB gzip`)
  for (const g of r.golden) console.log(`  golden ${g.ok ? 'ok  ' : 'FAIL'} ${g.label}`)
  for (const w of r.warn) console.warn(`  warning: ${w}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${r.status}\nrebuilt=${r.rebuilt}\n`)
  if (r.red.length) {
    console.error(`\nRED (${r.status === 'held' ? 'nothing published' : 'held layers carried from the previous set'}):`)
    for (const x of r.red) console.error(`  - ${x}`)
    process.exitCode = 1
  }
}
