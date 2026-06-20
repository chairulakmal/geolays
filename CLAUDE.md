# geolay — implementation guide

This file tells you (Sonnet 4.6) how to build the project described in `README.md`. Read
`README.md` first — it is the source of truth for *what* and *why*. This file covers *how*:
the decisions that are already made, the order to build in, and the guardrails.

**Division of labour between the docs (so nothing is explained twice):**

- `README.md` — the why, the scope, and the data sources *narrative* (why each was chosen).
- `DATA.md` — canonical **data pipeline**: each source's origin, format, transforms, and endpoint.
- `CLAUDE.md` (this file) — implementation decisions, build order, conventions, and the
  **Vue/Nuxt best-practices & traps catalogue** (canonical).
- **The code** — inline comments explaining the *why* of each non-obvious local decision.

When you need to reference something explained in another place, **link to it; do not
re-explain it.** Duplicated prose drifts out of sync — single source of truth always.

## Prime directive: this is a learning spike, not a product

The README is explicit: **scope is intentionally narrow and time-boxed.** Your job is to
build the *thinnest* slice that lets the author speak concretely about each of the 7 core
problems in an interview. When in doubt, build less. Do not gold-plate, do not add features
not asked for, do not chase production polish (see the README's "Explicit non-goals").

"Done" = each of the 7 core problems is demonstrable with a real implementation detail in
this codebase. Optimize for that, nothing more.

## Decisions already made (don't re-litigate these)

These resolve the README's open questions so you can move without asking:

- **Map library: MapLibre GL JS**, not Mapbox. No token, no signup, no billing risk. The
  APIs are near-identical, so the README's "Mapbox GL fundamentals" goal is fully covered.
  Use a free raster/vector basemap style (e.g. a public demo style or OSM raster tiles).
- **Datasets: start with exactly 2** — Open-Meteo (weather) and MLIT land price; e-Stat
  population mesh is a stretch third only if the first two are solid. See the README's
  "Data sources in detail" for what each source is, its shape, and its quirks — don't
  duplicate that here. Two layers is enough to demonstrate multi-layer overlay + normalization.
- **State: Pinia**, not ad-hoc composables, for the shared cross-component query state
  (filters, layer toggles, viewport). Thin composables may wrap Pinia stores for ergonomics.
- **Region: Tokyo.** Hardcode an initial viewport over Tokyo. Don't build a region picker.

If a genuinely blocking ambiguity remains, ask one focused question rather than guessing.

## Stack & tooling

- **Frontend: Nuxt 4** (Vue 3, Composition API, `<script setup>`, TypeScript).
- **Backend: Phoenix (Elixir), JSON API only.** No Ecto/DB unless a dataset genuinely
  needs persistence — prefer serving static GeoJSON from `priv/` and proxying live APIs.
  No business logic; it normalizes shapes and proxies/caches upstream sources.
- **Virtualized list:** `@tanstack/vue-virtual`.
- **Deploy: Railway.** When you get there, use **Railpack** or a Dockerfile in
  `railway.json` (`build.builder: "RAILPACK"`). **Never Nixpacks — it is deprecated.**

## Repository layout

Two apps in one repo:

```
/frontend   # Nuxt 4 app
/backend    # Phoenix app
```

Keep them independent (separate installs, separate run commands). They talk over HTTP/JSON.
Put the frontend's API base URL in runtime config / env, defaulting to the local Phoenix
port, so Railway deploy is a config change, not a code change.

## Build order

Build vertically — one working slice end-to-end before breadth. Suggested sequence, each
step ending in something runnable:

1. **Scaffold both apps.** Nuxt 4 app that renders a full-screen MapLibre map centered on
   Tokyo. Phoenix app with one health endpoint and CORS enabled for the frontend origin.
2. **First data layer (weather).** Phoenix serves a normalized GeoJSON FeatureCollection
   (precomputed Open-Meteo climatology from `priv/data/`). Frontend adds it as a MapLibre
   source+layer. (Problems 2, 5.) See `DATA.md §1` for the ingest pipeline.
3. **Second data layer (land price).** Serve the static GeoJSON from Phoenix; render as a
   second toggleable layer. (Problems 2, 3.)
4. **Layer toggles + filters in Pinia.** Toggle each layer on/off; one real filter (e.g.
   price range or temperature range) that drives both map styling and the list. (Problem 4.)
5. **Synced virtualized list.** Side panel listing features in the current viewport, windowed
   with `@tanstack/vue-virtual`, kept in sync with map pan/zoom. (Problem 1.)
6. **Debounce + cache + cancellation.** Debounce pan/zoom before refetch; in-memory cache
   keyed by `bbox+zoom`; cancel in-flight requests with `AbortController`. (Problem 6.)
7. **Graceful degradation.** Add a toggle/env flag in the Phoenix proxy to inject delay or
   error for one source; frontend shows a source-level error state + retry while the rest of
   the app stays usable. (Problem 7.)

Don't start a step until the previous one runs. After each step, fill in that problem's
block in `NOTES.md` with the concrete detail to cite in an interview — that note *is* the
deliverable for that problem.

## Learning-first authoring rules

This is a learning project (README: "Learning-first"). Treat teaching value as a first-class
output, under the prime directive (don't add scope just to teach — explain the scope you do
build). Concretely:

- **Comment the *why*, never the *what*.** `// loop over features` is noise; `// debounce
  300ms: longer than a pan flick, shorter than feels laggy — see problem #6` is the point.
  Assume the reader knows Vue syntax but not *this* decision.
- **Name the trade-off you rejected.** A one-line "could've done X; chose Y because Z" comment
  is worth more than paragraphs — it's literally interview prep.
- **One explanation, one home.** If a concept already lives in the README or the catalogue
  below, link to it (`see README "Data sources"` / `see CLAUDE.md trap #N`). Re-explaining is
  the main thing to avoid — duplicated docs rot.
- **DRY the code too.** A normalization helper, a fetch-with-cancel wrapper, a bbox util —
  write once, reuse. Duplicated logic is both a code smell and a worse teaching example.

## Architecture conventions

- **Normalization lives in the Phoenix backend.** Each upstream source has its own module
  that fetches and maps it into one shared internal shape (GeoJSON FeatureCollection with a
  documented properties contract). The frontend should never see raw upstream shapes. Be
  ready to articulate *why* backend-side (README problem 5).
- **One Pinia store for query state** (viewport bbox, zoom, active layers, filter values);
  map and list both read from it and write to it. No prop drilling of filter state.
- **Map data flow:** store change → debounced fetch (with AbortController) → cache check →
  update MapLibre source via `setData`. Don't tear down/recreate layers on every update.
- **Performance framing matters more than micro-optimizing.** For each perf-related problem,
  the goal is to *demonstrate and be able to explain* a trade-off, not to squeeze ms. A
  small, clearly-commented example beats a clever opaque one.

## Vue/Nuxt best practices & traps to demonstrate

This is the **canonical catalogue** of the Vue/Nuxt patterns this project exists to learn.
When you hit one of these in the code, leave a short comment naming the trap and the fix, and
link back here (`see CLAUDE.md trap #N`) rather than re-explaining. These are also the
interview talking points, so implement them deliberately, not by accident.

1. **Reactivity loss when destructuring.** Destructuring `props`, a `reactive()` object, or a
   Pinia store breaks reactivity — you copy the value, not the ref. *Fix:* `toRefs` /
   `storeToRefs` for stores; access `props.x` directly. Relevant in the filter store wiring
   (problem #4).
2. **`ref` vs `reactive`.** Default to `ref` for primitives and for anything you reassign
   wholesale (e.g. replacing a fetched array); `reactive` can't be reassigned without losing
   reactivity. The viewport/feature lists are reassigned on every fetch — use `ref`.
3. **`watch` vs `watchEffect` + cleanup.** For "refetch when bbox changes", `watch` the bbox
   with an `onCleanup` that aborts the previous request — this is the natural home for the
   `AbortController` (problem #6). `watchEffect` is the wrong tool when you need the old value
   or precise dependency control.
4. **SSR/hydration traps (Nuxt-specific).** MapLibre touches `window`/DOM and must **not**
   render on the server. *Fix:* `<ClientOnly>` around the map, or init the map in `onMounted`,
   or a `.client.vue` component. Don't read `window` at setup top-level. Avoid hydration
   mismatches from time/locale-dependent rendering.
5. **`onMounted`/`onUnmounted` lifecycle leaks.** The MapLibre instance, event listeners, and
   any debounce timers must be torn down in `onUnmounted` (`map.remove()`), or you leak across
   HMR and navigation. Create in `onMounted`, dispose symmetrically.
6. **Don't make heavy non-reactive objects reactive.** The MapLibre `map` instance should be
   a plain variable or `shallowRef` / `markRaw` — never a deep `ref`/`reactive`, or Vue will
   try to proxy the whole GL object and tank performance. Classic trap; call it out.
7. **`v-for` keys & not rendering huge lists.** Stable `:key` (a feature id, never the array
   index for dynamic lists). And the core lesson of problem #1: don't `v-for` thousands of
   rows into the DOM at all — window them with `@tanstack/vue-virtual`.
8. **`computed` over methods for derived state.** Filtered/derived lists belong in `computed`
   (cached, re-runs only on dependency change), not a method called in the template (re-runs
   every render). Directly relevant to the filtered feature list (problem #4).
9. **Nuxt data fetching: `useFetch`/`useAsyncData` vs `$fetch`.** Use `useFetch`/`useAsyncData`
   for SSR-aware initial loads (dedupes, no double-fetch on hydration); use `$fetch` for
   imperative, event-driven calls (a pan-triggered refetch). Picking wrong = double requests
   or no SSR benefit.
10. **`runtimeConfig` for the API base URL**, not hardcoded or raw `import.meta.env`. Keeps the
    Railway deploy a config change, not a code change (see Repository layout).
11. **Template refs in client-only components + `onMounted` timing.** In a `.client.vue`
    component, a template ref can still be `null` when `onMounted` fires during hydration —
    passing it straight to a library (e.g. `new maplibregl.Map({ container })`) throws
    "container must be a String or HTMLElement". *Fix:* keep a single root element (a
    multi-root/fragment template makes this worse), then `await nextTick()` and guard
    (`if (!container.value) return`) before using it. (Hit in `MapView.client.vue`, step 2.)

Add to this list as you discover more — keep it the single place these are recorded.

## Guardrails

- Respect the non-goals: **no auth, no accounts, no deploy polish, no extra datasets.**
- Don't add a database, ORM, state library, or component kit beyond what's named here
  without a clear reason tied to one of the 7 problems.
- Keep dependencies minimal. Every added package should map to a stated goal.
- Prefer real open data, but a small committed sample GeoJSON is fine to keep iteration fast
  and avoid hammering upstream APIs during development.
- Follow the "Learning-first authoring rules" above for comments/docs; don't restate them here.

## Running

> **Do NOT start the dev servers.** The author runs `mix phx.server` and `npm run dev` in
> their own terminals and keeps them up across the session (both have hot-reload, so code
> changes are picked up automatically). Never launch, restart, or kill them. To verify
> backend changes, `curl` the running server on :4000; for the frontend, rely on its HMR or
> ask the author to check the browser. Compiling to check for errors (`mix compile`,
> `npx nuxt prepare`) is fine — running the servers is not.

- **Frontend** (Nuxt 4, Node 24 + npm): `cd frontend && npm install && npm run dev`
  → http://localhost:3000. Backend URL is in `runtimeConfig.public.apiBase`
  (default `http://localhost:4000`); override with `NUXT_PUBLIC_API_BASE`.
- **Backend** (Phoenix 1.8, JSON API, no Ecto): `cd backend && mix deps.get && mix phx.server`
  → http://localhost:4000.

Frontend deps already installed: `maplibre-gl`, `pinia`, `@pinia/nuxt`, `@tanstack/vue-virtual`.
Backend was generated with `--no-ecto --no-html --no-assets --no-mailer --no-gettext
--no-dashboard` (no DB — serves static GeoJSON from `priv/` and proxies live APIs).

**Not yet wired (first implementation steps, see build order):** CORS on the Phoenix
endpoint for the frontend origin, and the first data-layer route. Stores go in
`frontend/app/stores/`.
