#!/usr/bin/env node
// Record a run in state/ (committed to main by the workflow).
//   node record.mjs --published   after the data branch was pushed: the layers built tonight
//                                 become the baseline the next run's guards compare against
//   node record.mjs               held: history only, the baseline is untouched
// state/published.json  per layer: the agency edit date, feature count and area last published
// state/history.json    the last 120 runs, newest last (the flapping rule reads it)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const published = process.argv.includes('--published')
const stateDir = join(HERE, 'state')
const resultPath = join(HERE, 'result.json')
if (!existsSync(resultPath)) {
  console.error('record: no result.json (the build did not finish); nothing recorded')
  process.exit(1)
}
const r = JSON.parse(readFileSync(resultPath, 'utf8'))
mkdirSync(stateDir, { recursive: true })

if (published) {
  const p = join(stateDir, 'published.json')
  const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { layers: {} }
  const layers = { ...prev.layers }
  for (const [id, l] of Object.entries(r.summary.layers)) {
    if (l.carried || l.featureCount == null) continue
    layers[id] = { lastEditDate: l.lastEditDate, featureCount: l.featureCount, areaKm2: l.areaKm2 }
  }
  writeFileSync(p, JSON.stringify({ at: r.now, scope: r.scope, layers }, null, 1) + '\n')
}
const histPath = join(stateDir, 'history.json')
const hist = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : []
hist.push({ at: r.now, status: published ? r.status : 'held', rebuilt: r.rebuilt, downloadFailed: r.downloadFailed, red: r.red, warn: r.warn, goldenFailed: r.golden.filter((g) => !g.ok).map((g) => g.label) })
writeFileSync(histPath, JSON.stringify(hist.slice(-120), null, 1) + '\n')
console.log(`recorded: ${published ? r.status : 'held'} (${r.now})`)
