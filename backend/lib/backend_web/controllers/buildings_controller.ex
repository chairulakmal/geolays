defmodule BackendWeb.BuildingsController do
  use BackendWeb, :controller

  def index(conn, params) do
    case Backend.Buildings.fetch_feature_collection(params["bbox"]) do
      {:ok, fc} ->
        json(conn, fc)

      {:error, reason} ->
        conn
        |> put_status(502)
        |> json(%{error: "Buildings unavailable", detail: inspect(reason)})
    end
  end
end
