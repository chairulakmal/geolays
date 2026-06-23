// One-off ingest: builds three output files:
//   1. `weather_summer_avg_tokyo.geojson` — 139 point features with temperature (kept for
//      backend serve / debugging).
//   2. `weather_tokyo_idw.png`     — IDW raster covering the Tokyo bbox, one pixel per
//      ~0.002° (~200m). Served as a MapLibre `image` source — no discrete dots at zoom.
//   3. `weather_tokyo_idw_meta.json` — tiny metadata (tMin, tMax, bbox, ramp) for the
//      frontend legend. Zero external deps: uses Node's built-in `zlib.deflateSync` for
//      the PNG encoder.
//
// Re-run with: `node weather_summer_avg.ingest.mjs`.
import { readFile, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

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

// ─── IDW raster PNG ─────────────────────────────────────────────────────────
// Rasterise the 139 point temperatures onto a pixel grid via Inverse Distance
// Weighting (power=2). Produces a continuous temperature field at any zoom —
// the discrete-circle artefacts of the old circle layer disappear completely.
// Pixels outside the Tokyo polygon are transparent (alpha=0).

const W = 512, H = 256          // covers the bbox at ~200m/pixel
const IDW_POWER = 2
const RAMP = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c']  // cold→hot

const validPts = features
  .filter(f => f.properties.temperature !== null)
  .map(f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], temp: f.properties.temperature }))

const allTemps = validPts.map(p => p.temp)
const tMin = Math.min(...allTemps)
const tMax = Math.max(...allTemps)

// Hex '#rrggbb' → [r, g, b]
const hexRGB = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

// Map t ∈ [0,1] to an interpolated RAMP colour → [r, g, b]
const rampColor = t => {
  const s = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(Math.floor(s), RAMP.length - 2)
  const f = s - i
  const [r0, g0, b0] = hexRGB(RAMP[i])
  const [r1, g1, b1] = hexRGB(RAMP[i + 1])
  return [Math.round(r0 + (r1 - r0) * f), Math.round(g0 + (g1 - g0) * f), Math.round(b0 + (b1 - b0) * f)]
}

// IDW interpolation: 1/d^p weighted average of all known point temperatures.
// Exact match (d<ε) returns the point's own value to avoid division by zero.
const idwTemp = (lon, lat) => {
  let sumW = 0, sumWT = 0
  for (const p of validPts) {
    const d2 = (lon - p.lon) ** 2 + (lat - p.lat) ** 2
    if (d2 < 1e-10) return p.temp
    const w = 1 / d2 ** (IDW_POWER / 2)
    sumW += w; sumWT += w * p.temp
  }
  return sumW > 0 ? sumWT / sumW : null
}

// Build RGBA pixel buffer — row-major, top-to-bottom (PNG y=0 is the top)
const pixBuf = Buffer.alloc(W * H * 4)  // zero-initialised → alpha=0 by default
process.stdout.write(`rasterising ${W}×${H} IDW grid… `)
for (let py = 0; py < H; py++) {
  // Invert y: py=0 → LAT_MAX (north), py=H-1 → LAT_MIN (south)
  const lat = LAT_MAX - (py + 0.5) / H * (LAT_MAX - LAT_MIN)
  for (let px = 0; px < W; px++) {
    const lon = LON_MIN + (px + 0.5) / W * (LON_MAX - LON_MIN)
    if (!pointInMultiPolygon(lon, lat, tokyoMP)) continue  // transparent outside Tokyo
    const temp = idwTemp(lon, lat)
    if (temp === null) continue
    const [r, g, b] = rampColor((temp - tMin) / (tMax - tMin))
    const off = (py * W + px) * 4
    pixBuf[off] = r; pixBuf[off + 1] = g; pixBuf[off + 2] = b; pixBuf[off + 3] = 255
  }
}
console.log('done')

// ─── Zero-dep PNG encoder (Node built-in zlib only) ─────────────────────────
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
const crc32 = buf => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type, 'ascii')
  const crcVal = crc32(Buffer.concat([typeBytes, data]))
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBytes.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crcVal, 8 + data.length)
  return out
}

// Raw scanlines: each row starts with a filter byte 0x00 (None), then W×4 RGBA bytes
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0  // filter type: None
  pixBuf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8   // bit depth per channel
ihdr[9] = 6   // colour type: RGBA (truecolour + alpha)

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', deflateSync(raw, { level: 6 })),
  pngChunk('IEND', Buffer.alloc(0))
])
await writeFile(new URL('./weather_tokyo_idw.png', import.meta.url), png)
console.log(`wrote weather_tokyo_idw.png (${(png.length / 1024).toFixed(1)} KB)`)

const meta = {
  tMin, tMax,
  ramp: RAMP,
  bbox: { lonMin: LON_MIN, lonMax: LON_MAX, latMin: LAT_MIN, latMax: LAT_MAX },
  width: W, height: H,
  metric: `summer_avg_${SUMMERS[0]}_${SUMMERS.at(-1)}`
}
await writeFile(new URL('./weather_tokyo_idw_meta.json', import.meta.url), JSON.stringify(meta, null, 2))
console.log(`wrote weather_tokyo_idw_meta.json (tMin=${tMin.toFixed(1)}, tMax=${tMax.toFixed(1)})`)
