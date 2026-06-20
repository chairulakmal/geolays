defmodule BackendWeb.HealthController do
  @moduledoc """
  Liveness check. Used to confirm the API is up and that CORS lets the frontend
  reach it (the frontend pings this on load in step 1). Intentionally trivial —
  no DB or upstream calls, so it can never report a false negative.
  """
  use BackendWeb, :controller

  def index(conn, _params) do
    json(conn, %{status: "ok", service: "geo-desk-backend"})
  end
end
