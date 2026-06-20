defmodule Backend.Buildings do
  @moduledoc """
  OSM building footprint polygons for central Tokyo, served from a static GeoJSON
  file committed under `priv/data/`. See `priv/data/buildings.ingest.mjs` for how
  the file is produced.

  This is the polygon counterpart to `Backend.LandPrice` (points). The data shape
  is simpler (OSM tags are already human-readable; no opaque coded fields to rename),
  so normalization is lighter — we just pick the properties we actually use and drop
  the raw OSM metadata the frontend doesn't need.

  File is cached in `:persistent_term` on first read (same pattern as LandPrice +
  Weather). At ~10k polygon features the parse cost is real; caching it means every
  subsequent request is a memory lookup plus a fast Enum.filter.

  The backend supports optional bbox filtering via `?bbox=west,south,east,north`,
  but the frontend loads the full dataset once on map load — the MapLibre source
  handles viewport culling on the GPU. The bbox param is here for consistency with
  the land-price endpoint and for the "if you needed it" interview story.
  """

  @path "data/buildings_tokyo.geojson"

  @doc """
  Returns the buildings `FeatureCollection`.

  `bbox` is an optional `"west,south,east,north"` string. When given, filters by
  polygon centroid (fast approximation — good enough for axis-aligned viewports).
  Returns `{:ok, map}` or `{:error, reason}` if the file is missing (run the
  ingest script first: `node backend/priv/data/buildings.ingest.mjs`).
  """
  def fetch_feature_collection(bbox \\ nil) do
    case Backend.GeoJsonFile.load(@path, {__MODULE__, :cache}, &normalize_collection/1) do
      {:ok, fc} -> {:ok, filter_by_bbox(fc, bbox)}
      error -> error
    end
  end

  defp filter_by_bbox(fc, nil), do: fc

  defp filter_by_bbox(%{features: features} = fc, bbox_str) do
    case parse_bbox(bbox_str) do
      {:ok, [west, south, east, north]} ->
        filtered =
          Enum.filter(features, fn
            %{geometry: %{"type" => "Polygon", "coordinates" => [outer | _]}} when is_list(outer) ->
              # Centroid of the outer ring: fast O(n) approximation.
              # All outer ring coords are [lon, lat] arrays (GeoJSON convention).
              n = length(outer)

              if n == 0 do
                true
              else
                {lon_sum, lat_sum} =
                  Enum.reduce(outer, {0.0, 0.0}, fn [lon, lat], {ls, la} ->
                    {ls + lon, la + lat}
                  end)

                clon = lon_sum / n
                clat = lat_sum / n
                clon >= west and clon <= east and clat >= south and clat <= north
              end

            # Pass through any non-Polygon geometry without crashing.
            _ ->
              true
          end)

        %{fc | features: filtered}

      :error ->
        fc
    end
  end

  defp parse_bbox(str) do
    parts = String.split(str, ",")

    if length(parts) != 4 do
      :error
    else
      coords = Enum.map(parts, &parse_float/1)
      if Enum.any?(coords, &(&1 == :error)), do: :error, else: {:ok, coords}
    end
  end

  defp parse_float(s) do
    case Float.parse(s) do
      {f, _} -> f
      :error -> :error
    end
  end

  defp normalize_collection(%{"features" => features}) do
    %{type: "FeatureCollection", features: Enum.map(features, &normalize/1)}
  end

  # OSM properties are already human-readable (unlike MLIT's opaque L01_* codes),
  # so normalization here is mostly selection: pick what the frontend uses, drop the
  # rest (e.g. raw osm_id, any ingest metadata). Geometry passes through unchanged.
  defp normalize(%{"geometry" => geometry, "properties" => p}) do
    %{
      type: "Feature",
      geometry: geometry,
      properties: %{
        building: p["building"] || "yes",
        name: p["name"],
        name_en: p["name_en"],
        height: p["height"],
        levels: p["levels"]
      }
    }
  end
end
