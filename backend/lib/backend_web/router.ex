defmodule BackendWeb.Router do
  use BackendWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", BackendWeb do
    pipe_through :api

    get "/health", HealthController, :index
    get "/layers/weather", WeatherController, :index
    get "/layers/land-price", LandPriceController, :index
  end
end
