defmodule BackendWeb.WeatherController do
  @moduledoc """
  Serves the weather layer as normalized GeoJSON. All shaping happens in
  `Backend.Weather`; the controller only maps results to HTTP.

  Supports fault injection via `?fault=<mode>` for problem #7 (graceful
  degradation). The frontend's fault toggle adds this param to the request;
  the backend simulates a broken upstream. Three clauses, matched in order:
    error  → immediate 502 (upstream down)
    delay  → 3-second sleep then normal response (slow upstream)
    absent → normal response
  """
  use BackendWeb, :controller

  # Simulate an upstream failure — returns 502 with no data.
  def index(conn, %{"fault" => "error"}) do
    conn
    |> put_status(:bad_gateway)
    |> json(%{error: "weather_source_unavailable", fault: "injected"})
  end

  # Simulate a slow upstream — blocks the request for 3s, then responds normally.
  # Shows the frontend's per-source loading state during the wait.
  def index(conn, %{"fault" => "delay"}) do
    Process.sleep(3_000)
    serve_weather(conn)
  end

  def index(conn, _params) do
    serve_weather(conn)
  end

  defp serve_weather(conn) do
    case Backend.Weather.fetch_feature_collection() do
      {:ok, feature_collection} ->
        json(conn, feature_collection)

      {:error, _reason} ->
        conn
        |> put_status(:bad_gateway)
        |> json(%{error: "weather_source_unavailable"})
    end
  end

  # IDW raster PNG — supports the same fault modes as the GeoJSON endpoint so
  # problem #7 (graceful degradation) works with the raster layer too.
  def raster(conn, %{"fault" => "error"}) do
    conn
    |> put_status(:bad_gateway)
    |> json(%{error: "weather_raster_unavailable", fault: "injected"})
  end

  def raster(conn, %{"fault" => "delay"}) do
    Process.sleep(3_000)
    serve_raster(conn)
  end

  def raster(conn, _params), do: serve_raster(conn)

  # Temperature domain + colour ramp — always fast, no fault injection.
  # The frontend uses this to render the legend even before the PNG loads.
  def meta(conn, _params) do
    path = Application.app_dir(:backend, "priv/data/weather_tokyo_idw_meta.json")
    case File.read(path) do
      {:ok, data} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(200, data)
      {:error, _} ->
        conn |> put_status(:not_found) |> json(%{error: "weather_meta_not_found"})
    end
  end

  defp serve_raster(conn) do
    path = Application.app_dir(:backend, "priv/data/weather_tokyo_idw.png")
    case File.read(path) do
      {:ok, data} ->
        conn
        |> put_resp_content_type("image/png")
        |> send_resp(200, data)
      {:error, _} ->
        conn |> put_status(:bad_gateway) |> json(%{error: "weather_raster_unavailable"})
    end
  end
end
