// Build-side geometry: conservative simplification, clipping a ring to a tile, areas. The
// read-side tests (point in polygon, intersects, distance) live in reader.mjs so the app can
// vendor one file.

const RAD = Math.PI / 180
const EARTH_M = 6371008.8

export const round6 = (x) => Math.round(x * 1e6) / 1e6

/** Douglas-Peucker on a closed ring of [lng, lat], tolerance in degrees. Keeps the ring closed and at least 4 points. */
export function simplifyRing(ring, tol) {
  if (!tol || ring.length <= 4) return ring.map((p) => [round6(p[0]), round6(p[1])])
  const keep = new Uint8Array(ring.length)
  keep[0] = keep[ring.length - 1] = 1
  // Split a closed ring at its farthest point from the start so the first segment is not degenerate.
  let far = 1, farD = -1
  for (let i = 1; i < ring.length - 1; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2
    if (d > farD) { farD = d; far = i }
  }
  keep[far] = 1
  const stack = [[0, far], [far, ring.length - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()
    let idx = -1, max = -1
    const [ax, ay] = ring[a], [bx, by] = ring[b]
    const dx = bx - ax, dy = by - ay
    const L = dx * dx + dy * dy
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i]
      let d
      if (!L) d = (px - ax) ** 2 + (py - ay) ** 2
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L))
        d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2
      }
      if (d > max) { max = d; idx = i }
    }
    if (max > t2) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = []
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push([round6(ring[i][0]), round6(ring[i][1])])
  return out.length >= 4 ? out : ring.map((p) => [round6(p[0]), round6(p[1])])
}

/**
 * Sutherland-Hodgman: a ring clipped to the box [s, w, n, e]. Exact for points inside the box
 * (the only place the tile is ever asked), even for concave rings; where a ring leaves and
 * re-enters the box the result carries zero-area edges along the box's edge. Those lie at least
 * the tile margin away from the tile itself, so no question the reader accepts can reach them
 * (reader.mjs `withinMargin`).
 */
export function clipRing(ring, [s, w, n, e]) {
  let pts = ring
  const edges = [
    (p) => p[0] >= w, (p) => p[0] <= e, (p) => p[1] >= s, (p) => p[1] <= n
  ]
  const cuts = [
    (a, b) => { const t = (w - a[0]) / (b[0] - a[0]); return [w, a[1] + t * (b[1] - a[1])] },
    (a, b) => { const t = (e - a[0]) / (b[0] - a[0]); return [e, a[1] + t * (b[1] - a[1])] },
    (a, b) => { const t = (s - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), s] },
    (a, b) => { const t = (n - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), n] }
  ]
  for (let k = 0; k < 4; k++) {
    const inside = edges[k]
    const out = []
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]
      const prev = pts[(i + pts.length - 1) % pts.length]
      const ci = inside(cur), pi = inside(prev)
      if (ci) {
        if (!pi) out.push(cuts[k](prev, cur))
        out.push(cur)
      } else if (pi) out.push(cuts[k](prev, cur))
    }
    pts = out
    if (!pts.length) return []
  }
  // Close the ring and drop repeated points.
  const res = []
  for (const p of pts) {
    const q = [round6(p[0]), round6(p[1])]
    const last = res[res.length - 1]
    if (!last || last[0] !== q[0] || last[1] !== q[1]) res.push(q)
  }
  if (res.length && (res[0][0] !== res[res.length - 1][0] || res[0][1] !== res[res.length - 1][1])) res.push([res[0][0], res[0][1]])
  return res.length >= 4 && Math.abs(ringSignedArea(res)) > 0 ? res : []
}

/** Signed shoelace area in square degrees. */
export function ringSignedArea(ring) {
  let a = 0
  for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
  return a / 2
}

/**
 * Area of a polygon (every ring, holes subtract by orientation) in square kilometres, on the
 * sphere (Chamberlain and Duquette 2007, the formula behind most web-map area tools): each edge
 * contributes (lng2 - lng1)(2 + sin lat1 + sin lat2).
 *
 * 2026-10-23 (OPS-087): this used to scale the planar shoelace area by cos(mean latitude of the
 * vertices). For a polygon spanning many degrees of latitude that factor depends on WHERE the
 * vertices are, not on the shape, so simplification (which drops vertices unevenly along a
 * coast) moved the measured area of the Coastal Zone's largest feature by 0.8% while no ring's
 * real area moved by more than 0.05 km2. The simplification guard (0.5%) then held the layer,
 * the held layer was not written, and its golden probes came back empty: the deferral blamed
 * clipping, but clipping was never the cause (scripts/nfhl-proof.mjs and NFHL_PLAN.md).
 */
export function polygonAreaKm2(rings) {
  if (!rings.length) return 0
  let a = 0
  for (const r of rings) {
    for (let i = 1; i < r.length; i++) {
      const [x1, y1] = r[i - 1], [x2, y2] = r[i]
      a += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD))
    }
  }
  return Math.abs(a * EARTH_M * EARTH_M / 2) / 1e6
}

/** The old measure (planar area times cos of the vertices' mean latitude); kept for the regression test. */
export function polygonAreaKm2MeanLat(rings) {
  if (!rings.length) return 0
  let lat = 0, n = 0
  for (const r of rings) for (const p of r) { lat += p[1]; n++ }
  lat /= n || 1
  const k = (RAD * EARTH_M) ** 2 * Math.cos(lat * RAD) / 1e6
  let a = 0
  for (const r of rings) a += ringSignedArea(r)
  return Math.abs(a) * k
}

export function bboxOf(rings) {
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
