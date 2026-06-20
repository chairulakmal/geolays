<script setup lang="ts">
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useQueryStore, type ViewportFeature } from '~/stores/query'

// MapLibre is a heavy, imperative, NON-reactive object. We keep the instance in
// a plain closure variable — never a ref/reactive. Wrapping a GL map in a Vue
// proxy serves no purpose and tanks performance. See CLAUDE.md trap #6.
let map: maplibregl.Map | null = null

const config = useRuntimeConfig()
const container = useTemplateRef<HTMLDivElement>('container')

// Shared query state lives in the Pinia store; the ControlPanel writes it, the map
// reads it (no prop drilling — problem #4). storeToRefs keeps reactivity when
// destructuring store state (CLAUDE.md trap #1).
const store = useQueryStore()
const { showWeather, showLandPrice, showBuildings, priceMin, priceMax, viewportBbox, weatherFault, weatherRetryTick } = storeToRefs(store)

// Initial viewport: framed to show all of mainland Tokyo (23 wards + Tama west),
// matching the data extent. Hardcoded by decision — no region picker.
// See CLAUDE.md "Decisions already made".
const TOKYO_CENTER: [number, number] = [139.6, 35.7]
const INITIAL_ZOOM = 10

// Weather renders as a single blurred "cloud" layer that blends neighbouring grid
// points into a continuous temperature field (no discrete dots).
const WEATHER_LAYERS = ['weather-cloud']
const LAND_PRICE_LAYERS = ['land-price-points']
const BUILDING_LAYERS = ['buildings-fill']

// Temperature colour ramp (cold blue → hot red). Just the colours — the °C values
// are NOT fixed, because across Tokyo temperature varies only ~1–2°C, so a fixed
// 0–32° scale paints every point the same. Instead we stretch this ramp across the
// actual min/max of the fetched data (computed below), so the gradient is visible.
const WEATHER_RAMP = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']

// Actual temperature range of the current data; drives both the map ramp and the
// legend, so they can't drift. Set after the weather layer loads.
const tempDomain = ref<[number, number] | null>(null)

// Map a ramp + [min,max] domain to evenly-spaced `[value, color]` stops.
function rampStops(ramp: string[], [min, max]: [number, number]): Array<[number, string]> {
  return ramp.map((color, i) => [min + (i / (ramp.length - 1)) * (max - min), color])
}

// Legend entries for the weather ramp, derived from the live domain.
const weatherLegend = computed(() =>
  tempDomain.value ? rampStops(WEATHER_RAMP, tempDomain.value) : []
)

// Price → colour ramp (yen/m²). Tokyo land price spans ~¥1.5k–¥54M/m², so stops
// are log-spaced, not linear, or everything below ~¥1M would look identical.
const PRICE_STOPS: Array<[number, string]> = [
  [100_000, '#1a9850'],
  [300_000, '#91cf60'],
  [500_000, '#d9ef8b'],
  [1_000_000, '#fee08b'],
  [2_000_000, '#fc8d59'],
  [5_000_000, '#d73027'],
  [20_000_000, '#7f0000']
]

// Compact yen labels for the legend (¥300k, ¥2M).
function formatYen(v: number): string {
  return v >= 1_000_000 ? `¥${v / 1_000_000}M` : `¥${v / 1000}k`
}

