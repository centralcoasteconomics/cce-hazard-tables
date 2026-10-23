# Sources, licenses and attribution

The tiles published by this repository (the `data` branch: `tiles/`, `whole/`, `manifest.json`)
are simplified, tiled copies of the public layers below. Nothing from any other source is mixed
in. Each layer's vintage (the agency's own last edit date, and the night CCE last confirmed it)
is in `manifest.json` under `layers.<id>.lastEditDate` and `checkedAt`.

| Layer | Publisher and service | License | Official map that governs |
|---|---|---|---|
| `liquefaction`, `landslide`, `unevaluated` | California Geological Survey, Seismic Hazard Zones (`services2.arcgis.com/zr3KAIbsRSUyARHG`, CGS_Liquefaction_Zones, CGS_Landslide_Zones, CGS_SHZ_Unevaluated_Areas) | California public record; published without warranty | The official Seismic Hazard Zone maps (Pub. Res. Code §2690 et seq.) |
| `faultZones` | California Geological Survey, Alquist-Priolo Earthquake Fault Zones (same org, CGS_Alquist_Priolo_Fault_Zones) | California public record | The official Earthquake Fault Zone maps (Pub. Res. Code §2621 et seq.) |
| `coastalZone` | California Coastal Commission, Coastal Zone polygon (`services9.arcgis.com/wwVnNW92ZHUIr0V0`, Coastal_Zone_Polygon) | California public record | The certified Coastal Zone Boundary maps (Pub. Res. Code §30103) |
| `fhszSra` | CAL FIRE, Fire Hazard Severity Zones in the State Responsibility Area (`services1.arcgis.com/jUJYIo9tSA7EHvfZ`, FHSZSRA_23_3) | California public record | The adopted SRA map (Gov. Code §51178; 14 CCR §1280) |
| `fhszLra` | CAL FIRE (Office of the State Fire Marshal), Fire Hazard Severity Zones in the Local Responsibility Area, map of March 24, 2025 (same org, FHSALRA25_v1_All) | California public record | The local agency's adopting ordinance (Gov. Code §51179) |
| `criticalHabitat` | U.S. Fish and Wildlife Service, final critical habitat (`services.arcgis.com/QVENGdaPbd4LUkLV`, USFWS_Critical_Habitat) | U.S. Government work, public domain | The Federal Register designation (50 CFR Part 17) |
| `airports` | Caltrans Division of Aeronautics, Airport Boundaries (`caltrans-gis.dot.ca.gov`, CHaviation/Airport_Boundaries) | California public record | The Airport Land Use Compatibility Plan for the airport |

## What was done to the data

Only the attributes the reading application uses are kept (`lib/layers.mjs`). Polygons are
simplified with a Douglas-Peucker tolerance of 0.000005 degrees (about 0.5 m; critical habitat
0.00001 degrees, about 1 m), coordinates rounded to 6 decimals, and each polygon is clipped
into the 0.1 degree tiles it touches, each tile carrying a 0.025 degree margin. The build holds
any layer whose area moves more than 0.5% under simplification.

## How the application must cite it

Every fact built from these tiles names the layer, the agency's date and CCE's check date, for
example:

> California Geological Survey, Seismic Hazard Zones (liquefaction), as published 2025-11-19
> (CCE copy checked 2026-10-23)

`sourceLabel(vintage)` in `reader.mjs` builds that string. A report must never call the data
"live" or "current", and it keeps each layer's official-map disclaimer: the tiles are a
screening copy, not the official map.

The code in this repository (everything outside the published tiles) is the property of
Central Coast Economics.
