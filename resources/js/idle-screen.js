(function initIdleScreen(globalScope) {
  "use strict";

  // Через сколько минут простоя включать заставку; 0 — никогда.
  const IDLE_TIMEOUTS = [0, 1, 3, 5, 10, 15, 30];
  const IDLE_SOURCES = ["launcher", "image", "youtube"];
  const CLOCK_POSITIONS = ["center", "top-left", "top-right", "bottom-left", "bottom-right"];
  const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";
  const YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com", "youtu.be"];
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

  function normalizeIdleSettings(settings = {}) {
    const timeout = Number(settings.idleTimeout);
    return {
      timeout: IDLE_TIMEOUTS.includes(timeout) ? timeout : 0,
      source: IDLE_SOURCES.includes(settings.idleSource) ? settings.idleSource : "launcher",
      imagePath: String(settings.idleImagePath || "").trim(),
      youtubeUrl: String(settings.idleYoutubeUrl || "").trim(),
      sound: settings.idleSound === true,
      clockPosition: CLOCK_POSITIONS.includes(settings.idleClockPosition) ? settings.idleClockPosition : "center"
    };
  }

  // «90», «90s», «1m30s», «1h2m3s» → секунды.
  function parseStart(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return 0;
    if (/^\d+s?$/.test(text)) return Number.parseInt(text, 10);
    const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match || !match[0]) return 0;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  }

  // Ссылка на видео или плейлист YouTube → { videoId, playlistId, start } или null.
  function parseYouTubeUrl(input) {
    const text = String(input || "").trim();
    if (!text) return null;
    if (VIDEO_ID.test(text)) return { videoId: text, playlistId: "", start: 0 };
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch (error) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
    if (!YOUTUBE_HOSTS.includes(host)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    let videoId = "";
    if (host === "youtu.be") videoId = segments[0] || "";
    else if (segments[0] === "watch") videoId = url.searchParams.get("v") || "";
    else if (["shorts", "live", "embed", "v"].includes(segments[0]) && segments[1] !== "videoseries") videoId = segments[1] || "";
    if (videoId && !VIDEO_ID.test(videoId)) videoId = "";
    const list = url.searchParams.get("list") || "";
    const playlistId = PLAYLIST_ID.test(list) ? list : "";
    if (!videoId && !playlistId) return null;
    const start = parseStart(url.searchParams.get("t") || url.searchParams.get("start"));
    return { videoId, playlistId, start };
  }

  // Встраиваемый плеер без звука (так автозапуск разрешён всегда), без элементов управления, по кругу.
  // Звук включается командой unMute после старта, если он нужен.
  function youtubeEmbedUrl(video, { origin = "" } = {}) {
    if (!video || (!video.videoId && !video.playlistId)) return "";
    const params = new URLSearchParams({
      autoplay: "1",
      mute: "1",
      controls: "0",
      disablekb: "1",
      fs: "0",
      iv_load_policy: "3",
      playsinline: "1",
      rel: "0",
      loop: "1",
      enablejsapi: "1"
    });
    if (/^https?:\/\/[^/]+$/i.test(origin)) params.set("origin", origin);
    if (video.start > 0) params.set("start", String(Math.floor(video.start)));
    let path = "videoseries";
    if (video.videoId) {
      path = video.videoId;
      // Для одного видео повтор работает, только если указать его же как плейлист.
      if (video.playlistId) params.set("list", video.playlistId);
      else params.set("playlist", video.videoId);
    } else {
      params.set("list", video.playlistId);
    }
    return `${YOUTUBE_EMBED_ORIGIN}/embed/${path}?${params.toString()}`;
  }

  function youtubeErrorText(code) {
    const value = Number(code);
    if (value === 100) return "Видео YouTube не найдено или скрыто";
    if (value === 101 || value === 150) return "Автор запретил показывать это видео вне YouTube";
    if (value === 153) return "YouTube не принял запрос плеера (ошибка 153)";
    if (value === 2) return "YouTube не принял ссылку на видео";
    return `Видео YouTube не воспроизводится (ошибка ${Number.isFinite(value) ? value : "?"})`;
  }

  // Сообщение от плеера YouTube (postMessage) → { ready, state, error, autoplayBlocked }.
  function readPlayerMessage(data) {
    let message = data;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch (error) {
        return null;
      }
    }
    if (!message || typeof message !== "object" || typeof message.event !== "string") return null;
    const result = { ready: false, state: null, error: null, autoplayBlocked: false };
    if (message.event === "onReady" || message.event === "initialDelivery") result.ready = true;
    if (message.event === "onStateChange" && Number.isInteger(message.info)) result.state = message.info;
    if (message.event === "infoDelivery" && Number.isInteger(message.info?.playerState)) result.state = message.info.playerState;
    if (message.event === "initialDelivery" && Number.isInteger(message.info?.playerState)) result.state = message.info.playerState;
    if (message.event === "onError") result.error = message.info;
    if (message.event === "onAutoplayBlocked") result.autoplayBlocked = true;
    return result;
  }

  function playerCommand(func, args = []) {
    return JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" });
  }

  const api = {
    CLOCK_POSITIONS,
    IDLE_SOURCES,
    IDLE_TIMEOUTS,
    YOUTUBE_EMBED_ORIGIN,
    normalizeIdleSettings,
    parseStart,
    parseYouTubeUrl,
    playerCommand,
    readPlayerMessage,
    youtubeEmbedUrl,
    youtubeErrorText
  };

  globalScope.GamePadIdleScreen = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
