defmodule Backend.Weather do
  @moduledoc """
  Weather layer: **average summer (Jun–Aug) air temperature** over a grid of
  mainland-Tokyo points, served from a static file in `priv/data/`.

  We used to proxy Open-Meteo live, but live current-temp barely varies across
  Tokyo and the free API rate-limits frequent calls (502s). Instead we precompute
  a stable climatology once (`weather_summer_avg.ingest.mjs`, averaging 2022–2024
  summers from Open-Meteo's archive API) and commit the result — same static-data
  pattern as `Backend.LandPrice`. See that dir's README for provenance.

  The file is already in this project's internal contract — a GeoJSON
  `FeatureCollection` of Points with `properties.temperature` (°C) + `unit` — so
  serving is just read + cache. Parsed once and memoized via `:persistent_term`.
  """

  @path "data/weather_summer_avg_tokyo.geojson"

  @doc """
  The weather layer as a GeoJSON `FeatureCollection`. Already in our contract, so
  no transform — just load + cache. Returns `{:ok, map}` or `{:error, reason}`.
  """
  def fetch_feature_collection do
    Backend.GeoJsonFile.load(@path, {__MODULE__, :cache})
  end
end
