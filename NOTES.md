# Implementation notes — concrete details per problem

Per-problem record of how each of the 7 core problems is solved in this codebase: the actual
mechanism, the trade-off behind it, and the gotcha worth knowing. Problem definitions and
data-source descriptions live in `README.md`; Vue/Nuxt patterns in `CLAUDE.md` — **link, don't
restate.** This file captures only the *specifics from this codebase*.

One block per problem, ordered by the build order in `CLAUDE.md`.

Template per problem:
- **What it does:** the actual mechanism, with `file:line` pointers.
- **Trade-off:** the choice made, the alternative rejected, and why.
- **Extending it:** the one-sentence "how to add X".
- **Trap (avoided):** the gotcha worth noting (link `CLAUDE.md` trap # if relevant).

---

## 1. Large dataset rendering
- **What it does:** `FeatureList.vue` — a side panel that shows the land-price features
  currently visible in the map viewport, windowed with `@tanstack/vue-virtual`
  (`useVirtualizer`). The list is synced to the map: `MapView.client.vue` calls
  `map.queryRenderedFeatures({layers: ['land-price-points']})` on every `moveend` (and
  after filter changes, waiting for the next `render` event so `setFilter` has applied)
  and writes the result to `store.viewportFeatures`. `FeatureList` reads the same ref;
  there are no props or events between them — just the shared store (problem #4 + #1).
- **Trade-off:** DOM windowing (`useVirtualizer`) vs. canvas/WebGL rendering.
  `v-for` over all 2,602 rows would create 2,602 DOM nodes; Vue diffs them on every
  update → noticeable jank, especially with `moveend` firing continuously during pan.
  The virtualizer keeps ~20 absolute-positioned rows in the DOM and repositions them as
  you scroll — the rest don't exist. Canvas/WebGL rendering (e.g. `<canvas>` with a
  custom renderer) would give even better perf for millions of rows but adds significant
  complexity and loses accessibility; for thousands of rows, DOM windowing is the sweet
  spot. The MapLibre map itself handles rendering the 2,602 map points on the GPU —
  that's why the map stays fast regardless. The list is a separate concern.
- **Extending it:** for variable-height rows, pass `measureElement` to
  `useVirtualizer` so it measures actual DOM heights instead of the fixed 52px estimate.
  For server-synced viewport data (not just the client-side rendered features), replace
  the `queryRenderedFeatures` call with a debounced `bbox` fetch to the backend
  (that's exactly problem #6).
- **Trap (avoided):** `queryRenderedFeatures` must be called AFTER `setFilter` has
  taken effect — i.e. after the next render, not synchronously after `setFilter`. Fixed
  by `map.once('render', updateViewportFeatures)` instead of calling it immediately.
  Also: the virtualizer `count` must be reactive — passing a plain options object bakes
  in the initial count of 0. Fixed by wrapping the options in `computed()` so the
  virtualizer re-layouts when `displayRows.length` changes. (CLAUDE.md trap #7, #8.)

## 2. Map integration
- **What it does:** Full-screen MapLibre map over Tokyo in `frontend/app/components/MapView.client.vue`.
  Inline style v8 with one raster `source` (OSM tiles) + one raster `layer`; `NavigationControl`
  added. Backend health route at `backend/.../router.ex` → `HealthController`, pinged from the
  browser in `app/app.vue` to surface API status. (Step 1 of the build order.)
- **Trade-off:** Raster OSM tiles (zero setup, no key) over vector tiles — fine now;
  vector tiles become worth it once we need data-driven styling/perf (problem #3). Map instance
  kept as a plain closure var, not `ref`/`reactive` (CLAUDE.md trap #6).
- **Extending it:** add a `source` (GeoJSON) then one+ `layer`s referencing it; update
  data with `source.setData` rather than recreating the layer. That's exactly what step 2 does.
- **Trap (avoided):** MapLibre needs the DOM → component is `.client.vue` so it never SSRs
  (trap #4); init in `onMounted`, `map.remove()` in `onUnmounted` to avoid HMR/nav leaks (trap #5).
  Also (step 2): the template ref was `null` in `onMounted` during client-only hydration →
  MapLibre threw "container must be a String or HTMLElement". Fix = single root element +
  `await nextTick()` + guard (CLAUDE.md trap #11).

  CORS (step 1): `cors_plug` in the endpoint, origins from `CORS_ORIGINS` env (default
  `localhost:3000`). Verified preflight 204 + `access-control-allow-origin` echo via curl.
  Health pinged with `$fetch` in `onMounted` (not `useFetch`) so the browser→API cross-origin
  call actually exercises CORS (trap #9).

## 3. Multi-layer overlay performance
- **What it does:** Three layers, each adding a new geometry type and performance concern:
  1. **Weather** (139 blurred circle points) — sparse, always fast; establishes the baseline.
  2. **Land price** (2,602 circle points) — added AFTER weather so the dense price layer draws
     on top; layer order is explicit (MapLibre renders in insertion order).
  3. **Buildings** (up to ~8k `Polygon` fill features, OSM Overpass, capped at `LIMIT=8000`) — added BEFORE the other two
     so polygon fills render below circle overlays. First polygon/fill layer in the project;
     toggles off by default so the initial map load stays fast.

  All three toggle independently via `setLayoutProperty(id, 'visibility', …)` driven by
  `watch` on store refs (`MapView.client.vue`). Each source uses `setData` to update —
  no layer teardown/recreate. Price encoded by both radius and colour (log-spaced stops).

- **Trade-off:** GeoJSON source (simple, fine at ≤10k features — MapLibre renders on
  the GPU) vs. vector tiles (worth it for 50k+ features / polygon simplification).
  At 2.6k land-price points: GeoJSON is ideal. At up to ~8k building polygons: GeoJSON still
  works but you can measure the parse cost on first load (open DevTools → Network tab).
  At 50k+ (full 23 wards): switch the source to `vector` type (PMTiles served from
  Phoenix or a CDN), pre-tile with `tippecanoe`, and drop the `geojson` source entirely.
  MapLibre handles the tile request/caching automatically; the `setFilter` API still works.

  Toggle visibility instead of re-adding layers: cheaper (keeps the source in GL memory),
  and avoids a flash of empty source on re-add.

  **Log-spaced** colour stops for land price, not linear: prices span ¥1.5k–¥54M/m²,
  so a linear ramp would flatten 90% of points into one colour.

- **Extending it:** run `tippecanoe -o buildings.pmtiles buildings_tokyo.geojson`
  on the full 23-ward dataset, serve the `.pmtiles` file via `plug Plug.Static`, change the
  MapLibre source type to `vector` with a `pmtiles://` URL, and the layer `source-layer`
  to the layer name tippecanoe assigned. Nothing else on the frontend changes.
  For the 3D variant: swap `fill` for `fill-extrusion` and drive `fill-extrusion-height`
  from the `levels` property.

- **Trap (avoided):** Polygon layer order matters visually — buildings fill MUST be
  added before circles or it paints over the data. MapLibre layers render in insertion order
  (later = on top). Also: the `fill-outline-color` paint property draws polygon edges without
  needing a separate `line` layer. GeoJSON Polygon rings must be closed (last coord === first);
  the Overpass output uses `{lat, lon}` objects, not `[lon, lat]` arrays — swap on ingest or
  every building appears in the South Atlantic.

  **Scale discovery:** the first ingest run against the broader central-Tokyo bbox returned
  206,971 building features — estimated ~150 MB of GeoJSON. This proved the "GeoJSON ceiling"
  concretely: even `setData` on a pre-cached 150 MB payload would freeze the browser's main
  thread. Two fixes applied: (1) narrow the committed dataset to the Shinjuku-core bbox and
  cap it at `LIMIT=8000` features, and (2) switch the frontend from "load once" to the same per-viewport
  bbox-fetch pattern as land price (`watch(viewportBbox)` + `AbortController` + cache). For
  the full 23-ward dataset, the correct path is `tippecanoe → PMTiles → MapLibre vector source`
  — the backend serves tiles, MapLibre requests only the tiles it needs, and simplification
  at low zoom is automatic.

## 4. State management for filter-heavy UIs
- **What it does:** A single Pinia store `useQueryStore` (`app/stores/query.ts`) holding shared
  query state: `showWeather`, `showLandPrice`, `priceMin`, `priceMax`. `ControlPanel.vue`
  (toggles + a log-scaled price range slider) *writes* it; `MapView.client.vue` *reads* it and
  applies changes imperatively — `setLayoutProperty` for visibility, `setFilter` for the price
  range. The two components are siblings with **zero props/events between them**.
- **Trade-off:** one store for cross-component query state vs. prop drilling or an event bus.
  Store wins: the map and the (coming) list both bind the same source of truth. Filtering via
  MapLibre `setFilter` (render-time) instead of refiltering/refetching the GeoJSON — no data round-trip.
- **Extending it:** add the list view reading the same store; add more filters (temp,
  use-category) as more store fields — no component plumbing changes.
- **Trap (avoided):** destructuring a Pinia store drops reactivity — used `storeToRefs`
  in both components (CLAUDE.md trap #1). Price slider is **log-scaled** since prices span 4+
  orders of magnitude; a linear slider would be unusable.

## 5. Merging/normalizing multiple sources
- **What it does:** Two backend modules, each serving the same contract — a GeoJSON
  `FeatureCollection` of `Point`s with documented `properties` — so the frontend never sees a
  raw upstream shape.

  `Backend.Weather` (`weather.ex`) loads a **precomputed climatology**: 139 mainland-Tokyo
  grid points, each with a 2022–2024 summer mean temperature averaged from Open-Meteo's
  archive API. Generated once by `priv/data/weather_summer_avg.ingest.mjs`, committed to
  `priv/data/`, served straight (no transform — it's already in our contract).
  `properties: {temperature, unit, metric}`.

  `Backend.LandPrice` (`land_price.ex`) reads the raw 8 MB MLIT file (committed unchanged) and
  at serve time maps its opaque coded fields (`L01_006`→`price_per_sqm`, `L01_024`→`address`,
  …) into clean English keys and **drops ~134 others**. Same `:persistent_term` cache keyed by
  file mtime. Both served at `/api/layers/{weather,land-price}`; controllers are pure HTTP
  (200 or 502 on failure).

- **Trade-off:** Normalize on the backend, not the frontend — every layer reaches Vue in
  one shape, so `MapView.client.vue` does zero per-source reshaping. Upstream quirks
  (MLIT's opaque field codes, geo-enabling a non-geographic API, choosing precomputed vs. live)
  stay isolated in one module each.

  Live vs. precomputed for weather: live current-temp barely varies across Tokyo (~1°C spread)
  and the free Open-Meteo API rate-limits heavy grids. Precomputed climatology is more stable
  and more representative to display. The normalization lesson is identical either way — it still
  has to be geo-enabled (`[lon, lat]` order, not spoken "lat, lon") with the quirk isolated in one module.

- **Extending it:** add another source module emitting the same `FeatureCollection`
  contract; nothing on the frontend changes except the URL.
- **Trap (avoided):** Open-Meteo is per-point JSON, *not* geospatial — it is geo-enabled
  by pairing each `{lat, lon}` with its returned temperature and emitting `[lon, lat]` (GeoJSON
  is lon-first, opposite of spoken order). Also: a newly-added Elixir dep (`req`) does **not**
  hot-load into a running BEAM — the server must be restarted (a 500 until then). And
  the frontend wraps each layer fetch in `try/catch` so a failing source can't break the map.

## 6. Caching + debouncing expensive queries
- **What it does:** Viewport-driven land-price fetching: `moveend` updates `store.viewportBbox`;
  a `watch` on that ref runs a 300ms debounce, checks an in-memory cache, then fetches
  `/api/layers/land-price?bbox=west,south,east,north` with an `AbortController`. The result
  is cached and pushed into the MapLibre source via `setData`. The backend filters the
  already-memoized 2,602-feature collection to only the bbox, so responses are smaller at
  higher zooms. Cache key: `bbox` rounded to 1 decimal place (~11km) + floored zoom — coarse
  enough that panning back to a known area hits cache, fine enough that different areas don't.
  All wired in `MapView.client.vue:watch(viewportBbox, ...)`.

- **Trade-off:**
  - **Debounce vs. throttle:** debounce fires once after N ms of silence — right for pan/zoom
    where you want to wait for movement to stop. Throttle fires at most once every N ms —
    right for continuous events (e.g. a live cursor tracker). Pan fires `moveend` only AFTER
    the gesture ends, so `moveend` already throttles; the 300ms debounce handles bursts of
    rapid keypress panning.
  - **`watch` + `onCleanup` vs `watchEffect`** (CLAUDE.md trap #3): `watch` gives us `onCleanup`
    for precise teardown — one hook cancels both the debounce timer AND the in-flight request.
    `watchEffect` would track every reactive read inside the callback (including `fetchCache.get`,
    which we don't want), and has no built-in onCleanup that fires per-dependency-change.
  - **Cache key rounding:** 1dp ≈ 11km at Tokyo — a deliberate trade-off between freshness
    (small pan gets new data) and hit rate (pan back to a viewed area hits cache). A tighter
    key (more decimals) fetches more; a looser one serves staler data.
  - **Plain Map cache vs. SWR:** a `Map<string, data>` is enough here. SWR (stale-while-
    revalidate) adds background refresh + loading states; worth it for data that changes
    on the server, not for static yearly land-price data.

- **Extending it:** add a loading state to the store (e.g. `landPriceLoading: ref(false)`)
  set in the fetch path, read by FeatureList to show a spinner; wire an LRU to bound cache
  size; use `bbox+zoom` as the backend cache key too to memoize filtered slices server-side.

- **Trap (avoided):** `setFilter` takes effect on the next render, not synchronously.
  Calling `updateViewportFeatures` immediately after `setFilter` returns stale features.
  Fix: `map.once('render', updateViewportFeatures)`. Same principle applies after `setData`:
  `map.once('idle', updateViewportFeatures)` waits for MapLibre to finish rendering the new
  source before querying it. (CLAUDE.md trap #3 for the `watch` design.)

## 7. Graceful degradation
- **What it does:** Three-part system: backend fault injection, per-source frontend status,
  and a retry mechanism — all isolated so a broken weather source never affects land price.

  **Backend** (`WeatherController`): three pattern-match clauses on `?fault=<mode>`.
  `fault=error` returns 502 immediately; `fault=delay` calls `Process.sleep(3_000)` then
  responds normally; no param = normal. The fault is a query param, not a config flag, so
  the frontend's fault toggle directly controls the backend behaviour.

  **Frontend store**: `weatherFault` (the selected mode), `weatherStatus` ('loading' | 'ok'
  | 'error'), `weatherRetryTick` (incremented by `retryWeather()`). All three are
  independent of the land-price state — source-level isolation, not a global error flag.

  **MapView** refactored weather into `setupWeatherLayer()` (adds empty source + layer
  once) and `loadWeatherData()` (fetchable multiple times). A `watch([weatherFault,
  weatherRetryTick], ...)` re-runs `loadWeatherData()` on fault-mode change or retry
  click. On error: clears the source so the weather cloud visually disappears; on success:
  `setData` + `setPaintProperty` to update the colour ramp.

  **ControlPanel**: status dot next to Weather (green/red/pulsing-gray); "Retry weather"
  button that appears only when `weatherStatus === 'error'`; fault `<select>` dropdown.

- **Trade-off:**
  - **Source-level vs. global error state:** a single `appError` ref would be simpler but
    would take down the whole UI for one bad source. Per-source status refs mean the land
    price layer stays fully interactive while weather is broken — the map, list, and price
    filter keep working. That's the correct model for a B2B dashboard with multiple data feeds.
  - **Query-param fault injection vs. server-side toggle:** a dedicated `/api/admin/fault`
    endpoint to flip a server-side flag would be more realistic (the client wouldn't know
    about faults) but adds an extra round-trip and state. Query-param injection is simpler
    to demo and makes the mechanism explicit in the network tab.
  - **Clearing the source on error vs. keeping stale data:** stale data could mislead users.
    Clearing (`setData` with empty FeatureCollection) makes the error unambiguous at a glance:
    the weather cloud disappears, the red dot appears, and the retry button shows.

- **Extending it:** show a timestamp on the error ("weather unavailable since 14:32");
  add exponential backoff to automatic retries; propagate `landPriceStatus` to the panel the
  same way for the land-price bbox fetch; use an `AbortController` timeout to turn a slow
  response into an error after N seconds rather than waiting indefinitely.

- **Trap (avoided):** the weather source must exist before `loadWeatherData` calls
  `setData` on it. The `watch([weatherFault, weatherRetryTick], ...)` guards with
  `map?.getSource('weather')` to prevent calls before `map.on('load')` runs
  `setupWeatherLayer()`. Without the guard, a fault-mode change during map initialisation
  would call `setData` on a non-existent source and throw. Also: `weatherStatus` must be
  per-source — a global loading/error flag means one slow fetch blocks the whole UI.