onMounted(async () => {
  // This component is `.client.vue`, so it never runs during SSR. MapLibre
  // touches window/DOM and would crash on the server. See CLAUDE.md trap #4.

  // Wait one tick so the template ref is bound. Under client-only hydration the
  // ref can still be null when onMounted first fires; MapLibre then throws
  // "container must be a String or HTMLElement". nextTick + guard avoids it.
  await nextTick()
  if (!container.value) return

  map = new maplibregl.Map({
    container: container.value,
    center: TOKYO_CENTER,
    zoom: INITIAL_ZOOM,
    // Muted light basemap (CARTO Positron, no key). A plain grey/white base lets
    // the data layers stand out — the busy default OSM map fights the overlays.
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors © CARTO'
        }
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }]
    }
  })

  map.addControl(new maplibregl.NavigationControl(), 'top-right')

  // On every moveend: update the viewport bbox in the store. This drives two things:
  //   1. The debounced bbox fetch (problem #6) via the watch below.
  //   2. The feature list sync (problem #1) via updateViewportFeatures.
  // moveend fires once, after the camera animation is done — not on every frame.
  map.on('moveend', () => {
    if (!map) return
    const b = map.getBounds()
    viewportBbox.value = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    updateViewportFeatures()
  })

  // Sources/layers can only be added once the base style has loaded. We add
  // weather first, then land-price, so the dense price layer draws ON TOP of the
  // sparse weather layer — layer order is a real multi-overlay concern (#3).
  map.on('load', async () => {
    // Buildings go first so they render BELOW the data layers (MapLibre draws layers
    // in insertion order). Weather and land-price circles appear on top.
    setupBuildingsLayer()
    // Fire-and-forget: don't await so the weather layer sets up in parallel.
    // Buildings data is independent — a slow buildings fetch won't block weather.
    loadBuildingsData()

    // Weather: set up source + layer first, then load data separately so the
    // load can be re-run for retry and fault injection (problem #7).
    setupWeatherLayer()
    await loadWeatherData()

    setupLandPriceLayer() // adds empty source + layer; data arrives via bbox watch
    // Set initial bbox → triggers the first land-price fetch via the watch below.
    const b = map.getBounds()
    viewportBbox.value = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
  })
})

// Ask MapLibre what is currently drawn in the viewport for the land-price layer.
// queryRenderedFeatures already respects the active setFilter (price range), so
// the result is exactly "visible + passing the price filter" — no need to re-filter
// in Vue. Written to the store so FeatureList can window it (problem #1).
//
// MapLibre can return the same feature more than once when geometry spans tile
// boundaries or world-wrap. Dedupe by address (stable per MLIT point; the raw
// GeoJSON has no explicit feature id). Without this, the list count is inflated.
function updateViewportFeatures() {
  if (!map) return
  const raw = map.queryRenderedFeatures({ layers: ['land-price-points'] }) as ViewportFeature[]
  const seen = new Set<unknown>()
  store.viewportFeatures = raw.filter((f) => {
    const key = f.properties.address ?? f.properties.price_per_sqm
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Both layers come from the backend already in our normalized GeoJSON contract,
// so the frontend does zero reshaping (problem #5). A failing layer must never
// break the map (good practice; foreshadows #7) — hence per-layer try/catch.
async function fetchLayer(path: string): Promise<GeoJSON.FeatureCollection | null> {
  try {
    return await $fetch<GeoJSON.FeatureCollection>(path, { baseURL: config.public.apiBase })
  } catch (err) {
    console.warn(`[layer] ${path} unavailable:`, err)
    return null
  }
}

// Adds the buildings source (empty) and fill layer. Inserted BEFORE weather + land-price
// so it renders underneath — polygon fills would otherwise cover the circle layers.
// The `fill-outline-color` doubles as the building edge, so no separate `line` layer needed.
function setupBuildingsLayer() {
  if (!map) return
  map.addSource('buildings', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'buildings-fill',
    type: 'fill',
    source: 'buildings',
    // Off by default: ~10k polygon features (see problem #3 — this is the "GeoJSON at
    // scale" demo layer). User opts in so the initial map load stays fast.
    layout: { visibility: showBuildings.value ? 'visible' : 'none' },
    paint: {
      // Muted warm grey: legible on the CARTO Positron basemap without fighting it.
      // A future `fill-extrusion` layer with building height would give 3D effect.
      'fill-color': '#c9c5bd',
      'fill-opacity': 0.65,
      'fill-outline-color': '#a09c93',
    },
  })
}

// Per-viewport buildings cache — same key strategy as the land-price cache.
const buildingsCache = new Map<string, GeoJSON.FeatureCollection>()

// Buildings default to hidden, so there's nothing to prefetch on initial load.
// The viewportBbox watcher handles the actual fetch whenever showBuildings is true.
// This function exists so the map.on('load') block reads symmetrically alongside
// loadWeatherData(); the real entry point is the showBuildings watch below.
async function loadBuildingsData() {}

// Adds the weather source (empty) and layer to the map. Data arrives via
// loadWeatherData(), which can be re-run for retry and fault injection (problem #7).
// Separating structure from data means the layer exists immediately and the map
// never shows a broken layer reference.
function setupWeatherLayer() {
  if (!map) return
  map.addSource('weather', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'weather-cloud',
    type: 'circle',
    source: 'weather',
    layout: { visibility: showWeather.value ? 'visible' : 'none' },
    paint: {
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 9, 30, 13, 480],
      // The cloud: large blurred circles forming a continuous temperature field.
      // See the original addWeatherLayer comment for the radius/blur rationale.
      'circle-blur': 1,
      'circle-opacity': 0.4,
      // Placeholder colour until loadWeatherData sets the data-driven ramp via
      // setPaintProperty. '#b0c4de' is a neutral cool blue — visually distinct
      // from the basemap so an error state is obvious (empty layer = no cloud).
      'circle-color': '#b0c4de'
    }
  })
}

