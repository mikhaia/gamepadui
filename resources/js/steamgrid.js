(function initSteamGrid(globalScope) {
  "use strict";

  const API_URL = "https://www.steamgriddb.com/api/v2";
  // Вертикальные обложки (как у карточек библиотеки): стандарт Steam 600×900 и старые размеры.
  const COVER_DIMENSIONS = ["600x900", "342x482", "660x930"];
  const PAGE_SIZE = 24;

  function searchUrl(term) {
    return `${API_URL}/search/autocomplete/${encodeURIComponent(String(term || "").trim())}`;
  }

  // target: { type: "game", id } — игра SteamGridDB, или { type: "steam", id } — приложение Steam по его AppID.
  function gridsUrl(target, { page = 0 } = {}) {
    const params = new URLSearchParams({
      dimensions: COVER_DIMENSIONS.join(","),
      types: "static",
      nsfw: "false",
      humor: "false",
      epilepsy: "false",
      limit: String(PAGE_SIZE),
      page: String(Math.max(0, Math.floor(page)))
    });
    const type = target?.type === "steam" ? "steam" : "game";
    return `${API_URL}/grids/${type}/${encodeURIComponent(String(target?.id ?? ""))}?${params.toString()}`;
  }

  function authHeaders(key) {
    return { Authorization: `Bearer ${key}` };
  }

  // Ответ API → { ok, data } или { ok: false, kind: "key" | "http" | "format", message }.
  // 404 — «ничего нет» (неизвестный AppID Steam или игра без обложек), это не ошибка.
  function parseResponse(status, body) {
    const code = Number(status);
    let payload = null;
    try {
      payload = typeof body === "string" ? JSON.parse(body) : body;
    } catch (error) {
      payload = null;
    }
    const message = Array.isArray(payload?.errors) ? payload.errors.join("; ") : "";
    if (code === 401 || code === 403) return { ok: false, kind: "key", message };
    if (code === 404) return { ok: true, data: [] };
    if (!(code >= 200 && code < 300)) return { ok: false, kind: "http", message: message || `HTTP ${code || "?"}` };
    if (!payload || payload.success === false) return { ok: false, kind: payload ? "http" : "format", message };
    return { ok: true, data: Array.isArray(payload.data) ? payload.data : [] };
  }

  function parseGames(data) {
    return (Array.isArray(data) ? data : [])
      .map((game) => {
        const released = Number(game?.release_date);
        return {
          id: Number(game?.id),
          name: String(game?.name || "").trim(),
          year: Number.isFinite(released) && released > 0 ? new Date(released * 1000).getUTCFullYear() : null,
          verified: Boolean(game?.verified)
        };
      })
      .filter((game) => Number.isInteger(game.id) && game.id > 0 && game.name);
  }

  function parseCovers(data) {
    const https = (value) => (/^https:\/\/\S+$/i.test(String(value || "")) ? String(value) : "");
    return (Array.isArray(data) ? data : [])
      .map((grid) => {
        const url = https(grid?.url);
        return {
          id: String(grid?.id ?? url),
          url,
          thumb: https(grid?.thumb) || url,
          width: Number(grid?.width) || 0,
          height: Number(grid?.height) || 0,
          style: String(grid?.style || ""),
          author: String(grid?.author?.name || "").trim()
        };
      })
      .filter((cover) => cover.url);
  }

  // Ярлык Steam (steam://rungameid/1245620) → AppID: для него обложки ищутся без поиска по названию.
  function steamAppIdFromPath(path) {
    const match = String(path || "").trim().match(/^steam:\/\/(?:rungameid|run)\/(\d+)/i);
    return match ? match[1] : "";
  }

  function errorText(error) {
    if (error?.message === "native-api-required") return "Поиск SteamGridDB доступен при запуске через Neutralino.";
    if (error?.kind === "no-key") return "Не указан API-ключ SteamGridDB (STEAMGRID_API_KEY в main.js).";
    if (error?.kind === "key") return "SteamGridDB не принял API-ключ. Проверьте STEAMGRID_API_KEY в main.js.";
    return "Не удалось получить обложки SteamGridDB. Проверьте подключение и попробуйте снова.";
  }

  const api = {
    API_URL,
    COVER_DIMENSIONS,
    PAGE_SIZE,
    authHeaders,
    errorText,
    gridsUrl,
    parseCovers,
    parseGames,
    parseResponse,
    searchUrl,
    steamAppIdFromPath
  };

  globalScope.GamePadSteamGrid = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
