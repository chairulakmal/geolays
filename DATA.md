# Data sources & pipeline

Canonical reference for **where each dataset comes from, its raw format, and every
transformation we apply** before it reaches the frontend. The README's "Data sources"
section covers *why* each source was chosen (the narrative); this file is the *how*.

**Principles** (see CLAUDE.md):
- The backend either proxies a live source or serves a static file from `backend/priv/data/`.
  There is no database.
- All **normalization happens on the backend**. Every served layer reaches the frontend in one
  shape — a GeoJSON `FeatureCollection` of `Point`s — so the frontend does zero reshaping.
- Static files are cached in memory and revalidated by file mtime (`Backend.GeoJsonFile`), so
  editing a data file is picked up on the next request without a server restart.

---

## 1. Weather — average summer temperature

| | |
|---|---|
| **Origin** | Open-Meteo Historical (archive) API — `https://archive-api.open-meteo.com/v1/archive`, variable `temperature_2m_mean` |
| **License** | Weather data by Open-Meteo.com (CC BY 4.0) |
| **Raw format** | JSON; one object per location (array for multiple coords), each with `daily.time[]` + `daily.temperature_2m_mean[]` |
| **Stored** | `backend/priv/data/weather_summer_avg_tokyo.geojson` (committed, 139 features) |
| **Served by** | `Backend.Weather` → `GET /api/layers/weather` |

**Why precomputed:** live current-temp barely varies across Tokyo and the free API rate-limits
frequent calls (502s). We compute a stable climatology once and commit the result.

**Pipeline** — `backend/priv/data/weather_summer_avg.ingest.mjs` (re-run: `node weather_summer_avg.ingest.mjs`):
1. Build a grid over mainland-Tokyo bbox (lon 138.94–139.92, lat 35.50–35.90). Longitude step
   `0.04°`; latitude step `= 0.04° × cos(meanLat)` so points are spaced **equally in screen
   pixels** (Web Mercator stretches lat vs lon) → the frontend cloud overlaps evenly.
2. **Clip** the grid to Tokyo: keep only points inside `tokyo_mainland.geojson` (ray-casting
   point-in-polygon). 139 points remain.
3. Fetch `temperature_2m_mean` for **summers (Jun–Aug) of 2022, 2023, 2024** (one request/year).
4. **Average** all summer daily means per point; round to 1 dp.
5. Emit GeoJSON `FeatureCollection` of `Point`s (`[lon, lat]`).

**Output contract** (`properties`): `temperature` (°C, float), `unit` (`"celsius"`),
`metric` (`"summer_avg_2022_2024"`). Served as-is (no backend transform; just load + cache).

## 2. Land price — MLIT 国土数値情報 (地価公示 / L01)

| | |
|---|---|
| **Origin** | MLIT National Land Numerical Information, Land Price L01, 令和5年 (2023), Tokyo (pref code 13). `https://nlftp.mlit.go.jp/ksj/gml/data/L01/L01-23/L01-23_13_GML.zip` (the `.geojson` inside the GML zip) |
| **License** | 国土数値情報（地価公示データ）国土交通省 — KSJ terms: <https://nlftp.mlit.go.jp/ksj/other/yakkan.html> |
| **Raw format** | UTF-8 GeoJSON `FeatureCollection`, 2,602 `Point`s. Properties are **opaque coded fields** `L01_001`…`L01_141` |
| **Stored** | `backend/priv/data/land_price_tokyo_L01-23_13.geojson` (committed **unchanged**, ~8 MB) |
| **Served by** | `Backend.LandPrice` → `GET /api/layers/land-price` |

**Changes:** the raw file is committed untouched; `Backend.LandPrice` normalizes per request
(cached) — maps the few coded fields we use into clean keys and **drops the other ~134**:

| Raw (MLIT) | Normalized key | Notes |
|---|---|---|
| `L01_006` | `price_per_sqm` | yen / m² (current year) |
| `L01_007` | `change_pct` | YoY % change |
| `L01_028` | `use` | 利用現況 (Japanese value kept) |
| `L01_050` | `zoning` | 用途地域 |
| `L01_023` | `ward` | |
| `L01_024` | `address` | full-width space `　` → normal space, trimmed |
| `L01_005` | `year` | survey year |

**Output contract** (`properties`): `price_per_sqm`, `change_pct`, `use`, `zoning`, `ward`,
`address`, `year`.

## 3. Building footprints — OSM via Overpass (polygon layer)

