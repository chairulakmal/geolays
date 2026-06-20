// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // Pinia is the single home for shared query state (viewport, filters, layer
  // toggles). See CLAUDE.md "Decisions already made". The module auto-imports
  // defineStore + the stores in app/stores/.
  modules: ['@pinia/nuxt'],

  runtimeConfig: {
    public: {
      // Backend (Phoenix) base URL. Kept in runtimeConfig so the Railway deploy
      // is a config change, not a code change — see CLAUDE.md trap #10.
      // Override at runtime with NUXT_PUBLIC_API_BASE.
      apiBase: 'http://localhost:4000'
    }
  }
})
