(function initImageCache(globalScope) {
  "use strict";

  // Ссылки и data:/blob: URL читать с диска не нужно — они отдаются как есть.
  function isRemoteImage(path) {
    return /^(https?:|data:|blob:)/i.test(String(path || ""));
  }

  // Кеш картинок с диска (обложки, фон): один файл читается один раз, пока его путь используется.
  // Neutralino отдаёт файл base64-строкой через WebSocket, поэтому повторное чтение обходится дорого.
  //   read(path)      → Promise<Blob>   чтение файла;
  //   createUrl(blob) → string          обычно URL.createObjectURL;
  //   revokeUrl(url)                    обычно URL.revokeObjectURL.
  // Ненужные URL отзываются не сразу, а при следующем retain(): к этому моменту
  // экран уже перерисован и старые картинки нигде не показываются.
  function createImageCache({ read, createUrl, revokeUrl }) {
    const entries = new Map();
    let retired = [];

    function retire(entry) {
      entry.retired = true;
      if (entry.url) retired.push(entry.url);
    }

    function load(path) {
      const entry = { url: "", retired: false, promise: null };
      entry.promise = Promise.resolve()
        .then(() => read(path))
        .then((blob) => {
          const url = createUrl(blob);
          if (entry.retired) retired.push(url);
          else entry.url = url;
          return url;
        }, (error) => {
          // Ошибку не кешируем: файл может появиться позже (например, подключат диск).
          if (entries.get(path) === entry) entries.delete(path);
          throw error;
        });
      entries.set(path, entry);
      return entry;
    }

    // fresh: перечитать файл, даже если он уже в кеше (пользователь заново выбрал файл).
    function get(path, { fresh = false } = {}) {
      const key = String(path || "");
      if (!key) return Promise.resolve("");
      if (isRemoteImage(key)) return Promise.resolve(key);
      let entry = entries.get(key);
      if (entry && fresh) {
        retire(entry);
        entries.delete(key);
        entry = null;
      }
      return (entry || load(key)).promise;
    }

    // Готовый URL без ожидания — чтобы сразу вставить картинку в разметку; "" если ещё не прочитана.
    function peek(path) {
      const key = String(path || "");
      if (isRemoteImage(key)) return key;
      return entries.get(key)?.url || "";
    }

    // Оставляет в кеше только перечисленные пути, остальные URL отзывает.
    function retain(paths) {
      const keep = new Set([...paths].filter(Boolean).map(String));
      entries.forEach((entry, path) => {
        if (keep.has(path)) return;
        retire(entry);
        entries.delete(path);
      });
      const urls = retired;
      retired = [];
      urls.forEach((url) => revokeUrl(url));
    }

    return {
      get,
      peek,
      retain,
      get size() { return entries.size; }
    };
  }

  const api = { createImageCache, isRemoteImage };

  globalScope.GamePadImageCache = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
