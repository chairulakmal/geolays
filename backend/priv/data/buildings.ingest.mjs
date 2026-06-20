// One-off ingest: builds `buildings_tokyo.geojson` — building footprint polygons
// for central Tokyo, fetched from OpenStreetMap via the Overpass API.
// Run: node buildings.ingest.mjs
//
// Why OSM: freely accessible with no key, automatable, and building coverage for
// Tokyo is excellent. Geometry is equivalent to PLATEAU LOD0 (2D footprints).
// For a production dataset, replace with PLATEAU GeoJSON from
// https://www.geospatial.jp/ckan/dataset (same pipeline, larger file, official source).
//
// Why static: same philosophy as the land-price and weather layers — compute once,
// commit the result, serve a stable file. At this scale (~10k features) the GeoJSON
// fits in memory and serves fast. At 50k+ features or when you need per-tile
// simplification, switch to tippecanoe → PMTiles and a vector-tile source in MapLibre.
import { writeFile } from 'node:fs/promises'
import { request } from 'node:https'

// Shinjuku ward (新宿区) core. The first run against the full central-Tokyo bbox
// returned 207k features (~150 MB) — proof that 50k+ features require vector tiles.
// We cap at LIMIT features for the committed demo file; the per-viewport bbox fetch
// in the frontend means the user only ever receives a small slice anyway.
// To produce the full dataset: set LIMIT to Infinity and run tippecanoe on the output.
// bbox format for Overpass: south,west,north,east (lat before lon — Overpass convention).
const OVERPASS_BBOX = '35.677,139.685,35.715,139.745'
const LIMIT = 8000

const QUERY = `[out:json][timeout:120];
way["building"](${OVERPASS_BBOX});
out ${LIMIT} geom;
`

console.log('Fetching Tokyo building footprints from Overpass API…')
console.log(`Bbox (S,W,N,E): ${OVERPASS_BBOX}`)

// Tries each Overpass instance in order, returning the first successful parse.
// overpass-api.de returns 406 in some network environments; kumi.systems is a
// reliable public mirror that accepts the same query format.
const INSTANCES = [
  { hostname: 'overpass.kumi.systems',  path: '/api/interpreter' }, // worked on first run
  { hostname: 'lz4.overpass-api.de',   path: '/api/interpreter' },
  { hostname: 'overpass-api.de',        path: '/api/interpreter' },
]

function overpassPost(query, instance) {
  const body = `data=${encodeURIComponent(query)}`
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: instance.hostname,
        path: instance.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept': '*/*',
          'User-Agent': 'geolays-ingest/1.0',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          if (res.statusCode !== 200) reject(new Error(`Overpass ${res.statusCode} from ${instance.hostname}: ${text.slice(0, 200)}`))
          else resolve(JSON.parse(text))
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

let result
for (const instance of INSTANCES) {
  try {
    console.log(`Trying ${instance.hostname}…`)
    result = await overpassPost(QUERY, instance)
    console.log(`OK from ${instance.hostname}`)
    break
  } catch (err) {
    console.warn(`  failed: ${err.message.split('\n')[0]}`)
  }
}
if (!result) throw new Error('All Overpass instances failed')
const { elements } = result
console.log(`Received ${elements.length} raw Overpass elements`)

// Convert an Overpass way (with `out geom` inline geometry) → GeoJSON Polygon Feature.
// `out geom` attaches each node's {lat, lon} directly, so no second-pass node lookup.
// Overpass coords: {lat, lon}; GeoJSON Polygon: [[lon, lat], ...] — note lon-first.
// (CLAUDE.md note: GeoJSON coordinates are [lon, lat], opposite of spoken "lat, lon".)
function wayToFeature(way) {
  const ring = way.geometry.map(({ lon, lat }) => [lon, lat])
  // GeoJSON linear rings must be closed (last coord equals first).
  const [first] = ring
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])

  const tags = way.tags ?? {}
  return {
    type: 'Feature',
    id: way.id,
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      osm_id: way.id,
      // "yes" is the OSM default when no specific type tag is present.
      building: tags.building ?? 'yes',
      name: tags.name ?? null,
      name_en: tags['name:en'] ?? null,
      // height (metres) and levels come from optional OSM tags; null when absent.
      height: tags.height ? parseFloat(tags.height) : null,
      levels: tags['building:levels'] ? parseInt(tags['building:levels'], 10) : null,
    },
  }
}

const features = elements
  .filter(el => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3)
  .map(wayToFeature)

const fc = {
  type: 'FeatureCollection',
  features,
}

const outPath = new URL('./buildings_tokyo.geojson', import.meta.url)
await writeFile(outPath, JSON.stringify(fc))
console.log(`Wrote ${features.length} building features → buildings_tokyo.geojson`)
console.log('Run this script again to refresh (e.g. to expand the bbox).')
