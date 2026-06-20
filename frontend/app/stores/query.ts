import { defineStore } from 'pinia'
import { ref } from 'vue'

// Absolute land-price bounds (yen/m²) spanning the dataset (~¥1.5k–¥53.8M).
export const PRICE_MIN = 1_000
export const PRICE_MAX = 60_000_000

// Minimal feature shape shared between MapView (writes) and FeatureList (reads).
// Avoids importing maplibre-gl into the store; MapGeoJSONFeature is assignable to
// this since it has the same properties field.
export type ViewportFeature = { properties: Record<string, unknown> }

/**
 * The single source of truth for shared, cross-component query state: which
 * layers are active, the active filters, and the features currently visible in
 * the map viewport. The map and list both read from and write to this store —
 * no prop drilling between them. See CLAUDE.md "Architecture conventions" + problems #4, #1.
 *
 * Setup-style store: refs are state, returned together. Consumers must use
 * `storeToRefs` to destructure without losing reactivity (CLAUDE.md trap #1).
 */
export const useQueryStore = defineStore('query', () => {
  // Active layers — the map toggles MapLibre visibility from these.
  const showWeather = ref(true)
  const showLandPrice = ref(true)

  // Land-price filter (yen/m²). Drives the map (setFilter) and the list (computed).
  const priceMin = ref(PRICE_MIN)
  const priceMax = ref(PRICE_MAX)

  // Land-price features currently visible in the map viewport, updated by MapView
  // on moveend and after filter changes. FeatureList reads this — the two components
  // stay in sync without any direct coupling (problem #1).
  const viewportFeatures = ref<ViewportFeature[]>([])

  // Current map viewport bounding box [west, south, east, north], updated on
  // every moveend. Watched by MapView to drive debounced bbox-filtered fetches
  // (problem #6). null until the map has loaded.
  const viewportBbox = ref<[number, number, number, number] | null>(null)

  // Fault injection mode for the weather source (problem #7). When non-'none',
  // the weather fetch passes ?fault=<mode> to the backend, triggering the
  // corresponding simulation. Changing this immediately retriggers a fetch.
  const weatherFault = ref<'none' | 'error' | 'delay'>('none')

  // Per-source fetch status, so error states are isolated — land price stays
  // usable while weather is down. Read by ControlPanel for the status indicator.
  const weatherStatus = ref<'loading' | 'ok' | 'error'>('loading')

  // Internal counter incremented by retryWeather(). MapView watches this alongside
  // weatherFault to re-run loadWeatherData() on retry clicks.
  const weatherRetryTick = ref(0)
  function retryWeather() {
    weatherRetryTick.value++
  }

  return {
    showWeather, showLandPrice, priceMin, priceMax,
    viewportFeatures, viewportBbox,
    weatherFault, weatherStatus, weatherRetryTick, retryWeather,
  }
})
