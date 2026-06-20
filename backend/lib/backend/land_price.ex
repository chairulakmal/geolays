defmodule Backend.LandPrice do
  @moduledoc """
  MLIT land-price source (国土数値情報 地価公示 / L01), served from a static file
  committed under `priv/data/`. See that dir's README for provenance.

  Normalizes MLIT's opaque coded fields (`L01_006`, `L01_024`, …) into the same
  kind of clean, documented GeoJSON contract the weather layer uses — so the
  frontend never sees `L01_*`. This is the static-dataset counterpart to
  `Backend.Weather`; both prove normalization belongs on the backend (problem #5).

  The file is large (~8 MB, 2,602 features) and never changes at runtime, so we
  parse + normalize it ONCE and memoize via `:persistent_term`. (Per-viewport
  caching is a separate concern — problem #6.)
  """

  @path "data/land_price_tokyo_L01-23_13.geojson"

  @doc """
  The normalized land-price layer as a GeoJSON `FeatureCollection`.

  `bbox` is an optional `"west,south,east,north"` string. When provided, only
  features within those bounds are returned. The full normalized collection is
  cached in `:persistent_term`; bbox filtering happens per-request at negligible
  cost (2,602 Enum.filter over pre-parsed maps). This is the server-side half of
  problem #6 — the frontend debounces + caches, the backend filters.

  Returns `{:ok, map}`, or `{:error, reason}` if the file is missing/unreadable.
  """
  def fetch_feature_collection(bbox \\ nil) do
    case Backend.GeoJsonFile.load(@path, {__MODULE__, :cache}, &normalize_collection/1) do
      {:ok, fc} -> {:ok, filter_by_bbox(fc, bbox)}
      error -> error
    end
  end

  # Returns the collection unchanged when no bbox is given, or when the param is
  # malformed (rather than erroring — bad params return all features gracefully).
  defp filter_by_bbox(fc, nil), do: fc

  defp filter_by_bbox(%{features: features} = fc, bbox_str) do
    case parse_bbox(bbox_str) do
      {:ok, [west, south, east, north]} ->
        filtered =
          Enum.filter(features, fn
            %{geometry: %{"coordinates" => [lon, lat]}} when is_number(lon) and is_number(lat) ->
              lon >= west and lon <= east and lat >= south and lat <= north
            # Non-point or unexpected coordinate structure — keep the feature rather
            # than raising FunctionClauseError. All L01 features are Points so this
            # branch only fires if the data ever contains a LineString or Polygon.
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

      if Enum.any?(coords, &(&1 == :error)),
        do: :error,
        else: {:ok, coords}
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

  # Keep the geometry as-is; map only the coded fields we actually use into clean,
  # documented keys. Everything else (141 columns of history/bitmasks) is dropped.
  defp normalize(%{"geometry" => geometry, "properties" => p}) do
    %{
      type: "Feature",
      geometry: geometry,
      properties: %{
        price_per_sqm: p["L01_006"],
        change_pct: p["L01_007"],
        use: p["L01_028"],
        zoning: p["L01_050"],
        ward: p["L01_023"],
        # MLIT addresses use a full-width space after 東京都 — tidy it for display.
        address: clean_address(p["L01_024"]),
        year: p["L01_005"]
      }
    }
  end

  defp clean_address(nil), do: nil

  defp clean_address(addr) do
    addr |> String.replace("　", " ") |> String.trim()
  end
end
