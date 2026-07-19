# geolays

A frontend-heavy geo-data dashboard for Tokyo: a Nuxt 4 + MapLibre GL client over a thin Phoenix JSON API, built as a deliberately time-boxed learning spike around seven engineering problems a real-estate geo-intelligence frontend actually faces. Its distinctive hook: three open datasets of three different shapes (a non-geospatial weather API, government land-price points, OSM building polygons) all reach the browser as one normalized GeoJSON contract, and the polygon layer is intentionally sized at the point where GeoJSON stops scaling. Below: the highlights, the stack, how to run it locally, the seven problems, the data-source narrative, how the repo is written, and the scope; [ARCHITECTURE.md](ARCHITECTURE.md) walks the design decisions.

## Highlights

- The weather layer is not a point layer but a pre-rendered raster. [backend/priv/data/weather_summer_avg.ingest.mjs](backend/priv/data/weather_summer_avg.ingest.mjs) builds a Tokyo grid spaced equally in screen pixels (the latitude step is scaled by the cosine of the mean latitude to undo Web Mercator stretch), clips it to the mainland polygon by ray casting, averages three summers of Open-Meteo archive data, interpolates a 512x256 IDW field, and encodes the PNG with nothing but Node's built-in zlib. MapLibre displays it as an `image` source, so the temperature field is continuous at every zoom with no dot artefacts.
- The GeoJSON ceiling was discovered empirically, then designed around. The first buildings ingest returned 206,971 features (~150 MB of GeoJSON), so [backend/priv/data/buildings.ingest.mjs](backend/priv/data/buildings.ingest.mjs) caps the committed dataset at 8,000 Shinjuku-core polygons and the frontend fetches buildings per viewport instead of loading the file whole. The path to full-Tokyo scale (tippecanoe to PMTiles to a MapLibre `vector` source) is written down in [DATA.md](DATA.md), not hand-waved.
- Normalization lives in the backend, one module per source. The raw 8 MB MLIT land-price file is committed byte-for-byte, and [backend/lib/backend/land_price.ex](backend/lib/backend/land_price.ex) maps its opaque coded fields (`L01_006` to `price_per_sqm`) into a clean documented contract at serve time, dropping the ~134 fields the frontend never needs. All three source modules share [backend/lib/backend/geojson_file.ex](backend/lib/backend/geojson_file.ex), a `:persistent_term` cache keyed by file mtime, so an edited data file is picked up on the next request without a restart.
- Pan and zoom are treated as expensive queries. A `watch` with `onCleanup` in [frontend/app/components/MapView.client.vue](frontend/app/components/MapView.client.vue) debounces the viewport bbox by 300 ms, aborts the in-flight request with an `AbortController`, and consults an in-memory cache keyed by rounded bbox plus zoom; the price filter is a MapLibre `setFilter` expression, so filtering hides and shows points with no refetch at all.
- The map, the control panel, and the list are siblings with zero props or events between them; the single Pinia store [frontend/app/stores/query.ts](frontend/app/stores/query.ts) is the only channel. The side panel ([frontend/app/components/FeatureList.vue](frontend/app/components/FeatureList.vue)) windows the visible features with `@tanstack/vue-virtual` and is fed by `queryRenderedFeatures`, so the list always agrees with what the GPU actually drew.
- Failure is a per-source state, not a global one. The weather endpoints accept `?fault=error|delay` ([backend/lib/backend_web/controllers/weather_controller.ex](backend/lib/backend_web/controllers/weather_controller.ex)), and the UI shows a per-source status dot and a retry button while the land-price layer stays fully interactive; on error the raster resets to a transparent placeholder instead of showing stale data.
- Every non-obvious Vue/Nuxt pattern in the code cites a numbered entry in [TRAPS.md](TRAPS.md), an 11-trap catalogue (reactivity loss, SSR/hydration, lifecycle leaks, template-ref timing) that doubles as the project's interview notes. The per-problem record of what was built and why is [NOTES.md](NOTES.md).

## Stack

| Layer | What the code pins |
|---|---|
| Frontend | Nuxt 4.4.8, Vue 3.5.38, TypeScript, Pinia 3.0.4 (@pinia/nuxt 0.11.3) |
| Map | MapLibre GL JS 5.24.0, no token; CARTO Positron raster basemap |
| Virtualized list | @tanstack/vue-virtual 3.13.29 |
| API | Phoenix 1.8.8 on Bandit 1.12, Elixir (`~> 1.15` in mix.exs, developed on 1.17 / OTP 27), cors_plug 3.0.3, Req 0.6.2 |
| Data store | None. Committed GeoJSON and PNG in [backend/priv/data/](backend/priv/data), cached in `:persistent_term` |
| Deploy | Railway with the Railpack builder ([backend/railway.json](backend/railway.json), [frontend/railway.json](frontend/railway.json)) |

## Running locally

Prerequisites: Node 24 + npm, Elixir 1.17 / Erlang OTP 27 (with Hex: `mix local.hex`).

