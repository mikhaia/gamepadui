(function initDirectorySearch(globalScope) {
  "use strict";

  const MIN_QUERY_LENGTH = 3;
  const DEFAULT_RESULT_LIMIT = 50;
  const DEFAULT_DIRECTORY_LIMIT = 2500;
  const DEFAULT_CONCURRENCY = 6;

  function normalizeQuery(query) {
    return String(query || "").trim().toLocaleLowerCase();
  }

  function isQueryReady(query) {
    return normalizeQuery(query).length >= MIN_QUERY_LENGTH;
  }

  function matchesSearchPath(path, query) {
    const normalizedQuery = normalizeQuery(query);
    return Boolean(normalizedQuery) && String(path || "").toLocaleLowerCase().includes(normalizedQuery);
  }

  // Сначала приложения, потом папки, потом остальные файлы.
  function resultRank(result) {
    if (result.launchable) return 0;
    return result.type === "DIRECTORY" ? 1 : 2;
  }

  async function find(options) {
    const {
      roots = [],
      query = "",
      osName,
      readDirectory,
      joinPath,
      isLaunchableEntry,
      includeAllFiles = false,
      includeFolders = true,
      shouldCancel = () => false,
      resultLimit = DEFAULT_RESULT_LIMIT,
      directoryLimit = DEFAULT_DIRECTORY_LIMIT,
      concurrency = DEFAULT_CONCURRENCY
    } = options || {};

    if (!isQueryReady(query)) {
      return { results: [], directoriesScanned: 0, readErrors: 0, truncated: false, cancelled: false };
    }

    const queue = [...new Set(roots.map((root) => String(root || "").trim()).filter(Boolean))];
    const visitedDirectories = new Set();
    const resultPaths = new Set();
    const results = [];
    let directoriesScanned = 0;
    let readErrors = 0;
    let directoryLimitReached = false;
    let resultLimitReached = false;

    const addResult = (result) => {
      if (resultPaths.has(result.path) || results.length >= resultLimit) return;
      resultPaths.add(result.path);
      results.push(result);
      if (results.length >= resultLimit) resultLimitReached = true;
    };

    const batchSize = Math.max(1, Number(concurrency) || 1);
    while (queue.length && !shouldCancel() && !resultLimitReached) {
      if (directoriesScanned >= directoryLimit) {
        directoryLimitReached = true;
        break;
      }

      const batch = [];
      while (queue.length && batch.length < batchSize && directoriesScanned < directoryLimit) {
        const directory = queue.shift();
        if (!directory || visitedDirectories.has(directory)) continue;
        visitedDirectories.add(directory);
        directoriesScanned += 1;
        batch.push(directory);
      }
      if (!batch.length) continue;

      const batchEntries = await Promise.all(batch.map(async (directory) => {
        try {
          return { directory, entries: await readDirectory(directory) };
        } catch (error) {
          readErrors += 1;
          return { directory, entries: [] };
        }
      }));
      if (shouldCancel()) break;

      for (const { directory, entries } of batchEntries) {
        for (const entry of entries || []) {
          if (shouldCancel() || resultLimitReached) break;
          // Скрытые файлы и папки (.git, .DS_Store и т. п.) только засоряют выдачу и тратят лимит папок.
          if (!entry?.entry || String(entry.entry).startsWith(".")) continue;
          const path = joinPath(directory, entry.entry, osName);
          const launchable = isLaunchableEntry(entry.entry, entry.type, osName);
          const matches = matchesSearchPath(entry.entry, query);
          if (launchable || (includeAllFiles && entry.type === "FILE")) {
            if (matches) addResult({ name: entry.entry, path, type: entry.type, launchable });
          } else if (entry.type === "DIRECTORY") {
            // Подходящая по имени папка — тоже результат (например, папка игры), а внутрь неё поиск всё равно заходит.
            if (includeFolders && matches) addResult({ name: entry.entry, path, type: "DIRECTORY", launchable: false });
            queue.push(path);
          }
        }
        if (resultLimitReached || shouldCancel()) break;
      }
    }
    const cancelled = shouldCancel();
    results.sort((left, right) => resultRank(left) - resultRank(right)
      || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      || left.path.localeCompare(right.path));

    return {
      results,
      directoriesScanned,
      readErrors,
      truncated: !cancelled && (directoryLimitReached || resultLimitReached || queue.length > 0),
      resultLimitReached,
      cancelled
    };
  }

  const api = {
    DEFAULT_DIRECTORY_LIMIT,
    DEFAULT_RESULT_LIMIT,
    MIN_QUERY_LENGTH,
    find,
    isQueryReady,
    matchesSearchPath,
    normalizeQuery
  };

  globalScope.GamePadSearch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
