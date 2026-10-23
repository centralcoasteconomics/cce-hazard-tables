#!/usr/bin/env node
// Record the live answers for a TINY area into a test fixture, so `npm test` replays a real
// build end to end with no network. Never run it on a statewide scope.
//
//   node scripts/record-fixture.mjs --scope 33.9,-118.5,34.0,-118.4 --out test/fixtures/venice.json
//
// Feature geometry is clipped to the scope plus a 0.06 degree margin before it is saved (the
// Coastal Zone is one 10 MB polygon); counts and attributes are kept exactly as answered.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../build.mjs'
import { clipRing } from '../lib/geom.mjs'

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []))
const scope = (a.scope ?? '33.9,-118.5,34.0,-118.4').split(',').map(Number)
const [s, w, n, e] = scope
if (n - s > 0.3 || e - w > 0.3) throw new Error('record-fixture is for a tiny area only (at most 0.3 degrees a side)')
const box = [s - 0.06, w - 0.06, n + 0.06, e + 0.06]
const recorded = {}
const recFetch = async (url, init) => {
  const res = await fetch(url, init)
  const j = await res.json()
  for (const f of j.features ?? []) {
    if (f.geometry?.rings) f.geometry.rings = f.geometry.rings.map((r) => clipRing(r, box)).filter((r) => r.length)
  }
  recorded[String(url)] = j
  return { ok: res.ok, status: res.status, json: async () => j }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(ROOT, '.work'), { recursive: true })
const r = await build({ scope, fetch: recFetch, out: join(ROOT, '.work/record-out'), result: join(ROOT, '.work/record-result.json'), published: join(ROOT, '.work/none.json'), history: join(ROOT, '.work/none.json'), golden: false, now: a.now })
writeFileSync(a.out ?? join(ROOT, 'test/fixtures/venice.json'), JSON.stringify(recorded))
console.log(`recorded ${Object.keys(recorded).length} answers; build status ${r.status}; ${r.summary.tiles} tiles`)