```bash
# 1. Backend: Phoenix JSON API on :4000
cd backend
mix setup          # fetch deps (first run only)
mix phx.server

# 2. Frontend: Nuxt app on :3000, in a second terminal
cd frontend
npm install        # first run only
npm run dev
```

Open [localhost:3000](http://localhost:3000): a full-screen MapLibre map over Tokyo with a green **API: ok** badge (confirms the frontend reached the backend through CORS). The frontend reads the backend URL from `runtimeConfig.public.apiBase` (default `http://localhost:4000`); override with `NUXT_PUBLIC_API_BASE`. The backend's allowed CORS origins come from `CORS_ORIGINS` (default `http://localhost:3000`).

## The seven problems

The project's definition of done: each problem below is demonstrable with a specific implementation detail from this codebase, not in general terms. The per-problem record (mechanism, trade-off, trap avoided) lives in [NOTES.md](NOTES.md); this list is the map.

1. **Large dataset rendering.** A side-panel list of the features in the viewport, windowed with `@tanstack/vue-virtual` so thousands of rows never hit the DOM. ([NOTES.md §1](NOTES.md))
2. **Map integration.** The Mapbox GL fundamentals, via MapLibre: sources, layers, layer ordering, and a repeatable pattern for adding a data layer. ([NOTES.md §2](NOTES.md))
3. **Multi-layer overlay performance.** Three independently toggleable layers of three geometry types (raster, circles, polygon fills), and the GeoJSON-vs-vector-tiles trade-off made concrete. ([NOTES.md §3](NOTES.md))
4. **State management for filter-heavy UIs.** One Pinia store as the shared source of truth for viewport, toggles, and filters; no prop drilling. ([NOTES.md §4](NOTES.md))
5. **Merging/normalizing multiple sources.** Backend modules normalize heterogeneous upstreams into one GeoJSON contract; the frontend does zero reshaping. ([NOTES.md §5](NOTES.md))
6. **Caching + debouncing expensive queries.** Debounced bbox fetches, `AbortController` cancellation, and an in-memory viewport cache. ([NOTES.md §6](NOTES.md))
7. **Graceful degradation.** Backend fault injection plus per-source error state and retry, so one broken feed never takes down the dashboard. ([NOTES.md §7](NOTES.md))

## Data sources

Region is Tokyo throughout. Each source was picked to represent a different shape of upstream; the full pipeline (formats, field mappings, transforms, endpoints) is in [DATA.md](DATA.md), one section per source. Why each one:

- **Open-Meteo weather (chosen)**: a free per-point JSON API that is not geospatial out of the box, so it represents the "geo-enable and normalize a non-geographic source" case. Precomputed as a 2022-2024 summer climatology rather than fetched live, because live current-temp barely varies across Tokyo and the free tier rate-limits grid calls. ([DATA.md §1](DATA.md))
- **MLIT 国土数値情報 land price (chosen)**: the official 地価公示 appraisal points, a bulk-download dataset that is already geospatial but hides its meaning behind coded field names, so it represents the "static bulk file that needs field normalization" case. 2,602 points with a real price field to filter on. ([DATA.md §2](DATA.md))
- **OSM building footprints via Overpass (chosen)**: the first polygon layer, up to 8,000 Shinjuku-core footprints, deliberately sized to sit at the GeoJSON performance boundary. For production you would swap in PLATEAU data; the pipeline shape is identical. ([DATA.md §3](DATA.md))
- **e-Stat census population mesh (stretch, not built)**: the ideal heavy-polygon vehicle for vector-tile work, but only worth adding once the core layers are solid.

A classic quirk threads through all of them: GeoJSON coordinates are `[lon, lat]`, the opposite of spoken "lat, lon" and of Overpass's `{lat, lon}` objects. Flip them in the ingest or every feature lands in the ocean.

## Learning-first: how this repo is written

This is a learning project, so the code and docs are deliberately over-explained: comments justify decisions (why this debounce interval, why normalize on the backend) rather than restating what the code does, and each concept is explained once in one canonical home. Data narrative here, pipeline in [DATA.md](DATA.md), per-problem notes in [NOTES.md](NOTES.md), Vue/Nuxt patterns in [TRAPS.md](TRAPS.md), implementation conventions in [CLAUDE.md](CLAUDE.md). If something re-explains, it links instead.

## Explicit non-goals

- No auth, no user accounts
- No deployment polish. A Railway deploy is enough to say "it's live," not to make it production-grade
- No exhaustive dataset coverage. Three layers is enough to demonstrate the pattern

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) walks the six decisions that carry the codebase, each with the choice, the reasoning, and the trade-off accepted: one normalized GeoJSON contract with backend-side normalization, precomputed datasets over live proxying, a single Pinia store with MapLibre kept imperative, debounce-abort-cache viewport fetching, a buildings layer parked at the GeoJSON ceiling on purpose, and per-source failure handling.
