<script setup lang="ts">
import { onMounted, ref } from 'vue'

const config = useRuntimeConfig()
const apiStatus = ref<'checking' | 'ok' | 'down'>('checking')

// Ping the backend from the BROWSER on mount. We use $fetch (not useFetch) on
// purpose: the point of step 1 is to prove a cross-origin browser→API call
// succeeds — i.e. CORS is configured. A useFetch would run during SSR on the
// Nuxt server and never exercise the browser CORS path. See CLAUDE.md trap #9.
onMounted(async () => {
  try {
    const res = await $fetch<{ status: string }>('/api/health', {
      baseURL: config.public.apiBase
    })
    apiStatus.value = res.status === 'ok' ? 'ok' : 'down'
  } catch {
    apiStatus.value = 'down'
  }
})
</script>

<template>
  <div class="app">
    <!-- Map area grows to fill remaining width. Position relative so the
         absolutely-positioned MapView, ControlPanel, and status badge sit inside it. -->
    <div class="map-area">
      <MapView />
      <!-- Siblings of the map; they share state via the Pinia store, not props. -->
      <ControlPanel />
      <div class="status" :class="apiStatus">
        API: {{ apiStatus === 'checking' ? '…' : apiStatus === 'ok' ? 'ok' : 'unreachable' }}
      </div>
    </div>
    <!-- FeatureList reads viewportFeatures from the same store MapView writes to.
         No props, no events — problem #1 + #4 sharing one source of truth. -->
    <FeatureList />
  </div>
</template>

<!-- Global reset so the layout can fill the viewport. -->
<style>
html,
body,
#__nuxt {
  height: 100%;
  margin: 0;
}
</style>

<style scoped>
.app {
  display: flex;
  height: 100vh;
}

/* flex: 1 + min-width: 0 so the map shrinks to give the list panel its space. */
.map-area {
  position: relative;
  flex: 1;
  min-width: 0;
}

.status {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 10;
  padding: 4px 10px;
  border-radius: 6px;
  font: 12px/1.4 system-ui, sans-serif;
  color: #fff;
}

.status.ok {
  background: #16a34a;
}

.status.down {
  background: #dc2626;
}

.status.checking {
  background: #6b7280;
}
</style>
