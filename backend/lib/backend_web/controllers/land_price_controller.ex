defmodule BackendWeb.LandPriceController do
  @moduledoc """
  Serves the land-price layer as normalized GeoJSON. Shaping lives in
  `Backend.LandPrice`; the controller only maps results to HTTP.
  """
  use BackendWeb, :controller

  def index(conn, params) do
    case Backend.LandPrice.fetch_feature_collection(params["bbox"]) do
      {:ok, feature_collection} ->
        json(conn, feature_collection)

      {:error, _reason} ->
        conn
        |> put_status(:bad_gateway)
        |> json(%{error: "land_price_source_unavailable"})
    end
  end
end