| | |
|---|---|
| **Origin** | OpenStreetMap, via the Overpass API. Building `way` geometries for the **Shinjuku ward (新宿区) core** — bbox `35.677,139.685,35.715,139.745` (S,W,N,E). A small, dense central-Tokyo box, deliberately scoped (see "Why this bbox" below). |
| **License** | OpenStreetMap contributors, ODbL 1.0 |
| **Raw format** | Overpass JSON with `out geom` — each `way` element contains inline `{lat, lon}` node coordinates. No secondary node-lookup pass needed. |
| **Stored** | `backend/priv/data/buildings_tokyo.geojson` (committed after running ingest; up to **8,000** `Polygon` features — capped by `LIMIT` in the ingest) |
| **Served by** | `Backend.Buildings` → `GET /api/layers/buildings` (optional `?bbox=west,south,east,north`, filtered by polygon centroid) |

**Why OSM, not PLATEAU:** Both cover 2D building footprints (LOD0 equivalent). OSM is automatable — no manual download step, free with no key. For a production dataset, replace with PLATEAU GeoJSON from `https://www.geospatial.jp/ckan/dataset` (larger coverage, official source, same pipeline).

**Pipeline** — `backend/priv/data/buildings.ingest.mjs` (re-run: `node buildings.ingest.mjs`):
1. POST an Overpass query for `way["building"]` within the Shinjuku-core bbox `35.677,139.685,35.715,139.745` (Overpass bbox order is `south,west,north,east` — lat before lon, the opposite of GeoJSON).
2. The query is `way["building"](<bbox>); out 8000 geom;` — `out geom` attaches each node's `{lat, lon}` inline, so there's no second node-lookup pass; `8000` is the `LIMIT` cap (see "Why the cap" below).
3. Convert each way to a GeoJSON `Polygon` Feature: map `{lat, lon}` → `[lon, lat]` (GeoJSON is lon-first), and close the ring if the last coord ≠ the first.
4. Normalize properties: keep `building`, `name`, `name_en`, `height` (metres), `levels` (floor count); drop raw OSM metadata. Note the ingest also writes `osm_id`/`id`, which `Backend.Buildings` then drops on serve.
5. Write as a single `FeatureCollection`.

**Endpoint fallback:** the ingest tries three Overpass mirrors in order (`overpass.kumi.systems`, `lz4.overpass-api.de`, `overpass-api.de`) and uses the first that succeeds — the main `overpass-api.de` host returns 406 in some network environments.

**Why this bbox + Why the cap:** the first run used a broader central-Tokyo bbox and returned **206,971** features (~150 MB of GeoJSON) — concrete proof of the GeoJSON ceiling: even a pre-cached payload that large freezes the browser's main thread on `setData`. Two responses: (1) narrow the committed dataset to the Shinjuku-core bbox and cap it at `LIMIT = 8000` features, and (2) have the frontend fetch buildings per-viewport (debounced + cached, same pattern as land price) rather than loading the whole file at once. For the full 23 wards the correct path is `tippecanoe → PMTiles → MapLibre vector source` (set `LIMIT = Infinity`, tile the output). See `NOTES.md §3`.

**Output contract** (`properties`): `building` (string, e.g. `"yes"`, `"residential"`, `"commercial"`), `name` (nullable), `name_en` (nullable), `height` (metres, nullable), `levels` (integer, nullable).

**Performance note:** At up to ~8k polygon features, GeoJSON works but you can measure the parse cost on first load. At 50k+ features (full 23 wards), the right move is `tippecanoe` → PMTiles and a `vector` source type in MapLibre instead of `geojson`. This layer is intentionally sized to sit at the GeoJSON-ceiling boundary — large enough to demonstrate the concern, small enough to keep the demo snappy.

## 4. Tokyo boundary (support data, not a layer)

| | |
|---|---|
| **Origin** | Japan prefecture boundaries — dataofjapan/land `japan.geojson`, feature id 13 (東京都) |
| **Raw format** | GeoJSON `MultiPolygon`, 80 rings (mainland + Izu/Ogasawara islands) |
| **Changes** | Kept only **mainland** polygons (bbox gate drops islands) → `MultiPolygon` (13 rings) |
| **Stored** | `backend/priv/data/tokyo_mainland.geojson` (committed) |
| **Used by** | the weather ingest, to clip grid points (step 2 above). Not served to the frontend. |

## 5. Basemap (frontend only, not stored)

CARTO Positron raster tiles (`*.basemaps.cartocdn.com/light_all/...`); attribution
"© OpenStreetMap contributors © CARTO". A muted base so the data overlays read clearly.

---

## Frontend — how MapLibre consumes each layer

The frontend applies **no data transformations** — it fetches each layer's normalized
`FeatureCollection` (already in our one contract) and hands it straight to MapLibre. All
map appearance (colour ramps, the temperature "cloud", log-scaled price colours) is
*styling*, not data changes. The end-to-end shape of each layer is therefore:

> raw upstream → backend normalization (above) → `GET /api/layers/*` → MapLibre `source` →
> MapLibre `layer` + paint expression → pixels.

Every layer uses a `geojson` **source type** (not `vector`) — see the GeoJSON-vs-vector-tiles
trade-off at the end. The presentation lives in `frontend/app/components/MapView.client.vue`;
the Vue/Nuxt patterns behind it (reactivity, lifecycle, debounce) are catalogued in
`CLAUDE.md` and the per-problem implementation notes in `NOTES.md` — **linked, not restated** here.

### Weather → `circle` layer rendered as a blurred "cloud"

- **Layer type:** `circle` (id `weather-cloud`), *not* `heatmap`. We want one translucent
  blob per grid point, sized in screen pixels, that blends with its neighbours.
- **Paint:** large `circle-radius` interpolated by zoom (`30px` at z9 → `480px` at z13),
  `circle-blur: 1`, `circle-opacity: 0.4`. The blur + overlap is what turns 139 discrete
  points into a continuous temperature field — hence the grid in `§1` is spaced *equally in
  screen pixels* so the blobs overlap evenly.
- **Colour encoding:** `circle-color` is data-driven on `temperature`, but the colour stops
  are **stretched to the actual min/max of the fetched data**, not a fixed 0–32 °C scale.
  Intra-Tokyo summer variation is only ~1–2 °C; a fixed scale would paint every point the
  same colour. The same domain drives the on-map legend, so legend and map can't drift.
- **Fetch model:** loaded **once** on map load (139 points is trivial), then re-fetchable for
  retry / fault injection (problem #7). This is the only layer with a fault-injection path.

### Land price → `circle` layer, price encoded by radius *and* colour

- **Layer type:** `circle` (id `land-price-points`).
- **Paint:** both `circle-radius` and `circle-color` are data-driven on `price_per_sqm`, so
  expensive parcels read as large dark-red dots and cheap ones as small green dots — price is
  legible even where points overlap.
- **Why log-spaced colour stops:** Tokyo land price spans ~¥1.5k–¥54M/m². A *linear* ramp
  would collapse ~90% of points into the cheapest colour, so the stops are spaced
  geometrically (`¥100k, ¥300k, ¥500k, ¥1M, ¥2M, ¥5M, ¥20M`). The price-range *slider* in
  `ControlPanel.vue` is log-scaled for the same reason.
- **Interactivity:** the price filter is applied with MapLibre `setFilter` (a render-time
  expression), so filtering hides/shows points with **no refetch and no data round-trip**.
  The synced side-panel list (`FeatureList.vue`, problem #1) is populated from
  `queryRenderedFeatures`, which already respects the active `setFilter`.
- **Fetch model:** fetched **per viewport** — `GET /api/layers/land-price?bbox=…`, debounced
  300 ms, cancelled with `AbortController`, and cached client-side by `bbox+zoom` (problem #6).

### Buildings → `fill` layer (the first polygon layer)

- **Layer type:** `fill` (id `buildings-fill`), inserted **before** the two circle layers so
  the polygon fills render *underneath* the point overlays (MapLibre draws layers in
  insertion order).
- **Paint:** flat muted grey (`fill-color: #c9c5bd`, `fill-opacity: 0.65`) with
  `fill-outline-color` for the building edges — the outline paint property avoids needing a
  separate `line` layer. Building data is *not* yet visually encoded; height/levels are
  carried in properties so a future `fill-extrusion` layer can drive `fill-extrusion-height`.
- **Default off:** the toggle starts hidden so the initial map load stays fast; the user opts
  in to feel the polygon parse cost vs. the point layers (problem #3).
- **Fetch model:** fetched **per viewport** with the same debounce + abort + cache pattern as
  land price, *not* loaded whole — see "Why this bbox + Why the cap" in `§3`.

### Basemap

CARTO Positron raster tiles as a single `raster` source/layer (see `§5`) — a muted base so
the data overlays read clearly.

### Trade-off threaded through all three: GeoJSON source vs. vector tiles

All layers use a `geojson` source because at these sizes (139 / 2,602 / ≤8,000 features)
MapLibre parses and GPU-renders them comfortably, and `setData` / `setFilter` stay simple.
The buildings layer is deliberately sized at the boundary where this stops scaling: at 50k+
features the right move is `tippecanoe → PMTiles` and a `vector` source type, so MapLibre
requests only the tiles in view and simplifies geometry at low zoom. Nothing on the frontend
changes but the source type and the `pmtiles://` URL. See `§3` and `NOTES.md §3`.
