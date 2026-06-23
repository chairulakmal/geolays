# geolays

A frontend-heavy B2B geo-data dashboard, built to learn the specific skills a real-estate geo-intelligence product actually needs from a frontend engineer. This is a **learning spike, not a portfolio piece** — scope is intentionally narrow and time-boxed. Backend is a thin Phoenix data server; almost all the interesting work happens in Vue.

## Quickstart (dev)

**Prerequisites:** Node 24 + npm, Elixir 1.17 / Erlang OTP 27 (with Hex: `mix local.hex`).

Run each app in its own terminal:

```bash
# Backend — Phoenix JSON API → http://localhost:4000
cd backend
mix setup          # fetch + compile deps (first run only)
mix phx.server

# Frontend — Nuxt app → http://localhost:3000
cd frontend
npm install        # first run only
npm run dev
```

Open <http://localhost:3000>: a full-screen MapLibre map over Tokyo with a green
**API: ok** badge (confirms the frontend reached the backend through CORS).

The frontend reads the backend URL from `runtimeConfig.public.apiBase` (default
`http://localhost:4000`); override with `NUXT_PUBLIC_API_BASE`. The backend's allowed
CORS origins come from `CORS_ORIGINS` (default `http://localhost:3000`).

## Why this exists

A B2B real-estate geo-intelligence product combines geographic data with other sources for real estate professionals. That implies a different skill set than a typical consumer app:

- Power users staring at dense data all day, not casual browsers
- Maps as the primary UI, not a secondary feature
- Multiple data sources that need to be merged, normalized, and degrade gracefully
- Heavy, frequent queries (pan/zoom/filter) that need to feel instant

This project picks one thin vertical slice through each of those problems and builds just enough to demonstrate it concretely.

## Learning-first: how this repo is written

This is a **learning project**, so the code and docs are deliberately over-explained. The
goal is not just working software — it's a clear written rationale for every non-obvious
choice. Conventions:

- **Explain the "why", not the "what".** Comments and docs justify decisions (why debounce
  at this interval, why normalize on the backend, why window the list) — they don't restate
  what the code obviously does.
- **Best practices and traps are called out explicitly.** Where a Vue/Nuxt pattern has a
  common pitfall (reactivity loss, SSR hydration, lifecycle leaks), the code comments name
  the trap and the fix. The catalogue of these lives in `CLAUDE.md` so it isn't repeated.
- **Don't duplicate explanations.** Each concept is explained once, in one canonical place,
  and linked from elsewhere. Data sources are explained here; implementation conventions and
  Vue/Nuxt patterns live in `CLAUDE.md`. If you find yourself re-explaining, link instead.

## Stack

- **Frontend:** Nuxt 4 (Vue 3 Composition API, TypeScript)
- **Map:** MapLibre GL JS — chosen over Mapbox to avoid a token/billing; APIs are near-identical so the fundamentals carry over
- **State:** Pinia (shared cross-component query state — viewport, filters, layer toggles)
- **Virtualized list:** `@tanstack/vue-virtual`
- **Backend:** Phoenix (Elixir), JSON API only — no business logic, just serves/proxies/normalizes datasets
- **Data sources:** open datasets only (see below)
- **Deploy:** Railway (Railpack builder, consistent with other projects)

Repo is a monorepo: `/frontend` (Nuxt) and `/backend` (Phoenix), talking over HTTP/JSON.
See `CLAUDE.md` for the implementation guide (decisions, build order, conventions).

### Tech stack summary

Concrete versions as scaffolded (the prose above covers the *why*; this is the quick reference).

| Area | Choice | Version | Role |
|---|---|---|---|
| Runtime (frontend) | Node.js + npm | Node 24, npm 11 | Build/dev toolchain for Nuxt |
| Framework (frontend) | Nuxt | 4.4 | Vue 3.5 app, Composition API + `<script setup>`, TypeScript |
| Map | MapLibre GL JS | 5.x | WebGL map — sources/layers, no token |
| State | Pinia + `@pinia/nuxt` | 3.x / 0.11 | Shared query state (viewport, filters, layer toggles) |
| Virtualized list | `@tanstack/vue-virtual` | 3.x | Windowed side-panel list synced to the viewport |
| Runtime (backend) | Erlang/OTP + Elixir | OTP 27, Elixir 1.17 | BEAM runtime for Phoenix |
| Framework (backend) | Phoenix | 1.8 | JSON API only (`--no-ecto --no-html --no-assets`) |
| HTTP server | Bandit | 1.x | Phoenix's web server |
| CORS | `cors_plug` | 3.x | Allows the browser frontend to call the API cross-origin |
| Data store | _none_ | — | No DB — static GeoJSON from `priv/` (all three layers precomputed/ingested + committed) |
| Deploy | Railway | — | Railpack builder (never Nixpacks) |

