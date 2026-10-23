export const SCHEMA: number
export const TILE_DEG: number
export const BUFFER_DEG: number
export const PUBLISHED_BASE_URL: string
export const DEFAULT_MAX_AGE_DAYS: number

export type HazardLayer =
  | 'liquefaction'
  | 'landslide'
  | 'unevaluated'
  | 'faultZones'
  | 'coastalZone'
  | 'fhszSra'
  | 'fhszLra'
  | 'criticalHabitat'
  | 'airports'

export const LAYERS: Record<HazardLayer, { source: string; license: string; whole?: boolean }>

export class HazardTableRefusal extends Error {}

/** ArcGIS's own feature shape (f=json, outSR 4326): attributes plus [lng, lat] rings. */
export interface TableFeature {
  attributes: Record<string, unknown>
  geometry: { rings: number[][][] }
}

export interface LayerVintage {
  layer: HazardLayer
  /** The name a fact cites. */
  source: string
  /** The agency's own last edit date of the layer (ISO), or null when the service publishes none. */
  published: string | null
  /** The night CCE last confirmed that date (ISO). */
  checked: string | null
  /** When the layer's tiles were last rebuilt (ISO). */
  built: string | null
  /** True when tonight's copy failed a guard and the previous one is being served. */
  held: boolean
}

export interface TableAnswer {
  features: TableFeature[]
  vintage: LayerVintage
  tile: string
}

export interface HazardReader {
  manifest(): Promise<Record<string, unknown>>
  intersects(layer: HazardLayer, lat: number, lng: number, q?: { rings?: number[][][] | null }): Promise<TableAnswer>
  nearby(layer: HazardLayer, lat: number, lng: number, meters: number): Promise<TableAnswer>
}

export function createReader(opts?: {
  baseUrl?: string
  fetch?: typeof fetch
  loadFile?: (path: string) => Promise<Uint8Array | null>
  cacheTiles?: number
  maxAgeDays?: number
  now?: () => number
}): HazardReader

export function sourceLabel(vintage: LayerVintage): string
export function tileKey(lat: number, lng: number): string
export function tileBounds(id: string): [number, number, number, number]
export function pointInRings(lng: number, lat: number, rings: number[][][]): boolean
export function distanceToRings(lat: number, lng: number, rings: number[][][]): number
export function ringsIntersect(a: number[][][], b: number[][][]): boolean
export function ringsBBox(rings: number[][][]): [number, number, number, number]
export function reachMeters(lat: number, lng: number, rings: number[][][] | null | undefined): number
export function withinMargin(id: string, lat: number, lng: number, meters: number): boolean
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number