// Tracks the in-flight weather request so a new call can cancel the previous one.
// Without this, selecting "Slow (3s)" then "Error" leaves request A still running;
// when it resolves it overwrites the 'error' state with a stale 'ok' — last-write-
// wins. The land-price watcher solves this via onCleanup; weather uses a module-
// level controller because loadWeatherData is called imperatively, not from a watch.
let weatherController: AbortController | null = null

// Fetches weather data and pushes it into the existing source via setData.
// Can be called multiple times: initial load, fault-mode change, and retry.
// Updates store.weatherStatus so ControlPanel can show per-source feedback.
async function loadWeatherData() {
  if (!map) return

  // Cancel any previous in-flight request before starting a new one (problem #7).
  weatherController?.abort()
  weatherController = new AbortController()
  store.weatherStatus = 'loading'

  const faultParam = weatherFault.value !== 'none' ? `?fault=${weatherFault.value}` : ''
  let data: GeoJSON.FeatureCollection | null = null
  try {
    data = await $fetch<GeoJSON.FeatureCollection>(
      `/api/layers/weather${faultParam}`,
      { baseURL: config.public.apiBase, signal: weatherController.signal }
    )
  } catch (err: unknown) {
    // AbortError means a newer loadWeatherData() call superseded this one — bail
    // silently, the newer call manages status from here.
    if (err instanceof Error && err.name === 'AbortError') return
    console.warn('[weather] fetch failed:', err)
  }

  if (!data) {
    store.weatherStatus = 'error'
    // Clear the source so the weather cloud disappears — an empty map is a clearer
    // error signal than stale data silently hanging around (problem #7).
    const src = map?.getSource('weather') as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: [] })
    tempDomain.value = null
    return
  }

  // Stretch the colour ramp across the actual temperature range so the small
  // intra-Tokyo variation is visible (a fixed scale washes it out).
  const temps = data.features
    .map((f) => f.properties?.temperature as number)
    .filter((t) => Number.isFinite(t))
  if (!temps.length) { store.weatherStatus = 'error'; return }

  const domain: [number, number] = [Math.min(...temps), Math.max(...temps)]
  tempDomain.value = domain

  const src = map?.getSource('weather') as maplibregl.GeoJSONSource | undefined
  if (!src) return
  src.setData(data)

  // Update the colour ramp to the new domain. setPaintProperty replaces the paint
  // expression in place — no need to recreate the layer.
  const colorByTemp = ['interpolate', ['linear'], ['get', 'temperature'], ...rampStops(WEATHER_RAMP, domain).flat()]
  map.setPaintProperty('weather-cloud', 'circle-color', colorByTemp)

  store.weatherStatus = 'ok'
}

// Re-run loadWeatherData whenever the fault mode changes OR the user clicks retry.
// The guard ensures the map has loaded (source exists) before we attempt setData.
// Immediate: false (default) — the initial load is handled in map.on('load') above.
watch([weatherFault, weatherRetryTick], () => {
  if (map?.getSource('weather')) loadWeatherData()
})

// Adds the land-price source (empty) and layer to the map. Data is intentionally
// NOT fetched here — it arrives via the viewportBbox watch below (problem #6).
// Separating structure (layer setup) from data (bbox fetch) means the layer config
// stays stable and only the source data swaps via setData.
function setupLandPriceLayer() {
  if (!map) return
  map.addSource('land-price', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: 'land-price-points',
    type: 'circle',
    source: 'land-price',
    layout: { visibility: showLandPrice.value ? 'visible' : 'none' },
    // Apply the current price filter at creation time, not just on later changes.
    filter: priceFilter(priceMin.value, priceMax.value),
    paint: {
      // Radius and colour both encode price (log-spaced) so dense points stay
      // readable: cheap = small green, expensive = large dark red.
      'circle-radius': [
        'interpolate', ['linear'], ['get', 'price_per_sqm'],
        100_000, 3, 1_000_000, 6, 5_000_000, 10, 50_000_000, 16
      ],
      'circle-color': ['interpolate', ['linear'], ['get', 'price_per_sqm'], ...PRICE_STOPS.flat()],
      'circle-opacity': 0.85,
      'circle-stroke-width': 0.5,
      'circle-stroke-color': '#333333'
    }
  })
}

