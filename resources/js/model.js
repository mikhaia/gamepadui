(function initModel(globalScope) {
  "use strict";

  const LAUNCHABLE_EXTENSIONS = {
    Windows: ["exe", "lnk", "bat", "cmd", "com", "url"],
    Linux: ["appimage", "desktop", "sh"],
    Darwin: ["app", "command", "sh"]
  };

  function createId() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return globalScope.crypto.randomUUID();
    }
    return `item-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizeItem(item) {
    const path = String(item.path || "").trim();
    const coverPath = String(item.coverPath || "").trim();
    const supportedCoverSources = new Set(["file", "url", "gamestory"]);
    const inferredCoverSource = /^https?:\/\//i.test(coverPath) ? "url" : "file";
    return {
      id: item.id || createId(),
      name: String(item.name || nameFromPath(path) || "Без названия").trim(),
      path,
      arguments: String(item.arguments || "").trim(),
      coverPath,
      coverSource: supportedCoverSources.has(item.coverSource) ? item.coverSource : inferredCoverSource,
      favorite: Boolean(item.favorite),
      addedAt: item.addedAt || new Date().toISOString()
    };
  }

  function normalizeCoverSearchResults(payload) {
    const results = Array.isArray(payload) ? payload : [];
    return results
      .map((result) => ({
        id: String(result?.id ?? result?.cover ?? ""),
        title: String(result?.title || "Без названия").trim(),
        cover: String(result?.cover || "").trim()
      }))
      .filter((result) => result.cover && /^https?:\/\//i.test(result.cover));
  }

  // Только http:// и https:// с указанным сайтом — другие схемы (file:, javascript: и т. п.) не открываем.
  function isWebUrl(value) {
    const text = String(value || "").trim();
    if (!/^https?:\/\/\S+$/i.test(text)) return false;
    try {
      const url = new URL(text);
      return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch (error) {
      return false;
    }
  }

  function nameFromPath(path) {
    if (isWebUrl(path)) return new URL(String(path).trim()).hostname.replace(/^www\./i, "");
    const cleaned = String(path || "").replace(/[\\/]+$/, "");
    const filename = cleaned.split(/[\\/]/).pop() || "";
    return filename.replace(/\.(exe|lnk|bat|cmd|com|url|appimage|desktop|sh|command|app)$/i, "");
  }

  function extensionOf(path) {
    const match = String(path || "").match(/\.([^./\\]+)$/);
    return match ? match[1].toLowerCase() : "";
  }

  function isLaunchable(path, osName) {
    const extensions = LAUNCHABLE_EXTENSIONS[osName] || [];
    return extensions.includes(extensionOf(path));
  }

  function isApplicationBundle(path, entryType, osName) {
    return osName === "Darwin" && entryType === "DIRECTORY" && extensionOf(path) === "app";
  }

  function isLaunchableEntry(path, entryType, osName) {
    return entryType === "FILE"
      ? isLaunchable(path, osName)
      : isApplicationBundle(path, entryType, osName);
  }

  function matchesEntrySearch(entry, query) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    if (!normalizedQuery) return true;
    return String(entry?.entry || entry || "").toLocaleLowerCase().includes(normalizedQuery);
  }

  const EXPLORER_SORTS = ["name", "size", "date"];

  function statOf(stats, name) {
    if (!stats) return null;
    return (stats instanceof Map ? stats.get(name) : stats[name]) || null;
  }

  // Папки всегда идут первыми. «Размер» — от больших к меньшим (пока размер папки не посчитан,
  // она стоит после посчитанных), «дата» — от новых к старым. Записи без сведений идут после остальных.
  function sortEntries(entries, osName, options = {}) {
    const sort = EXPLORER_SORTS.includes(options.sort) ? options.sort : "name";
    const metric = (entry) => {
      const stat = statOf(options.stats, entry.entry);
      // Для папок (и пакетов .app) размер считается отдельно и приходит в поле folderSize.
      if (sort === "size") {
        const value = entry.type === "FILE" ? stat?.size : stat?.folderSize;
        return Number.isFinite(value) ? value : null;
      }
      if (sort === "date") return Number.isFinite(stat?.modifiedAt) ? stat.modifiedAt : null;
      return null;
    };
    return [...entries].sort((left, right) => {
      const leftIsDirectory = left.type === "DIRECTORY" && !isApplicationBundle(left.entry, left.type, osName);
      const rightIsDirectory = right.type === "DIRECTORY" && !isApplicationBundle(right.entry, right.type, osName);
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
      if (sort !== "name") {
        const leftValue = metric(left);
        const rightValue = metric(right);
        if (leftValue !== rightValue) {
          if (leftValue === null) return 1;
          if (rightValue === null) return -1;
          return rightValue - leftValue;
        }
      }
      return left.entry.localeCompare(right.entry, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function formatFileSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "";
    const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || size >= 100 ? 0 : 1;
    return `${size.toLocaleString("ru-RU", { maximumFractionDigits: digits })} ${units[unit]}`;
  }

  function joinPath(base, entry, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    const basePath = String(base || "");
    const cleanBase = basePath.replace(/[\\/]+$/, "");
    const cleanEntry = String(entry || "").replace(/^[\\/]+/, "");
    if (!cleanBase) return /^[\\/]/.test(basePath) ? `${separator}${cleanEntry}` : cleanEntry;
    return `${cleanBase}${separator}${cleanEntry}`;
  }

  function parentPath(path, osName) {
    const original = String(path || "");
    if (!original) return "";
    const normalized = original.replace(/\\/g, "/").replace(/\/+$/, "");

    if (osName === "Windows" && /^[A-Za-z]:$/.test(normalized)) {
      return `${normalized}\\`;
    }
    if (normalized === "") return osName === "Windows" ? original : "/";
    if (normalized === "/") return "/";

    const slashIndex = normalized.lastIndexOf("/");
    let parent = slashIndex <= 0 ? normalized.slice(0, slashIndex + 1) : normalized.slice(0, slashIndex);
    if (osName === "Windows") {
      if (/^[A-Za-z]:$/.test(parent)) parent += "/";
      return parent.replace(/\//g, "\\");
    }
    return parent || "/";
  }

  // Закреплённые папки: путь без завершающего разделителя (кроме корня), в Windows без учёта регистра.
  function normalizeFolderPath(path, osName) {
    const value = String(path || "").trim();
    if (!value) return "";
    if (osName === "Windows") {
      const windowsPath = value.replace(/\//g, "\\");
      if (/^[A-Za-z]:\\?$/.test(windowsPath)) return `${windowsPath.slice(0, 2)}\\`;
      return windowsPath.replace(/\\+$/, "");
    }
    return value === "/" ? "/" : value.replace(/\/+$/, "") || "/";
  }

  function sameFolder(left, right, osName) {
    const a = normalizeFolderPath(left, osName);
    const b = normalizeFolderPath(right, osName);
    if (!a || !b) return false;
    return osName === "Windows" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
  }

  function pinFolder(pins, path, osName) {
    const list = Array.isArray(pins) ? [...pins] : [];
    const folder = normalizeFolderPath(path, osName);
    if (!folder || list.some((pin) => sameFolder(pin, folder, osName))) return list;
    return [...list, folder];
  }

  function unpinFolder(pins, path, osName) {
    return (Array.isArray(pins) ? pins : []).filter((pin) => !sameFolder(pin, path, osName));
  }

  function movePinnedFolder(pins, path, direction, osName) {
    const list = Array.isArray(pins) ? [...pins] : [];
    const from = list.findIndex((pin) => sameFolder(pin, path, osName));
    const to = direction === "up" ? from - 1 : direction === "down" ? from + 1 : from;
    if (from < 0 || to < 0 || to >= list.length || to === from) return list;
    [list[from], list[to]] = [list[to], list[from]];
    return list;
  }

  function folderDisplayName(path, osName) {
    const folder = normalizeFolderPath(path, osName);
    if (osName === "Windows" && /^[A-Za-z]:\\$/.test(folder)) return `Диск ${folder.slice(0, 2).toUpperCase()}`;
    if (folder === "/") return "Корень диска";
    return folder.split(/[\\/]/).filter(Boolean).pop() || folder;
  }

  const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  // Возвращает текст ошибки или пустую строку, если имя подходит для файла или папки.
  function validateEntryName(name, osName) {
    const value = String(name ?? "");
    const trimmed = value.trim();
    if (!trimmed) return "Введите имя";
    if (trimmed === "." || trimmed === "..") return "Такое имя использовать нельзя";
    if (trimmed.length > 255) return "Слишком длинное имя";
    if (trimmed.includes("/")) return "Имя не может содержать символ /";
    if (/[\u0000-\u001f]/.test(trimmed)) return "Имя содержит недопустимые символы";
    if (osName === "Windows") {
      if (/[\\:*?"<>|]/.test(trimmed)) return "Имя не может содержать символы \\ : * ? \" < > |";
      if (/[. ]$/.test(value)) return "Имя не может заканчиваться точкой или пробелом";
      if (WINDOWS_RESERVED_NAMES.test(trimmed)) return "Это имя зарезервировано Windows";
    }
    return "";
  }

  function renamedPath(path, newName, osName) {
    return joinPath(parentPath(path, osName), String(newName).trim(), osName);
  }

  // Если path совпадает с oldPrefix или лежит внутри него, возвращает тот же путь с newPrefix, иначе null.
  function replacePathPrefix(path, oldPrefix, newPrefix, osName) {
    const value = String(path || "");
    const from = normalizeFolderPath(oldPrefix, osName);
    if (!value || !from) return null;
    const separator = osName === "Windows" ? "\\" : "/";
    const compare = (text) => (osName === "Windows" ? text.toLocaleLowerCase() : text);
    const normalized = osName === "Windows" ? value.replace(/\//g, "\\") : value;
    if (compare(normalizeFolderPath(normalized, osName)) === compare(from)) return normalizeFolderPath(newPrefix, osName);
    const base = from.endsWith(separator) ? from : `${from}${separator}`;
    if (!compare(normalized).startsWith(compare(base))) return null;
    return `${normalizeFolderPath(newPrefix, osName)}${separator}${normalized.slice(base.length)}`;
  }

  function matchesLibrarySearch(item, query) {
    const normalized = String(query || "").trim().toLocaleLowerCase();
    if (!normalized) return true;
    return [item.name, item.path, item.arguments]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(normalized));
  }

  const FAVORITE_MOVES = ["first", "previous", "next", "last"];

  // Порядок избранного хранится отдельно (список id), чтобы не менять порядок библиотеки.
  // Новые избранные, которых ещё нет в списке, идут в конце в порядке библиотеки.
  function orderFavorites(library, favoriteOrder = []) {
    const ranks = new Map((Array.isArray(favoriteOrder) ? favoriteOrder : []).map((id, index) => [String(id), index]));
    const rankOf = ({ item, index }) => (ranks.has(item.id) ? ranks.get(item.id) : ranks.size + index);
    return (Array.isArray(library) ? library : [])
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item?.favorite)
      .sort((left, right) => rankOf(left) - rankOf(right))
      .map(({ item }) => item);
  }

  function favoritePosition(library, favoriteOrder, id) {
    const ids = orderFavorites(library, favoriteOrder).map((item) => item.id);
    return { index: ids.indexOf(id), total: ids.length };
  }

  function moveFavorite(library, favoriteOrder, id, move) {
    const ids = orderFavorites(library, favoriteOrder).map((item) => item.id);
    const from = ids.indexOf(id);
    if (from < 0 || !FAVORITE_MOVES.includes(move)) return ids;
    const targets = { first: 0, previous: from - 1, next: from + 1, last: ids.length - 1 };
    const to = Math.min(ids.length - 1, Math.max(0, targets[move]));
    ids.splice(to, 0, ...ids.splice(from, 1));
    return ids;
  }

  const api = {
    EXPLORER_SORTS,
    FAVORITE_MOVES,
    LAUNCHABLE_EXTENSIONS,
    createId,
    extensionOf,
    favoritePosition,
    folderDisplayName,
    formatFileSize,
    isApplicationBundle,
    isLaunchable,
    isLaunchableEntry,
    isWebUrl,
    joinPath,
    matchesEntrySearch,
    matchesLibrarySearch,
    moveFavorite,
    movePinnedFolder,
    nameFromPath,
    normalizeCoverSearchResults,
    normalizeFolderPath,
    normalizeItem,
    orderFavorites,
    parentPath,
    pinFolder,
    renamedPath,
    replacePathPrefix,
    sameFolder,
    sortEntries,
    unpinFolder,
    validateEntryName
  };

  globalScope.GamePadModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