**Data sources:** Open-Meteo (weather, precomputed static climatology) + MLIT 国土数値情報 land price (bulk GeoJSON) + OSM building footprints (polygons via Overpass); e-Stat population mesh is a stretch. Detailed below.

## Open datasets to mirror real-estate geo-intelligence data layers

Pick 2–3 to keep scope sane. Don't try to integrate all of these. **Chosen for the
spike (✓):** Open-Meteo weather + MLIT land price. e-Stat population mesh is a stretch
goal only if the first two are solid and time remains. Region is Tokyo throughout.

| Layer | Candidate source | Mirrors | Status |
|---|---|---|---|
| Parcels / administrative boundaries | Japan e-Stat / MLIT national land numerical info | zoning-style polygon layer | skipped |
| Weather/temperature | Open-Meteo API (free, no key) | "other source" overlay | ✓ chosen |
| Population/demographics | e-Stat census mesh data | demographics layer | stretch |
| Land price | MLIT 国土数値情報 land price data | pricing layer | ✓ chosen |
| Building footprints | OSM via Overpass API (polygon layer) | polygon rendering at scale | ✓ chosen |

All of these are public/open and Tokyo-relevant.

### Data sources in detail

Understanding the *shape and quirks* of each source is half the point — the real work
is merging messy, heterogeneous data. This section is the narrative (*why* each source); for
the technical pipeline (exact formats, field mappings, transforms, endpoints) see
**[DATA.md](DATA.md)**.

#### Open-Meteo (weather/temperature) — ✓ chosen

- **What:** Free public weather API. No API key, no signup, generous rate limits.
- **Access:** Archive REST API — `https://archive-api.open-meteo.com/v1/archive`, variable
  `temperature_2m_mean`. We used the live endpoint initially; see below for why we switched.
  Docs: <https://open-meteo.com/en/docs>.
- **Shape:** Per-point JSON — *not* geospatial out of the box. We geo-enable it by building a
  mainland-Tokyo grid, fetching each point, and assembling a GeoJSON `FeatureCollection` with
  temperature in `properties`. That grid is **precomputed once** (2022–2024 summer mean, 139
  points) and committed to `priv/` — see `DATA.md §1` for the full pipeline.
- **Why chosen:** Represents the "non-geographic source we must geo-enable and normalize" case.
  The normalization lesson (isolate upstream quirks in one backend module, emit the shared
  contract) is identical whether the fetch is live or precomputed.
- **Why precomputed, not live:** Live current-temp barely varies across Tokyo (~1°C spread,
  not interesting to display) and the free tier rate-limits heavy grid calls. A stable
  climatology is more representative to display and never 502s. The "live API going slow/down"
  scenario for problem #7 uses the land-price proxy toggle instead.
- **Trap to note:** `[lon, lat]` vs spoken "lat, lon" — GeoJSON geometry coordinates are
  longitude-first, opposite of how we say them. Easy to flip and get points in the ocean.
  Also: a newly-added Elixir dep does **not** hot-load into a running BEAM.

#### MLIT 国土数値情報 land price (pricing layer) — ✓ chosen

- **What:** National Land Numerical Information (国土数値情報) from Japan's MLIT — the
  official land price datasets (地価公示 / 都道府県地価調査): government-appraised price
  points with price per m², address, and land-use category.
- **Access:** *Bulk download*, not a live API — Shapefile/GeoJSON per prefecture from
  <https://nlftp.mlit.go.jp/ksj/>. Download Tokyo once, convert to GeoJSON if needed, and
  serve the static file from the Phoenix backend (`priv/`).
