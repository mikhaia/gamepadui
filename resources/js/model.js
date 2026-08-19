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

  function nameFromPath(path) {
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

  function sortEntries(entries, osName) {
    return [...entries].sort((left, right) => {
      const leftIsDirectory = left.type === "DIRECTORY" && !isApplicationBundle(left.entry, left.type, osName);
      const rightIsDirectory = right.type === "DIRECTORY" && !isApplicationBundle(right.entry, right.type, osName);
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
      return left.entry.localeCompare(right.entry, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function joinPath(base, entry, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    const cleanBase = String(base || "").replace(/[\\/]+$/, "");
    const cleanEntry = String(entry || "").replace(/^[\\/]+/, "");
    if (!cleanBase) return cleanEntry;
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

  function matchesLibrarySearch(item, query) {
    const normalized = String(query || "").trim().toLocaleLowerCase();
    if (!normalized) return true;
    return [item.name, item.path, item.arguments]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(normalized));
  }

  const api = {
    LAUNCHABLE_EXTENSIONS,
    createId,
    extensionOf,
    isApplicationBundle,
    isLaunchable,
    isLaunchableEntry,
    joinPath,
    matchesEntrySearch,
    matchesLibrarySearch,
    nameFromPath,
    normalizeCoverSearchResults,
    normalizeItem,
    parentPath,
    sortEntries
  };

  globalScope.GamePadModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
