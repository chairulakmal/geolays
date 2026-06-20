// One-off ingest: builds `weather_summer_avg_tokyo.geojson` — the average summer
// (Jun–Aug) air temperature over a grid of mainland-Tokyo points, from Open-Meteo's
// historical ARCHIVE API. We compute this once and commit the result so the app
// serves a stable static file (no live calls, no rate limits) — same pattern as
// the land-price layer. Re-run with: `node weather_summer_avg.ingest.mjs`.
//
// Grid MUST match Backend.Weather (even pixel spacing): lon step 0.04°, lat step
// scaled by cos(lat). Output is already in our normalized GeoJSON contract.
import { readFile, writeFile } from 'node:fs/promises'

// Mainland Tokyo bbox (covers the 23 wards + Tama incl. Okutama in the west).
const LAT_MIN = 35.5
const LAT_MAX = 35.9
const LON_MIN = 138.94
const LON_MAX = 139.92
const LON_STEP = 0.04
const SUMMERS = [2022, 2023, 2024] // years to average over

const meanLat = (LAT_MIN + LAT_MAX) / 2
const latStep = LON_STEP * Math.cos((meanLat * Math.PI) / 180)

const axis = (min, max, step) => {
  const n = Math.round((max - min) / step)
  return Array.from({ length: n + 1 }, (_, i) => +(min + i * step).toFixed(4))
}

// Ray-casting point-in-polygon, handling MultiPolygon outer rings + holes, so we
// keep only grid points that fall INSIDE Tokyo (the bbox grid otherwise spills
// into Tokyo Bay, Saitama, Kanagawa…). Boundary committed alongside this script.
const pointInRing = (x, y, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const pointInMultiPolygon = (x, y, mp) =>
  mp.some((poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h)))

const tokyo = JSON.parse(await readFile(new URL('./tokyo_mainland.geojson', import.meta.url)))
const tokyoMP = tokyo.geometry.coordinates

const lats = axis(LAT_MIN, LAT_MAX, latStep)
const lons = axis(LON_MIN, LON_MAX, LON_STEP)
const points = [] // [lat, lon], lat outer / lon inner
for (const lat of lats) {
  for (const lon of lons) {
    if (pointInMultiPolygon(lon, lat, tokyoMP)) points.push([lat, lon])
  }
}
console.log(`grid points inside Tokyo: ${points.length}`)

const latParam = points.map((p) => p[0]).join(',')
const lonParam = points.map((p) => p[1]).join(',')

const sums = new Array(points.length).fill(0)
const counts = new Array(points.length).fill(0)

for (const year of SUMMERS) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${latParam}` +
    `&longitude=${lonParam}&start_date=${year}-06-01&end_date=${year}-08-31` +
    `&daily=temperature_2m_mean&timezone=Asia%2FTokyo`

  process.stdout.write(`fetching summer ${year} for ${points.length} points… `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`archive ${year}: HTTP ${res.status}`)
  const body = await res.json()
  const locs = Array.isArray(body) ? body : [body]
  locs.forEach((loc, i) => {
    for (const t of loc.daily.temperature_2m_mean) {
      if (Number.isFinite(t)) {
        sums[i] += t
        counts[i] += 1
      }
    }
  })
  console.log('ok')
}

const features = points.map(([lat, lon], i) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] }, // GeoJSON is [lon, lat]
  properties: {
    temperature: counts[i] ? +(sums[i] / counts[i]).toFixed(1) : null,
    unit: 'celsius',
    metric: `summer_avg_${SUMMERS[0]}_${SUMMERS.at(-1)}`
  }
}))

const fc = { type: 'FeatureCollection', features }
await writeFile(new URL('./weather_summer_avg_tokyo.geojson', import.meta.url), JSON.stringify(fc))
console.log(`wrote ${features.length} features`)