// Push new data into the existing land-price source without recreating the layer.
// setData replaces the GeoJSON in place — MapLibre re-renders only the affected tiles.
function updateLandPriceSource(data: GeoJSON.FeatureCollection) {
  const source = map?.getSource('land-price')
  if (!source) return
  ;(source as maplibregl.GeoJSONSource).setData(data)
  // Refresh the feature list once MapLibre has finished re-rendering with the new data.
  map!.once('idle', updateViewportFeatures)
}

// In-memory fetch cache: bbox+zoom key → FeatureCollection.
// Lives in the component (not the store) — it's a fetch-layer detail, not query state.
// Unbounded for simplicity; a real cache would use an LRU or TTL.
const fetchCache = new Map<string, GeoJSON.FeatureCollection>()

// Round bbox to 1 decimal place (~11km at Tokyo's latitude) and floor zoom for
// the cache key. This means slightly different viewports (small pans) share a
// cache entry — trading some freshness for fewer round trips.
function bboxCacheKey(bbox: [number, number, number, number], zoom: number): string {
  return bbox.map((v) => v.toFixed(1)).join(',') + `_z${Math.floor(zoom)}`
}

// The core of problem #6. Watches the viewport bbox and, on change:
//   1. Clears any pending debounce timer (rapid pans → only the final position fetches).
//   2. Aborts any in-flight request (no stale response applied after the component moves on).
//   3. Waits 300ms (debounce — shorter than a conscious pause, longer than a flick).
//   4. Checks the in-memory cache; skips the network on a hit.
//   5. Fetches with the current AbortController signal and caches the result.
//
// `watch` is the right tool here, not `watchEffect` (CLAUDE.md trap #3):
//   - `onCleanup` gives us the hook to cancel both the timer and the controller.
//   - We want explicit dependency control — only [viewportBbox], not every reactive
//     read inside the callback (which could accidentally track the cache Map).
watch(viewportBbox, (bbox, _prev, onCleanup) => {
  if (!bbox) return

  let controller: AbortController | null = null

  const timer = setTimeout(async () => {
    const cacheKey = bboxCacheKey(bbox, map?.getZoom() ?? 10)
    const cached = fetchCache.get(cacheKey)
    if (cached) {
      updateLandPriceSource(cached)
      return
    }

    controller = new AbortController()
    const bboxParam = bbox.map((v) => v.toFixed(4)).join(',')
    try {
      const data = await $fetch<GeoJSON.FeatureCollection>(
        `/api/layers/land-price?bbox=${bboxParam}`,
        { baseURL: config.public.apiBase, signal: controller.signal }
      )
      fetchCache.set(cacheKey, data)
      updateLandPriceSource(data)
    } catch (err: unknown) {
      // AbortError is expected — onCleanup cancels the controller when the bbox
      // changes again before this request completes. Not a real failure.
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[land-price] fetch failed:', err)
      }
    }
  }, 300) // 300ms: longer than a pan flick, shorter than feels laggy

  // onCleanup fires when the watch re-triggers (new bbox) or the component unmounts.
  // Clearing the timer cancels the debounce; aborting kills any in-flight request.
  // Together they ensure no stale response ever reaches a map that has already moved on.
  onCleanup(() => {
    clearTimeout(timer)
    controller?.abort()
  })
})

