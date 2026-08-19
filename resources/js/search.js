(function initDirectorySearch(globalScope) {
  "use strict";

  const MIN_QUERY_LENGTH = 3;
  const DEFAULT_RESULT_LIMIT = 160;
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

  async function find(options) {
    const {
      roots = [],
      query = "",
      osName,
      readDirectory,
      joinPath,
      isLaunchableEntry,
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

    const batchSize = Math.max(1, Number(concurrency) || 1);
    while (queue.length && !shouldCancel()) {
      if (results.length >= resultLimit) {
        resultLimitReached = true;
        break;
      }
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
          if (shouldCancel()) break;
          const path = joinPath(directory, entry.entry, osName);
          if (isLaunchableEntry(entry.entry, entry.type, osName)) {
            if (matchesSearchPath(entry.entry, query) && !resultPaths.has(path) && results.length < resultLimit) {
              resultPaths.add(path);
              results.push({ name: entry.entry, path, type: entry.type });
            }
            if (results.length >= resultLimit) {
              resultLimitReached = true;
              break;
            }
          } else if (entry.type === "DIRECTORY") {
            queue.push(path);
          }
        }
        if (resultLimitReached || shouldCancel()) break;
      }
    }
    const cancelled = shouldCancel();
    results.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) || left.path.localeCompare(right.path));

    return {
      results,
      directoriesScanned,
      readErrors,
      truncated: !cancelled && (directoryLimitReached || resultLimitReached || queue.length > 0),
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
