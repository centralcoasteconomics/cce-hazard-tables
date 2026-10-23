// Publish guards. A held layer always beats a degraded one: a layer that fails a guard is not
// replaced; its previous tiles are carried into tonight's set (and named in the manifest's
// `held`), and the run goes red so someone looks. A layer with no previous copy to carry holds
// the whole run (nothing is published).
//
// COUNT. State polygon layers change rarely and by little. Against the last PUBLISHED summary
// (state/published.json): with the same agency edit date, fewer than 98% of the features holds
// the layer (the source answered short, or a page went missing); with a newer edit date, fewer
// than 90% holds (real re-zoning happens, a collapse does not). A smaller drop publishes with a
// warning.
// AREA. The layer's total area moving more than 2% with the same edit date, or 10% with a newer
// one, holds it: a feature count can survive a polygon losing most of its rings.
// COMPLETE DOWNLOAD. The features written must equal the server's own count for the scope.
// SIMPLIFICATION. Simplifying may not move the layer's area by more than 0.5% (it is meant to
// drop vertices nobody can see, nothing more).
// SCHEMA. Every field the app reads must still exist on the layer (the `npm run health` drift
// check, applied before anything is built).
// VINTAGE. An agency edit date older than the published one holds the layer.
// GOLDEN PROBES (golden.json). Points with known answers, asked through reader.mjs against the
// tiles just written. A flip holds the layer it probes.
// FLAPPING SOURCE. A layer whose download fails keeps its previous tiles. The run turns red only
// when the same layer has failed 3 nights in a row or on more than half of the last 14.

export const HOLD_COUNT_DROP = 0.02
export const HOLD_COUNT_DROP_EDITED = 0.1
export const WARN_COUNT_DROP = 0.005
export const HOLD_AREA_CHANGE = 0.02
export const HOLD_AREA_CHANGE_EDITED = 0.1
export const SIMPLIFY_AREA_LIMIT = 0.005
export const FLAP_RUN = 3
export const FLAP_WINDOW = 14

const pct = (x) => `${(x * 100).toFixed(1)}%`

/**
 * @param {{ lastEditDate?: number|null, featureCount: number, areaKm2: number } | undefined} prev
 * @param {{ lastEditDate: number|null, featureCount: number, sourceCount: number, areaKm2: number, rawAreaKm2: number, missingFields: string[] }} next
 * @returns {{ hold: string[], warn: string[] }}
 */
export function checkLayer(prev, next, { minCount = 0 } = {}) {
  const hold = []
  const warn = []
  if (next.missingFields?.length) hold.push(`schema: the layer no longer has ${next.missingFields.join(', ')}`)
  if (next.featureCount !== next.sourceCount) hold.push(`incomplete download: ${next.featureCount} of ${next.sourceCount} features`)
  // The statewide floor (lib/layers.mjs minStatewide) is the first night's collapse guard, before any baseline exists.
  if (minCount && next.featureCount < minCount) hold.push(`${next.featureCount} features, under the statewide floor of ${minCount}`)
  if (next.rawAreaKm2 > 0) {
    const d = Math.abs(next.areaKm2 / next.rawAreaKm2 - 1)
    if (d > SIMPLIFY_AREA_LIMIT) hold.push(`simplification moved the area by ${pct(d)} (limit ${pct(SIMPLIFY_AREA_LIMIT)})`)
  }
  if (prev) {
    const edited = next.lastEditDate != null && prev.lastEditDate != null && next.lastEditDate > prev.lastEditDate
    if (next.lastEditDate != null && prev.lastEditDate != null && next.lastEditDate < prev.lastEditDate)
      hold.push(`the agency edit date went backwards (${new Date(next.lastEditDate).toISOString()} < ${new Date(prev.lastEditDate).toISOString()})`)
    if (prev.featureCount > 0) {
      const drop = 1 - next.featureCount / prev.featureCount
      const limit = edited ? HOLD_COUNT_DROP_EDITED : HOLD_COUNT_DROP
      if (drop > limit) hold.push(`COLLAPSED ${prev.featureCount} -> ${next.featureCount} features (-${pct(drop)}), limit ${pct(limit)}${edited ? ' with a newer edit date' : ''}`)
      else if (drop > WARN_COUNT_DROP) warn.push(`down ${pct(drop)} (${prev.featureCount} -> ${next.featureCount} features)`)
    }
    if (prev.areaKm2 > 0) {
      const ch = Math.abs(next.areaKm2 / prev.areaKm2 - 1)
      const limit = edited ? HOLD_AREA_CHANGE_EDITED : HOLD_AREA_CHANGE
      if (ch > limit) hold.push(`area moved ${pct(ch)} (${prev.areaKm2.toFixed(1)} -> ${next.areaKm2.toFixed(1)} km2), limit ${pct(limit)}`)
    }
  }
  return { hold, warn }
}

/**
 * Golden probe: each entry { label, layer, lat, lng, expect, withinM?, field?, match? }.
 * `expect` true: a feature must answer (and, with `field`/`match`, one whose field matches the
 * regex); false: none may. `withinM` asks `nearby`, otherwise `intersects` at the point.
 */
export async function goldenProbe(reader, probes) {
  const out = []
  for (const g of probes) {
    try {
      const r = g.withinM ? await reader.nearby(g.layer, g.lat, g.lng, g.withinM) : await reader.intersects(g.layer, g.lat, g.lng)
      const re = g.match ? new RegExp(g.match, 'i') : null
      const hits = re ? r.features.filter((f) => re.test(String(f.attributes?.[g.field] ?? ''))) : r.features
      const ok = g.expect ? hits.length > 0 : r.features.length === 0
      out.push({ label: g.label, layer: g.layer, ok, got: r.features.slice(0, 3).map((f) => (g.field ? f.attributes?.[g.field] : 'feature')) })
    } catch (e) {
      out.push({ label: g.label, layer: g.layer, ok: false, got: [`refused: ${e instanceof Error ? e.message : String(e)}`] })
    }
  }
  return out
}

/** Flapping-source rule: has this layer's download failed 3 nights running, or on more than half of the last 14? */
export function flapIsRed(history, layer, failedTonight) {
  const nights = [...(history ?? []).slice(-(FLAP_WINDOW - 1)).map((h) => (h.downloadFailed ?? []).includes(layer)), failedTonight]
  const run = nights.slice(-FLAP_RUN)
  if (run.length === FLAP_RUN && run.every(Boolean)) return true
  return nights.filter(Boolean).length > FLAP_WINDOW / 2
}
