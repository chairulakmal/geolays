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
end
