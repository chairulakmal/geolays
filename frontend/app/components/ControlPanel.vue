<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { PRICE_MAX, PRICE_MIN, useQueryStore } from '~/stores/query'

// This panel is a sibling of the map — they share state ONLY through the store,
// not via props/events. That's the point of step 4 (problem #4): clean shared
// query state, no prop drilling.
const store = useQueryStore()

// storeToRefs keeps reactivity when pulling state out of the store. Plain
// destructuring (`const { priceMin } = store`) would copy the value and break
// two-way binding. See CLAUDE.md trap #1.
const { showWeather, showLandPrice, priceMin, priceMax, weatherFault, weatherStatus } = storeToRefs(store)

// Land price is log-distributed (¥1.5k–¥53.8M), so the sliders operate in log
// space — a linear slider would cram ~90% of points into the bottom few percent.
const LOG_MIN = Math.log10(PRICE_MIN)
const LOG_MAX = Math.log10(PRICE_MAX)
const toSlider = (price: number) => ((Math.log10(price) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100
const toPrice = (slider: number) => 10 ** (LOG_MIN + (slider / 100) * (LOG_MAX - LOG_MIN))

// Slider <-> store adapters. The min slider can't cross the max and vice versa.
const minSlider = computed({
  get: () => toSlider(priceMin.value),
  set: (s) => (priceMin.value = Math.min(toPrice(s), priceMax.value))
})
const maxSlider = computed({
  get: () => toSlider(priceMax.value),
  set: (s) => (priceMax.value = Math.max(toPrice(s), priceMin.value))
})

const fmt = (v: number) =>
  v >= 1_000_000 ? `¥${(v / 1_000_000).toFixed(1)}M` : `¥${Math.round(v / 1000)}k`
</script>

<template>
  <div class="panel">
    <fieldset>
      <legend>Layers</legend>
      <!-- Weather row: toggle + per-source status dot + retry (problem #7). -->
      <div class="layer-row">
        <label><input v-model="showWeather" type="checkbox"> Weather (summer avg)</label>
        <span class="status-dot" :class="weatherStatus" :title="weatherStatus" />
      </div>
      <button
        v-if="weatherStatus === 'error'"
        class="retry-btn"
        @click="store.retryWeather()"
      >
        Retry weather
      </button>
      <label><input v-model="showLandPrice" type="checkbox"> Land price</label>
    </fieldset>

    <!-- Fault injection: adds ?fault=<mode> to the weather fetch so the backend
         simulates a broken upstream. Toggling immediately retriggers a fetch so
         the effect is visible in real time (problem #7). -->
    <fieldset>
      <legend>Simulate failure</legend>
      <div class="fault-row">
        <label class="fault-label" for="weather-fault">Weather</label>
        <select id="weather-fault" v-model="weatherFault" class="fault-select">
          <option value="none">Normal</option>
          <option value="error">Error (502)</option>
          <option value="delay">Slow (3 s)</option>
        </select>
      </div>
    </fieldset>

    <fieldset :disabled="!showLandPrice">
      <legend>Land price ¥/m²</legend>
      <!-- Two range inputs overlaid on one track (no native dual-slider). The track
           shows the selected span; the two thumbs are the min and max handles. -->
      <div class="dual">
        <div class="track"><div class="fill" :style="{ left: `${minSlider}%`, width: `${maxSlider - minSlider}%` }" /></div>
        <input v-model.number="minSlider" type="range" min="0" max="100" step="0.5" aria-label="Minimum price" >
        <input v-model.number="maxSlider" type="range" min="0" max="100" step="0.5" aria-label="Maximum price" >
      </div>
      <div class="readout">
        <span>Min <b>{{ fmt(priceMin) }}</b></span>
        <span>Max <b>{{ fmt(priceMax) }}</b></span>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 44px;
  left: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 190px;
  font: 12px/1.4 system-ui, sans-serif;
}

fieldset {
  margin: 0;
  padding: 6px 10px 8px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 6px;
}

fieldset:disabled {
  opacity: 0.5;
}

legend {
  font-weight: 600;
  padding: 0 4px;
}

label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.layer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.layer-row label {
  flex: 1;
}

/* Per-source status indicator (problem #7). A coloured dot next to each layer
   shows its fetch state independently — the rest of the app stays readable while
   one source is broken. */
.status-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af; /* default / loading */
}
.status-dot.ok      { background: #16a34a; }
.status-dot.error   { background: #dc2626; }
.status-dot.loading { background: #9ca3af; animation: pulse 1s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}

.retry-btn {
  display: block;
  width: 100%;
  margin: 4px 0 2px;
  padding: 3px 0;
  font: 11px/1.4 system-ui, sans-serif;
  color: #dc2626;
  background: none;
  border: 1px solid #dc2626;
  border-radius: 4px;
  cursor: pointer;
}
.retry-btn:hover { background: #fef2f2; }

.fault-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.fault-label {
  font-size: 11px;
  color: #6b7280;
}

.fault-select {
  font: 11px/1.4 system-ui, sans-serif;
  padding: 2px 4px;
  border: 1px solid rgba(0,0,0,0.2);
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

/* Dual-handle range: two sliders stacked on one track. */
.dual {
  position: relative;
  height: 20px;
}

.dual .track {
  position: absolute;
  top: 8px;
  left: 0;
  right: 0;
  height: 4px;
  background: #d8d8d8;
  border-radius: 2px;
}

.dual .track .fill {
  position: absolute;
  height: 100%;
  background: #2563eb;
  border-radius: 2px;
}

/* Both inputs share the track; only their thumbs are interactive so each handle
   stays draggable. The tracks themselves are transparent + click-through. */
.dual input[type='range'] {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 20px;
  margin: 0;
  background: transparent;
  pointer-events: none;
  -webkit-appearance: none;
  appearance: none;
}

.dual input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #2563eb;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
  cursor: pointer;
}

.dual input[type='range']::-moz-range-thumb {
  pointer-events: auto;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #2563eb;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
  cursor: pointer;
}

.readout {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
  color: #333;
}
</style>