// Same debounce + abort + cache pattern as the land-price watch, applied to buildings.
// Seeing the pattern twice for two different layers is the point: this is the standard
// "expensive per-viewport fetch" solution regardless of what data is in the layer.
// The reason buildings CAN'T use a single load-once fetch: 207k features across the
// full central-Tokyo bbox = ~150 MB — proven when we first ran the ingest. Even the
// narrower Shinjuku bbox (~5k features) is faster to bbox-filter than to load whole.
watch(viewportBbox, (bbox, _prev, onCleanup) => {
  if (!bbox || !showBuildings.value) return

  let controller: AbortController | null = null

  const timer = setTimeout(async () => {
    const cacheKey = bboxCacheKey(bbox, map?.getZoom() ?? 10)
    const cached = buildingsCache.get(cacheKey)
    if (cached) {
      const src = map?.getSource('buildings') as maplibregl.GeoJSONSource | undefined
      src?.setData(cached)
      return
    }

    controller = new AbortController()
    const bboxParam = bbox.map((v) => v.toFixed(4)).join(',')
    try {
      const data = await $fetch<GeoJSON.FeatureCollection>(
        `/api/layers/buildings?bbox=${bboxParam}`,
        { baseURL: config.public.apiBase, signal: controller.signal }
      )
      buildingsCache.set(cacheKey, data)
      const src = map?.getSource('buildings') as maplibregl.GeoJSONSource | undefined
      src?.setData(data)
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[buildings] fetch failed:', err)
      }
    }
  }, 300)

  onCleanup(() => {
    clearTimeout(timer)
    controller?.abort()
  })
})

// Land-price filter expression: keep points whose price is within [min, max].
// MapLibre filters at render time, so this hides/shows points with no refetch.
function priceFilter(min: number, max: number) {
  return ['all', ['>=', ['get', 'price_per_sqm'], min], ['<=', ['get', 'price_per_sqm'], max]]
}

// Toggle visibility imperatively rather than re-adding layers. `watch` is the
// right tool: it fires on change with the new value. Guard for the layer existing
// since the data fetch is async and may not have added it yet.
function setLayersVisible(ids: string[], visible: boolean) {
  for (const id of ids) {
    if (map?.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  }
}
watch(showBuildings, (v) => {
  setLayersVisible(BUILDING_LAYERS, v)
  // First toggle-on: the viewportBbox watch skipped while showBuildings was false,
  // so no data has been fetched yet. Trigger a fetch by writing the current bbox.
  if (v && map) {
    const b = map.getBounds()
    viewportBbox.value = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
  }
})
watch(showWeather, (v) => setLayersVisible(WEATHER_LAYERS, v))
watch(showLandPrice, (v) => {
  setLayersVisible(LAND_PRICE_LAYERS, v)
  // Clear the list immediately when the layer hides; repopulate after next render
  // when it shows again.
  if (!v) store.viewportFeatures = []
  else map?.once('render', updateViewportFeatures)
})

// Re-apply the price filter whenever either bound changes. Watching both refs;
// `setFilter` re-evaluates the existing layer — no source refetch.
// Wait for the next render before re-querying: setFilter takes effect on the next
// paint, so querying immediately would return stale results.
watch([priceMin, priceMax], ([min, max]) => {
  if (map?.getLayer('land-price-points')) {
    map.setFilter('land-price-points', priceFilter(min, max))
    map.once('render', updateViewportFeatures)
  }
})

onUnmounted(() => {
  // Symmetric teardown: dispose the GL context + listeners, or we leak across
  // HMR and route changes. See CLAUDE.md trap #5.
  weatherController?.abort()
  map?.remove()
  map = null
})
</script>

<!-- Single root element: a multi-root (fragment) template left the `container`
     ref unbound when onMounted fired during client-only hydration (trap #11). -->
<template>
  <div class="map-view">
    <div ref="container" class="map-root" />

    <!-- Layer toggles + filters live in <ControlPanel>; both it and this map read
         the same Pinia store. Legends stay here since they depend on map data. -->
    <div class="legends">
      <div v-if="showWeather && weatherLegend.length" class="legend">
        <span class="legend-title">Summer avg °C</span>
        <span v-for="[value, color] in weatherLegend" :key="color" class="legend-item">
          <span class="swatch" :style="{ background: color }" />{{ value.toFixed(1) }}
        </span>
      </div>

      <div v-if="showLandPrice" class="legend">
        <span class="legend-title">Land ¥/m²</span>
        <span v-for="[value, color] in PRICE_STOPS" :key="value" class="legend-item">
          <span class="swatch" :style="{ background: color }" />{{ formatYen(value) }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-view {
  position: absolute;
  inset: 0;
}

.map-root {
  position: absolute;
  inset: 0;
}

.legends {
  position: absolute;
  bottom: 12px;
  left: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.legend {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.9);
  border-radius: 6px;
  font: 12px/1 system-ui, sans-serif;
}

.legend-title {
  font-weight: 600;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.swatch {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.2);
}
</style>
