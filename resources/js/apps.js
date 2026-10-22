(function initApps(globalScope) {
  "use strict";

  const WINDOWS_START_MENU = ["Microsoft", "Windows", "Start Menu", "Programs"];
  const WINDOWS_SHORTCUT_EXTENSIONS = ["lnk", "url"];
  const MAX_DEPTH = { Windows: 4, Darwin: 1 };
  // «Удалить …», «Uninstall …» и т. п. — служебные ярлыки установщиков, в списке они только мешают.
  const UNINSTALLER_PATTERN = /(^|[\s_.(-])(un-?install|uninst|unins\d|deinstall)|^(удал|деинсталл)/i;

  function extensionOf(name) {
    const match = String(name || "").match(/\.([^./\\]+)$/);
    return match ? match[1].toLowerCase() : "";
  }

  function appDisplayName(entryName) {
    return String(entryName || "").replace(/\.(lnk|url|app)$/i, "").trim();
  }

  function joinSegments(base, segments, separator) {
    return [String(base).replace(/[\\/]+$/, ""), ...segments].join(separator);
  }

  // Реальные папки «Главного меню». Локализованное «C:\Users\<user>\Главное меню» — только
  // служебная ссылка для совместимости, читать её нельзя: она ведёт в ту же AppData\…\Start Menu.
  function getAppSources(osName, env = {}) {
    if (osName === "Windows") {
      return [env.appData, env.programData]
        .map((base) => String(base || "").trim())
        .filter(Boolean)
        .map((base) => joinSegments(base, WINDOWS_START_MENU, "\\"));
    }
    if (osName === "Darwin") {
      const home = String(env.home || "").trim();
      return ["/Applications", "/System/Applications", home ? joinSegments(home, ["Applications"], "/") : ""].filter(Boolean);
    }
    return [];
  }

  function isUninstaller(entryName) {
    return UNINSTALLER_PATTERN.test(appDisplayName(entryName));
  }

  function isAppEntry(entryName, entryType, osName) {
    if (String(entryName || "").startsWith(".")) return false;
    const extension = extensionOf(entryName);
    if (osName === "Windows") {
      return entryType === "FILE" && WINDOWS_SHORTCUT_EXTENSIONS.includes(extension) && !isUninstaller(entryName);
    }
    if (osName === "Darwin") return entryType === "DIRECTORY" && extension === "app";
    return false;
  }

  function shouldDescend(entryName, entryType, depth, osName) {
    if (entryType !== "DIRECTORY" || String(entryName || "").startsWith(".")) return false;
    if (depth >= (MAX_DEPTH[osName] ?? 0)) return false;
    // «Автозагрузка» дублирует ярлыки и запускает программы при входе в систему.
    if (osName === "Windows" && depth === 0 && entryName.toLowerCase() === "startup") return false;
    return true;
  }

  function compareApps(left, right) {
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      || left.group.localeCompare(right.group, undefined, { numeric: true, sensitivity: "base" });
  }

  async function collectApps(options) {
    const { sources = [], osName, readDirectory, joinPath } = options || {};
    const apps = [];
    const seen = new Set();
    let failedSources = 0;
    let queue = sources.map((path) => ({ path, group: [], depth: 0 }));

    while (queue.length) {
      const listings = await Promise.all(queue.map(async (directory) => {
        try {
          return { directory, entries: await readDirectory(directory.path) };
        } catch (error) {
          if (directory.depth === 0) failedSources += 1;
          return { directory, entries: [] };
        }
      }));

      const next = [];
      for (const { directory, entries } of listings) {
        for (const item of Array.isArray(entries) ? entries : []) {
          const entryName = String(item?.entry || "");
          if (!entryName || entryName === "." || entryName === "..") continue;
          const path = joinPath(directory.path, entryName, osName);
          if (isAppEntry(entryName, item.type, osName)) {
            const app = { name: appDisplayName(entryName), path, type: item.type, group: directory.group.join(" / ") };
            // Одинаковые ярлыки встречаются и в пользовательском, и в общем «Главном меню».
            const key = `${app.group}\u0000${app.name}`.toLocaleLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              apps.push(app);
            }
          } else if (shouldDescend(entryName, item.type, directory.depth, osName)) {
            next.push({ path, group: [...directory.group, entryName], depth: directory.depth + 1 });
          }
        }
      }
      queue = next;
    }

    return { apps: apps.sort(compareApps), failedSources };
  }

  function filterApps(apps, query) {
    const normalized = String(query || "").trim().toLocaleLowerCase();
    if (!normalized) return apps;
    return apps.filter((app) => `${app.name}\n${app.group}`.toLocaleLowerCase().includes(normalized));
  }

  const api = {
    appDisplayName,
    collectApps,
    filterApps,
    getAppSources,
    isAppEntry,
    isUninstaller
  };

  globalScope.GamePadApps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
