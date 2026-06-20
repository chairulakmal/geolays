# Static datasets

Committed open-data files served by the backend (no DB — see CLAUDE.md).

For each file's source, license, raw format, and the transformations applied, see the
canonical **[DATA.md](../../../DATA.md)** at the project root. Quick index:

- `weather_summer_avg_tokyo.geojson` — avg summer temp grid (Open-Meteo archive), clipped to Tokyo.
- `weather_summer_avg.ingest.mjs` — one-off ingest that generates the weather file.
- `land_price_tokyo_L01-23_13.geojson` — MLIT 地価公示 L01 land price, 2023, Tokyo (raw).
- `tokyo_mainland.geojson` — Tokyo mainland boundary, used to clip the weather grid.
