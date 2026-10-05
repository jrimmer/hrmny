defmodule CytaleWeb.ErrorJSON do
  @moduledoc """
  Renders the plan's `{key, code, message}` error envelope (U12 owns the
  canonical set; this fallback covers unmatched routes and crashes).
  """

  def render(template, _assigns) do
    %{errors: %{detail: template}}
  end
end
