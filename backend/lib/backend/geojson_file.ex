defmodule Backend.GeoJsonFile do
  @moduledoc """
  Loads a committed GeoJSON file from `priv/`, decodes it, applies an optional
  `transform` (e.g. normalization), and caches the result in `:persistent_term`.

  The cache is keyed by the file's mtime, so editing the data file is picked up on
  the next request WITHOUT a server restart — `:persistent_term` survives code
  reload, so a plain "load once" cache would otherwise serve stale data forever in
  dev. `File.stat` per request is negligible next to parsing.
  """

  @doc """
  `cache_key` must be unique per caller (e.g. `{MyModule, :cache}`). `transform`
  maps the decoded GeoJSON map to whatever shape should be served/cached.
  Returns `{:ok, term}` or `{:error, reason}`.
  """
  def load(rel_path, cache_key, transform \\ &Function.identity/1) do
    file = Application.app_dir(:backend, ["priv", rel_path])

    with {:ok, %File.Stat{mtime: mtime}} <- File.stat(file) do
      case :persistent_term.get(cache_key, :miss) do
        {^mtime, cached} -> {:ok, cached}
        _ -> read_and_cache(file, mtime, cache_key, transform)
      end
    end
  end

  defp read_and_cache(file, mtime, cache_key, transform) do
    with {:ok, raw} <- File.read(file),
         {:ok, decoded} <- Jason.decode(raw) do
      result = transform.(decoded)
      :persistent_term.put(cache_key, {mtime, result})
      {:ok, result}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :invalid_geojson}
    end
  end
end