- **Shape:** Already geospatial — a `FeatureCollection` of point features. Light enough to
  serve whole, but big enough to make the virtualized list (problem #1) meaningful.
- **Why chosen:** Represents the "static, already-geographic, bulk dataset" case — the
  counterpart to Open-Meteo. Together the two show normalizing *two different shapes* into
  one internal contract (problem #5), and a real price field to filter on (problem #4).
- **Trap to note:** Japanese field names and encodings (Shift-JIS in some MLIT files). Part
  of the lesson is normalizing these into clean English property keys on the backend.

#### OSM building footprints (polygon layer) — ✓ chosen

- **What:** OpenStreetMap building footprint polygons for the **Shinjuku ward (新宿区) core**,
  fetched from the Overpass API. Equivalent geometry to MLIT PLATEAU LOD0 (2D footprints).
  Up to **~8k** `Polygon` features (capped at 8,000 in the ingest) over the bbox
  `35.677,139.685,35.715,139.745` — a small, dense central-Tokyo box, deliberately scoped.
- **Access:** Overpass API, no key (the ingest tries three public mirrors and uses the first
  that responds — the main `overpass-api.de` host 406s in some networks). See
  `priv/data/buildings.ingest.mjs` for the query; `DATA.md §3` for the full pipeline.
  For production, replace with PLATEAU GeoJSON from `https://www.geospatial.jp/ckan/dataset`
  (larger coverage, official source, same pipeline structure).
- **Shape:** GeoJSON `FeatureCollection` of `Polygon`s. Properties: `building` type,
  `name`, `name_en`, `height` (metres), `levels` (floor count), all nullable except `building`.
- **Why chosen:** The first polygon layer — both prior layers are points. Polygons unlock
  `fill` + `fill-extrusion` layers and make the GeoJSON-ceiling question concrete: at
  ~8k features you can feel the parse time vs. the point layers. At 50k+ features (full
  23 wards), you'd switch to `tippecanoe` → PMTiles and a `vector` source type in
  MapLibre. This layer is sized to sit at that boundary deliberately (problem #3) — the
  first ingest against a wider bbox returned 207k features (~150 MB), which is exactly the
  ceiling this layer exists to demonstrate.
- **Trap to note:** Overpass coordinates are `{lat, lon}` objects; GeoJSON `Polygon`
  rings want `[lon, lat]` arrays — longitude first, opposite of Overpass convention
  (and of spoken "lat, lon"). Flip them in the ingest, or buildings appear in the ocean.
  Also: GeoJSON rings must be closed (last coord equals first coord).

#### e-Stat census population mesh (demographics) — stretch only

- **What:** Population/demographics from e-Stat (Japan's official statistics portal),
  published as **mesh** data — values attached to a regular grid of polygons.
- **Access:** API with a free key (<https://www.e-stat.go.jp/>), or bulk mesh downloads.
- **Shape:** Many small **polygons** (the grid cells) — a much heavier geometry set than the
  point layers above.
- **Why stretch, not core:** It's the ideal vehicle for problem #3 (polygon-set rendering
  performance, vector tiles vs. GeoJSON, clustering at low zoom) — but only worth adding once
  the two point layers are solid, because polygon volume introduces real perf work.

## Core problems this project is built to answer

### 1. Large dataset rendering
Render hundreds–thousands of rows/parcels without jank.
- Virtualized table (e.g. `@tanstack/vue-virtual` or similar) for a side-panel list view synced to the map viewport
- Goal: explain trade-offs between windowing the DOM vs. canvas/WebGL rendering for huge lists

### 2. Map integration
- Mapbox GL JS / MapLibre fundamentals: sources, layers, fitBounds, clustering
- Goal: a clear, repeatable pattern for adding a new data layer to a map

### 3. Multi-layer overlay performance
- Toggle 2–3 data layers (e.g. land price + population mesh + weather) on/off independently
- Investigate: layer ordering, opacity, clustering at low zoom, vector tiles vs. GeoJSON for large polygon sets
- Goal: articulate *why* performance degrades with naive GeoJSON-everything approaches and what fixes it

### 4. State management for filter-heavy UIs
- Composable-based filter state (price range, data layer toggles, date/time for weather) that stays in sync with the map and the list view
- Goal: demonstrate a clean Pinia or composable pattern for shared, cross-component query state — not prop drilling

### 5. Merging/normalizing multiple sources
- Phoenix backend proxies 2+ open APIs (e.g. Open-Meteo + e-Stat) and returns a normalized shape
- Goal: explain where normalization should live (backend vs. frontend) and why — a core geo-intelligence architecture question

### 6. Caching + debouncing expensive queries
- Debounce/throttle map pan & zoom before firing new data requests
- Simple client-side cache (in-memory, keyed by bounding box + zoom) to avoid refetching the same viewport
- Goal: a concrete implementation of request cancellation (AbortController), debounce intervals, and stale-while-revalidate patterns

### 7. Graceful degradation
- Simulate one data source being slow/down (artificial delay or error in the Phoenix proxy) and show the UI handling it — partial render, retry, visible source-level error state, rest of the app stays usable
- Goal: a working example of "what happens when one data source fails" rather than a hypothetical

## Explicit non-goals

- No auth, no user accounts
- No deployment polish — Railway deploy is enough to say "it's live," not to make it production-grade
- No exhaustive dataset coverage — 2–3 layers is enough to demonstrate the *pattern*

## Definition of done

This project is "done" when each of the 7 problems above is demonstrable with a specific implementation detail from this codebase — not in general terms. Once that holds, the scope is complete: ship what exists rather than gold-plating it.