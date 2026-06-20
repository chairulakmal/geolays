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

## 3. Tokyo boundary (support data, not a layer)

| | |
|---|---|
| **Origin** | Japan prefecture boundaries — dataofjapan/land `japan.geojson`, feature id 13 (東京都) |
| **Raw format** | GeoJSON `MultiPolygon`, 80 rings (mainland + Izu/Ogasawara islands) |
| **Changes** | Kept only **mainland** polygons (bbox gate drops islands) → `MultiPolygon` (13 rings) |
| **Stored** | `backend/priv/data/tokyo_mainland.geojson` (committed) |
| **Used by** | the weather ingest, to clip grid points (step 2 above). Not served to the frontend. |

## 4. Basemap (frontend only, not stored)

CARTO Positron raster tiles (`*.basemaps.cartocdn.com/light_all/...`); attribution
"© OpenStreetMap contributors © CARTO". A muted base so the data overlays read clearly.

---

## Frontend

The frontend applies **no data transformations** — it fetches each layer's normalized
`FeatureCollection` and hands it straight to MapLibre. All map appearance (colour ramps,
the temperature "cloud", log-scaled price colours) is *styling*, not data changes.
