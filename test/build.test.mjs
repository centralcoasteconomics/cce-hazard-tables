// End to end on a tiny area: the build replays answers recorded from the live services for one
// Venice tile (scripts/record-fixture.mjs, 2026-10-23), so no network is touched. It proves the
// whole path: metadata, counts, paging, simplification, tiling, guards, golden probes through the
// reader, and the nightly no-change night that only moves the check date.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, replayFetch } from '../build.mjs'
import { createReader } from '../reader.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCOPE = [33.9, -118.5, 34.0, -118.4]
const recorded = JSON.parse(readFileSync(join(HERE, 'fixtures', 'venice.json'), 'utf8'))
const quiet = () => {}
const net = { attempts: 1, waitMs: 0 }

function run(dir, opts = {}) {
  return build({
    scope: SCOPE,
    out: join(dir, opts.outName ?? 'out'),
    result: join(dir, `${opts.outName ?? 'out'}-result.json`),
    published: join(dir, 'published.json'),
    history: join(dir, 'history.json'),
    golden: join(ROOT, 'golden.json'),
    fetch: replayFetch(opts.recorded ?? recorded),
    netOpts: net,
    log: quiet,
    now: '2026-10-23T12:00:00.000Z',
    ...opts
  })
}

const diskReader = (outDir, now = '2026-10-23T12:00:00.000Z') =>
  createReader({ now: () => Date.parse(now), loadFile: async (p) => (existsSync(join(outDir, p)) ? readFileSync(join(outDir, p)) : null) })

test('first build of the Venice tile publishes, and the golden probes in scope pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-'))
  const r = await run(dir)
  assert.equal(r.status, 'publish', JSON.stringify(r.red))
  assert.deepEqual(r.red, [])
  const labels = r.golden.map((g) => `${g.ok ? 'ok' : 'FAIL'} ${g.label}`)
  assert.ok(r.golden.length >= 5, labels.join('\n'))
  assert.ok(r.golden.every((g) => g.ok), labels.join('\n'))
  const m = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(m.tiles), ['339_-1185'])
  assert.equal(m.layers.liquefaction.lastEditDate, 1763574392920)

  // The answers the app's live queries gave for Venice, from the tiles.
  const reader = diskReader(join(dir, 'out'))
  const liq = await reader.intersects('liquefaction', 33.985, -118.4695)
  assert.deepEqual(liq.features.map((f) => f.attributes.QUAD_NAME), ['Venice'])
  // coastalZone, re-enabled 2026-10-25 (28c): Venice is inside it, from the tile.
  assert.equal((await reader.intersects('coastalZone', 33.985, -118.4695)).features.length, 1)
  assert.equal((await reader.intersects('unevaluated', 33.985, -118.4695)).features.length, 0, 'evaluated quad: an empty answer from a built tile')
  assert.equal((await reader.intersects('faultZones', 33.985, -118.4695)).features.length, 0)
  const lra = await reader.intersects('fhszLra', 33.985, -118.4695)
  assert.deepEqual(lra.features.map((f) => f.attributes.FHSZ_Description), ['NonWildland'])
  const lax = await reader.nearby('airports', 33.9425, -118.4081, 3200)
  assert.ok(lax.features.some((f) => /LOS ANGELES INTERNATIONAL/.test(f.attributes.FACILITY)))
})

test('a night with no agency edit carries every layer, rewrites identical tiles and only moves the check date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-'))
  await run(dir)
  const first = readFileSync(join(dir, 'out', 'tiles', '339_-1185.json.gz'))
  const r2 = await run(dir, { prev: join(dir, 'out'), outName: 'out2', now: '2026-10-24T12:00:00.000Z' })
  assert.equal(r2.status, 'checked', JSON.stringify(r2.red))
  assert.equal(r2.rebuilt, 0)
  assert.deepEqual(readFileSync(join(dir, 'out2', 'tiles', '339_-1185.json.gz')), first, 'byte-identical tile')
  const m2 = JSON.parse(readFileSync(join(dir, 'out2', 'manifest.json'), 'utf8'))
  assert.equal(m2.checkedAt, '2026-10-24T12:00:00.000Z')
  assert.equal(m2.generatedAt, '2026-10-23T12:00:00.000Z')
  assert.equal(m2.layers.liquefaction.checkedAt, '2026-10-24T12:00:00.000Z')
})

/** The recorded answers with one layer's metadata date moved and its features replaced. */
function tamper(layerFragment, edit, mapFeatures) {
  const out = structuredClone(recorded)
  for (const [url, body] of Object.entries(out)) {
    if (!url.includes(layerFragment)) continue
    if (url.endsWith('?f=json') && body.editingInfo) body.editingInfo = { ...body.editingInfo, dataLastEditDate: edit, lastEditDate: edit }
    if (body.features) body.features = mapFeatures(body.features)
    if (typeof body.count === 'number') body.count = mapFeatures(Array.from({ length: body.count }, () => ({}))).length
  }
  return out
}

test('a collapse with a newer edit date holds the layer and carries the previous copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-'))
  const r1 = await run(dir)
  // Baseline as record.mjs would write it.
  writeFileSync(join(dir, 'published.json'), JSON.stringify({ layers: r1.summary.layers }))
  const bad = tamper('CGS_Landslide_Zones', 1800000000000, (fs) => fs.slice(0, Math.floor(fs.length / 2)))
  const r2 = await run(dir, { prev: join(dir, 'out'), outName: 'out2', recorded: bad, now: '2026-10-24T12:00:00.000Z' })
  assert.equal(r2.status, 'checked', 'nothing else changed; the held layer is carried')
  const n = r1.summary.layers.landslide.featureCount
  assert.ok(n > 10)
  assert.match(r2.red.join('\n'), new RegExp(`landslide: COLLAPSED ${n} -> ${Math.floor(n / 2)}`))
  const m2 = JSON.parse(readFileSync(join(dir, 'out2', 'manifest.json'), 'utf8'))
  assert.ok(m2.held.landslide)
  assert.equal(m2.layers.landslide.featureCount, n, 'the published copy stays')
})

test('a golden flip holds that layer; with no previous copy nothing is published', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-'))
  // The liquefaction answer comes back with the Venice polygon gone (count consistent, so only the probe can see it).
  const flip = tamper('CGS_Liquefaction_Zones', 1763574392920, (fs) => fs.filter((f) => f.attributes?.QUAD_NAME !== 'Venice'))
  const r = await run(dir, { recorded: flip })
  assert.equal(r.status, 'held')
  assert.match(r.red.join('\n'), /liquefaction: golden probe Venice/)
  assert.equal(existsSync(join(dir, 'out', 'manifest.json')), false, 'nothing written')
})

test('a layer that does not answer keeps its previous tiles (warning, not red, on the first night)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hz-'))
  await run(dir)
  const down = Object.fromEntries(Object.entries(recorded).filter(([u]) => !u.includes('CGS_Liquefaction_Zones')))
  const r = await run(dir, { prev: join(dir, 'out'), outName: 'out2', recorded: down, now: '2026-10-24T12:00:00.000Z' })
  assert.deepEqual(r.red, [])
  assert.match(r.warn.join('\n'), /liquefaction: did not answer tonight/)
  assert.deepEqual(r.downloadFailed, ['liquefaction'])
  const reader = diskReader(join(dir, 'out2'), '2026-10-24T12:00:00.000Z')
  assert.deepEqual((await reader.intersects('liquefaction', 33.985, -118.4695)).features.map((f) => f.attributes.QUAD_NAME), ['Venice'])
})
