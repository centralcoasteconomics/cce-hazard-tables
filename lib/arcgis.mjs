// The ArcGIS REST calls the build makes: layer metadata (last edit date, field names), a count,
// and the features themselves, page by page, as Esri JSON in WGS84. `fetch` is injectable so
// the tests replay recorded answers and never touch the network.

const qs = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString()

async function getJson(fetchImpl, url, { attempts = 3, waitMs = 2000, timeoutMs = 120000 } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
      const res = await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined)
      if (t) clearTimeout(t)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (j?.error) throw new Error(`ArcGIS ${j.error.code} ${j.error.message}`)
      return j
    } catch (e) {
      last = e
      if (i < attempts - 1 && waitMs) await new Promise((r) => setTimeout(r, waitMs * (i + 1)))
    }
  }
  throw new Error(`${url.split('?')[0]}: ${last instanceof Error ? last.message : String(last)}`)
}

const envelope = (b) => ({
  geometry: JSON.stringify({ xmin: b[1], ymin: b[0], xmax: b[3], ymax: b[2], spatialReference: { wkid: 4326 } }),
  geometryType: 'esriGeometryEnvelope',
  inSR: 4326,
  spatialRel: 'esriSpatialRelIntersects'
})

/** { lastEditDate (ms or null), fields: string[], maxRecordCount, name } */
export async function layerMetadata(fetchImpl, url, opts) {
  const j = await getJson(fetchImpl, `${url}?f=json`, opts)
  const e = j.editingInfo ?? {}
  return {
    name: j.name ?? null,
    lastEditDate: e.dataLastEditDate ?? e.lastEditDate ?? null,
    fields: (j.fields ?? []).map((f) => f.name),
    maxRecordCount: j.maxRecordCount ?? 1000
  }
}

/** Features inside `bbox` ([s, w, n, e]); the count the build must end up with. */
export async function layerCount(fetchImpl, url, bbox, where = '1=1', opts) {
  const j = await getJson(fetchImpl, `${url}/query?${qs({ where, ...envelope(bbox), returnCountOnly: true, f: 'json' })}`, opts)
  if (typeof j.count !== 'number') throw new Error(`${url}: no count in the answer`)
  return j.count
}

/** Every feature inside `bbox`, ordered by object id, page by page. */
export async function layerFeatures(fetchImpl, url, { bbox, fields, oid = 'OBJECTID', pageSize = 1000, where = '1=1', onPage, ...opts }) {
  const out = []
  for (let offset = 0; ; ) {
    const j = await getJson(fetchImpl, `${url}/query?${qs({
      where,
      ...envelope(bbox),
      outFields: [oid, ...fields.filter((f) => f !== oid)].join(','),
      returnGeometry: true,
      outSR: 4326,
      geometryPrecision: 6,
      orderByFields: oid,
      resultOffset: offset,
      resultRecordCount: pageSize,
      f: 'json'
    })}`, opts)
    const feats = j.features ?? []
    out.push(...feats)
    onPage?.(out.length)
    offset += feats.length
    if (!feats.length || (!j.exceededTransferLimit && feats.length < pageSize)) break
  }
  return out
}
