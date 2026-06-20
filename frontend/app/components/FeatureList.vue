<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { storeToRefs } from 'pinia'
import { useQueryStore } from '~/stores/query'

const store = useQueryStore()
// storeToRefs keeps reactivity when destructuring (CLAUDE.md trap #1).
const { viewportFeatures, showLandPrice } = storeToRefs(store)

// computed is cached — re-runs only when viewportFeatures changes, not on every
// render. A plain method called in the template re-runs every render. See CLAUDE.md trap #8.
const displayRows = computed(() =>
  viewportFeatures.value.map((f) => ({
    price: fmt((f.properties.price_per_sqm as number) ?? 0),
    ward: String(f.properties.ward ?? ''),
    address: String(f.properties.address ?? ''),
  }))
)

function fmt(v: number): string {
  return v >= 1_000_000 ? `¥${(v / 1_000_000).toFixed(1)}M` : `¥${Math.round(v / 1000)}k`
}

// The scroll container ref passed to the virtualizer.
const parentRef = ref<HTMLElement | null>(null)

// useVirtualizer renders only the rows in (and near) the scroll viewport —
// typically 15–20 DOM nodes regardless of total count. Without this, v-for over
// thousands of rows creates thousands of DOM nodes and causes scroll jank as Vue
// diffs them on every update. This is the core lesson of problem #1.
// See CLAUDE.md trap #7.
//
// Options are wrapped in computed() so the virtualizer reacts when displayRows
// changes length. A plain options object would bake in the initial count.
const virtualizer = useVirtualizer(
  computed(() => ({
    count: displayRows.value.length,
    getScrollElement: () => parentRef.value,
    // Fixed row height (52px). Could use dynamic sizes with measureElement for
    // variable-height rows, but fixed is simpler and the rows are uniform here.
    estimateSize: () => 52,
    // Overscan: render 5 extra rows above/below the visible window to hide the
    // blank flash when scrolling fast.
    overscan: 5,
  }))
)
</script>

<template>
  <aside class="feature-list">
    <header class="list-header">
      <span class="list-title">Land price</span>
      <span class="list-count">{{ displayRows.length }} in view</span>
    </header>

    <div v-if="!showLandPrice" class="list-empty">Layer hidden</div>
    <div v-else-if="displayRows.length === 0" class="list-empty">No features in view</div>

    <!-- The scroll container. The virtualizer measures its clientHeight to know
         how many rows fit. overflow-y: auto is required. -->
    <div v-else ref="parentRef" class="list-scroll">
      <!-- One div sized to the FULL list height so the scrollbar is proportional
           to the total count. Only ~20 absolutely-positioned rows are in the DOM;
           the virtualizer repositions them as you scroll. -->
      <div :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
        <div
          v-for="row in virtualizer.getVirtualItems()"
          :key="row.key"
          class="list-row"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          <span class="row-price">{{ displayRows[row.index].price }}/m²</span>
          <span class="row-meta">
            {{ displayRows[row.index].ward }}
            <template v-if="displayRows[row.index].address">
              · {{ displayRows[row.index].address }}
            </template>
          </span>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.feature-list {
  display: flex;
  flex-direction: column;
  width: 260px;
  flex-shrink: 0;
  background: #f8f9fa;
  border-left: 1px solid #e2e4e8;
  font: 12px/1.4 system-ui, sans-serif;
  overflow: hidden;
}

.list-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 12px 8px;
  border-bottom: 1px solid #e2e4e8;
  background: #fff;
  flex-shrink: 0;
}

.list-title {
  font-weight: 600;
  font-size: 13px;
  color: #111;
}

.list-count {
  color: #6b7280;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.list-empty {
  padding: 20px 12px;
  color: #9ca3af;
  text-align: center;
}

/* overflow-y: auto is what the virtualizer measures — required. */
.list-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

.list-row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 52px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 12px;
  border-bottom: 1px solid #e9eaec;
  box-sizing: border-box;
}

.list-row:hover {
  background: #f0f4ff;
}

.row-price {
  font-weight: 600;
  color: #111;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.row-meta {
  color: #6b7280;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
</style>
