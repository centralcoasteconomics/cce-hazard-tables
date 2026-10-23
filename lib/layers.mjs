// The source layers: where each comes from, which fields the app reads, and how the build
// treats it. Every URL and field list below was probed live on 2026-10-23 (`?f=json`), and the
// field lists are exactly the `outFields` the app's live queries ask for, so a tile carries what
// the app reads and nothing else (src/shared/siteRisk.ts, src/main/connectors/hazards.ts).
//
// `fields`      attributes kept (the schema guard holds the layer when one disappears)
// `simplifyDeg` Douglas-Peucker tolerance in degrees. Conservative: 0.000005 deg is about 0.5 m,
//               well under the published maps' own precision (CGS zones are 1:24,000 quads,
//               where a pen line is about 12 m on the ground).
// `pageSize`    rows per request (the layer's maxRecordCount, or fewer for very large polygons)
// `whole`       one small file, read whole and queried by distance (airports, 221 polygons)
// `where`       a filter the app applies too (none today)

export const CA_SCOPE = [32.4, -124.5, 42.1, -114.1] // [south, west, north, east]

const CGS = 'https://services2.arcgis.com/zr3KAIbsRSUyARHG/arcgis/rest/services'

export const LAYER_SOURCES = {
  liquefaction: {
    url: `${CGS}/CGS_Liquefaction_Zones/FeatureServer/0`,
    fields: ['QUAD_NAME', 'RELEASED', 'REVISED'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    attribution: 'California Geological Survey, Seismic Hazard Zones. The official zone maps govern (Pub. Res. Code §2690 et seq.).'
  },
  landslide: {
    url: `${CGS}/CGS_Landslide_Zones/FeatureServer/0`,
    fields: ['QUAD_NAME', 'RELEASED', 'REVISED'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    attribution: 'California Geological Survey, Seismic Hazard Zones. The official zone maps govern.'
  },
  unevaluated: {
    url: `${CGS}/CGS_SHZ_Unevaluated_Areas/FeatureServer/0`,
    fields: ['QUAD_NAME', 'LABEL'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    attribution: 'California Geological Survey, areas not yet evaluated for seismic hazard zones.'
  },
  faultZones: {
    url: `${CGS}/CGS_Alquist_Priolo_Fault_Zones/FeatureServer/0`,
    fields: ['QUAD_NAME', 'ZN_RELEASED', 'ZN_REVISED'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    attribution: 'California Geological Survey, Alquist-Priolo Earthquake Fault Zones. The official zone maps govern (Pub. Res. Code §2621 et seq.).'
  },
  coastalZone: {
    url: 'https://services9.arcgis.com/wwVnNW92ZHUIr0V0/arcgis/rest/services/Coastal_Zone_Polygon/FeatureServer/0',
    fields: ['FID'],
    oid: 'FID',
    simplifyDeg: 0.000005,
    pageSize: 1,
    attribution: 'California Coastal Commission, Coastal Zone (cadastral) polygon. The certified Coastal Zone Boundary maps govern.'
  },
  fhszSra: {
    url: 'https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/FHSZSRA_23_3/FeatureServer/0',
    fields: ['SRA', 'FHSZ', 'FHSZ_Description'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    attribution: 'CAL FIRE, Fire Hazard Severity Zones in the State Responsibility Area (effective April 1, 2024).'
  },
  fhszLra: {
    url: 'https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/FHSALRA25_v1_All/FeatureServer/0',
    fields: ['SRA', 'FHSZ', 'FHSZ_Description'],
    simplifyDeg: 0.000005,
    pageSize: 500,
    attribution: 'CAL FIRE (Office of the State Fire Marshal), Fire Hazard Severity Zones in the Local Responsibility Area, map of March 24, 2025. Local adoption by ordinance governs.'
  },
  criticalHabitat: {
    url: 'https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/USFWS_Critical_Habitat/FeatureServer/0',
    fields: ['comname', 'sciname', 'status', 'listing_status', 'unitname', 'subunitname', 'fedreg'],
    simplifyDeg: 0.00001,
    // Each feature is a species' whole designation (multi-part, often across states), so pages stay small.
    pageSize: 10,
    attribution: 'U.S. Fish and Wildlife Service, final critical habitat designations (50 CFR Part 17). The Federal Register designation governs.'
  },
  airports: {
    url: 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHaviation/Airport_Boundaries/FeatureServer/0',
    fields: ['FACILITY'],
    simplifyDeg: 0.000005,
    pageSize: 1000,
    whole: true,
    attribution: 'Caltrans Division of Aeronautics, Airport Boundaries.'
  }
}

/**
 * The statewide floor: about 95% of the feature count measured on 2026-10-23 (returnCountOnly,
 * CCE_DATA_IN_HOUSE_PLAN_2026-10-23 section 1.3). It guards the first night, before a published
 * baseline exists; after that the COUNT and AREA guards against state/published.json take over.
 * Critical habitat counts the designations that reach the California box (137 measured).
 */
export const MIN_STATEWIDE = {
  liquefaction: 1900,
  landslide: 39500,
  unevaluated: 2600,
  faultZones: 1390,
  coastalZone: 1,
  fhszSra: 17500,
  fhszLra: 9250,
  criticalHabitat: 120,
  airports: 200
}
for (const [k, v] of Object.entries(MIN_STATEWIDE)) LAYER_SOURCES[k].minStatewide = v

export const LAYER_IDS = Object.keys(LAYER_SOURCES)
