(function initApplication(globalScope) {
  "use strict";

  const Model = globalScope.GamePadModel;
  const DirectorySearch = globalScope.GamePadSearch;
  const Apps = globalScope.GamePadApps;
  const Platform = globalScope.GamePadPlatform;
  const Displays = globalScope.GamePadDisplays;
  const FolderSizes = globalScope.GamePadFolderSizes;
  const Navigation = globalScope.GamePadNavigation;
  const Sound = globalScope.GamePadSound;
  const ImageCache = globalScope.GamePadImageCache;
  const AppIcons = globalScope.GamePadAppIcons;
  const STORAGE_KEY = "gamepad-ui-state-v1";
  const DEFAULT_STATE = {
    library: [],
    favoriteOrder: [],
    settings: {
      theme: "light",
      accent: "plum",
      backgroundPath: "",
      backgroundDim: 58,
      backgroundBlur: 0,
      soundEnabled: true,
      searchAllFiles: false,
      explorerSort: "name",
      explorerView: "tiles",
      explorerPins: null,
      // Размер папок считается только по явному включению: подсчёт нагружает диск, а в macOS
      // может вызвать запросы доступа к «Документам», «Рабочему столу» и «Загрузкам».
      explorerFolderSizes: false,
      display: null,
      searchPaths: []
    }
  };
  const SECTION_ORDER = ["favorites", "library", "explorer", "search"];
  const IMAGE_MIME_TYPES = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp"
  };
  const GAMESTORY_API_URL = "https://api.gamestory.kz/search";
  const GAMESTORY_API_KEY = "FFE334D77DA0AB35525E6F2CD886A1BF";

  let state = structuredClone(DEFAULT_STATE);
  let activeSection = "favorites";
  let explorerPath = "";
  let explorerEntries = [];
  let explorerReadError = false;
  let explorerFilter = "";
  let explorerStats = new Map();
  let explorerRequestId = 0;
  // Размеры папок считаются отдельным фоновым процессом и кешируются на 10 минут.
  const FOLDER_SIZE_TTL_MS = 10 * 60 * 1000;
  const FOLDER_SIZE_JOB_TIMEOUT_MS = 120 * 1000;
  const folderSizeCache = new Map();
  let folderSizeJob = null;
  let folderSizeRenderTimer = 0;
  let directorySearchQuery = "";
  let directorySearchMode = "idle";
  let directorySearchResults = [];
  let directorySearchOutcome = null;
  let directorySearchTimer = 0;
  let directorySearchRequestId = 0;
  let selectedItemId = "";
  let selectedExplorerPath = "";
  let toastTimer = 0;
  let nativeReady = false;
  let backgroundRequestId = 0;
  let shownBackgroundPath = null;
  let shownBackgroundUrl = "";
  const imageCacheOptions = {
    read: async (path) => new Blob([await globalScope.Neutralino.filesystem.readBinaryFile(path)], {
      type: IMAGE_MIME_TYPES[Model.extensionOf(path)] || "application/octet-stream"
    }),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url)
  };
  // Обложки и фон: ненужные картинки выгружаются после каждой перерисовки библиотеки.
  const imageCache = ImageCache.createImageCache(imageCacheOptions);
  // Значки приложений: маленькие, живут до конца сеанса.
  const iconImages = ImageCache.createImageCache(imageCacheOptions);
  let iconLoader = null;
  let iconObserver = null;
  const observedIconSlots = new Set();
  // Фоновые процессы (подсчёт размеров папок, извлечение значков) получают события по своему номеру.
  const processHandlers = new Map();
  const earlyProcessEvents = [];
  let processesStarting = 0;
  let appsList = [];
  let appsStatus = "idle";
  let appsFilter = "";
  let appsRequestId = 0;
  let returnFocusTarget = null;
  let detectedDisplays = [];
  let homeFolderPath = "";
  // Защита от двойного запуска: пока игра грузится, повторное нажатие A не должно запускать её ещё раз.
  const LAUNCH_REPEAT_GUARD_MS = 5000;
  const recentLaunches = new Map();
  const systemFolderLabels = new Map();

  const elements = {};

  function cacheElements() {
    [
      "background-image", "background-wash", "clock-time", "clock-date", "input-status",
      "input-status-text", "favorites-grid", "library-grid", "explorer-grid", "explorer-path", "explorer-filter",
      "explorer-count", "library-search-input", "library-search-scope", "library-search-summary",
      "library-search-results", "section-tabs", "system-panel", "system-scrim", "modal-layer", "modal",
      "modal-title", "modal-eyebrow", "modal-body", "toast", "control-hints", "apps-panel", "apps-scrim",
      "apps-toggle", "apps-filter", "apps-list", "apps-meta", "apps-eyebrow", "explorer-sort", "explorer-sort-button",
      "explorer-sort-label", "explorer-sort-menu", "explorer-pins", "explorer-pin-current",
      "explorer-folder-sizes", "explorer-folder-sizes-switch"
    ].forEach((id) => { elements[id] = document.getElementById(id); });
  }

  function getOsName() {
    return typeof globalScope.NL_OS === "string" ? globalScope.NL_OS : "Browser";
  }

  function hasNativeApi() {
    return nativeReady && typeof globalScope.Neutralino !== "undefined";
  }

  async function initializeNativeApi() {
    if (typeof globalScope.Neutralino === "undefined") return false;
    try {
      globalScope.Neutralino.init();
      globalScope.Neutralino.events.on("windowClose", async () => {
        await stopBackgroundProcesses();
        globalScope.Neutralino.app.exit();
      });
      nativeReady = true;
      return true;
    } catch (error) {
      console.warn("Neutralino API is unavailable; using browser preview mode.", error);
      return false;
    }
  }

  async function loadState() {
    try {
      const raw = hasNativeApi()
        ? await globalScope.Neutralino.storage.getData(STORAGE_KEY)
        : globalScope.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state = {
        library: Array.isArray(saved.library) ? saved.library.map(Model.normalizeItem) : [],
        favoriteOrder: Array.isArray(saved.favoriteOrder) ? saved.favoriteOrder.map(String) : [],
        settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) }
      };
    } catch (error) {
      if (error?.code !== "NE_ST_NOSTKEX") console.warn("Unable to load state", error);
    }
  }

  async function saveState() {
    // Убираем из порядка снятые с избранного и закрепляем новые избранные в конце.
    state.favoriteOrder = Model.orderFavorites(state.library, state.favoriteOrder).map((item) => item.id);
    const payload = JSON.stringify(state);
    try {
      if (hasNativeApi()) await globalScope.Neutralino.storage.setData(STORAGE_KEY, payload);
      else globalScope.localStorage.setItem(STORAGE_KEY, payload);
    } catch (error) {
      showToast("Не удалось сохранить изменения", "error");
      console.error(error);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function icon(name, className = "icon") {
    return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  }

  function initials(name) {
    return String(name || "GP")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function colorIndex(value) {
    return [...String(value)].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 6;
  }

  // Картинки с диска берутся из кеша: файл читается один раз, пока его путь где-то используется.
  // options.fresh — перечитать файл (пользователь выбрал его заново).
  async function localImageUrl(path, options) {
    if (!path) return "";
    if (!ImageCache.isRemoteImage(path) && !hasNativeApi()) return "";
    try {
      return await imageCache.get(path, options);
    } catch (error) {
      console.warn(`Unable to read image: ${path}`, error);
      return "";
    }
  }

  // Картинки, которые сейчас на экране или вот-вот появятся; остальные выгружаются из кеша.
  function imagePathsInUse() {
    const previews = [...document.querySelectorAll("[data-cover-preview]")].map((preview) => preview.dataset.requestedPath);
    return [...state.library.map((item) => item.coverPath), state.settings.backgroundPath, shownBackgroundPath, ...previews];
  }

  function coverValueForSource(form, source) {
    if (source === "file") return String(form.elements.coverFilePath?.value || "").trim();
    if (source === "url") return String(form.elements.coverUrl?.value || "").trim();
    if (source === "gamestory") return String(form.elements.gameStoryCover?.value || "").trim();
    return "";
  }

  async function updateCoverPreview(form, path, options) {
    const preview = form.querySelector("[data-cover-preview]");
    const image = preview?.querySelector("img");
    const message = preview?.querySelector("span");
    if (!preview || !image || !message) return;

    const normalizedPath = String(path || "").trim();
    preview.dataset.requestedPath = normalizedPath;
    image.classList.remove("is-loaded");
    image.removeAttribute("src");
    if (!normalizedPath) {
      message.textContent = "Обложка не выбрана";
      return;
    }

    const imageUrl = await localImageUrl(normalizedPath, options);
    if (preview.dataset.requestedPath !== normalizedPath) return;
    if (!imageUrl) {
      message.textContent = hasNativeApi() ? "Не удалось открыть изображение" : "Локальный файл будет показан в приложении";
      return;
    }

    message.textContent = "Загружаю предпросмотр…";
    image.onload = () => {
      if (preview.dataset.requestedPath !== normalizedPath) return;
      image.classList.add("is-loaded");
      message.textContent = "";
    };
    image.onerror = () => {
      if (preview.dataset.requestedPath !== normalizedPath) return;
      image.classList.remove("is-loaded");
      message.textContent = "Не удалось загрузить изображение";
    };
    image.src = imageUrl;
  }

  function selectCoverSource(form, source) {
    form.querySelectorAll("[data-cover-source-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.coverSourcePanel !== source;
    });
    const coverPath = coverValueForSource(form, source);
    form.elements.coverPath.value = coverPath;
    updateCoverPreview(form, coverPath);
  }

  async function searchGameStoryCovers(query) {
    if (!hasNativeApi()) throw new Error("native-api-required");
    const response = await globalScope.Neutralino.net.get(`${GAMESTORY_API_URL}?q=${encodeURIComponent(query)}`, {
      headers: { "X-API-Key": GAMESTORY_API_KEY },
      timeout: 15000
    });
    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error(`GameStory HTTP ${response?.status || "error"}`);
    }
    const payload = JSON.parse(response.body || "[]");
    return Model.normalizeCoverSearchResults(payload);
  }

  function gameStoryCoverResultsMarkup(results, selectedCover) {
    if (!results.length) return '<p class="cover-search-message">Ничего не найдено. Попробуйте уточнить название.</p>';
    return results.map((result) => `
      <button type="button" class="cover-result${result.cover === selectedCover ? " is-selected" : ""}" data-cover-result-url="${escapeHtml(result.cover)}" data-focusable>
        <span class="cover-result__art"><img src="${escapeHtml(result.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>
        <span class="cover-result__copy"><b>${escapeHtml(result.title)}</b><small>GameStory</small></span>
      </button>`).join("");
  }

  async function applySettings({ refreshBackground = false } = {}) {
    document.body.dataset.theme = state.settings.theme || "light";
    document.body.dataset.accent = state.settings.accent || "plum";
    Sound.setEnabled(state.settings.soundEnabled !== false);
    elements["background-wash"].style.setProperty("--background-dim", state.settings.backgroundDim / 100);
    elements["background-image"].style.setProperty("--background-blur", `${state.settings.backgroundBlur}px`);
    await applyBackground({ fresh: refreshBackground });
  }

  // Фон читается с диска, только когда меняется путь, файл выбран заново или прошлое чтение не удалось.
  async function applyBackground({ fresh = false } = {}) {
    const path = state.settings.backgroundPath || "";
    if (!fresh && path === shownBackgroundPath && (shownBackgroundUrl || !path)) return;
    const requestId = ++backgroundRequestId;
    const url = await localImageUrl(path, { fresh });
    if (url) await decodeImage(url);
    if (requestId !== backgroundRequestId) return;
    shownBackgroundPath = path;
    shownBackgroundUrl = url;
    elements["background-image"].style.backgroundImage = url ? `url("${url}")` : "";
    document.body.classList.toggle("has-custom-background", Boolean(url));
    imageCache.retain(imagePathsInUse());
  }

  // Новый фон ставим уже раскодированным, чтобы при смене не мигал пустой экран.
  async function decodeImage(url) {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      // Битый файл — фон всё равно применяется, как и раньше.
    }
  }

  function emptyStateMarkup(kind) {
    const copy = kind === "favorites"
      ? { icon: "star", title: "Здесь появятся любимые игры", text: "Добавьте приложение и отметьте его как избранное — ничего не импортируется автоматически." }
      : { icon: "library", title: "Библиотека пока пуста", text: "Добавьте исполняемый файл или ярлык вручную. Вы полностью управляете коллекцией." };
    return `
      <div class="empty-state">
        <div class="empty-state__icon">${icon(copy.icon)}</div>
        <h3>${copy.title}</h3>
        <p>${copy.text}</p>
        <button class="action-button action-button--primary" data-action="add-item" data-focusable>${icon("plus")} Добавить вручную</button>
      </div>`;
  }

  function itemCardMarkup(item) {
    const selected = selectedItemId === item.id ? " is-selected" : "";
    // Уже прочитанная обложка вставляется сразу, без повторного чтения и без мигания.
    const coverUrl = item.coverPath ? imageCache.peek(item.coverPath) : "";
    // Без обложки над инициалами показывается значок приложения или значок по типу.
    return `
      <button class="game-card color-${colorIndex(item.id)}${selected}" data-item-id="${escapeHtml(item.id)}" data-focusable>
        <span class="game-card__art">
          <span class="game-card__mark">
            ${item.coverPath ? "" : cardIconMarkup(item.path)}
            <span class="game-card__initials">${escapeHtml(initials(item.name))}</span>
          </span>
          ${item.coverPath ? `<img data-cover-path="${escapeHtml(item.coverPath)}"${coverUrl ? ` src="${escapeHtml(coverUrl)}" class="is-loaded"` : ""} alt="">` : ""}
          ${item.favorite ? `<span class="game-card__favorite" aria-label="В избранном">${icon("star")}</span>` : ""}
          <span class="game-card__play">${icon("play")}</span>
        </span>
        <span class="game-card__meta">
          <b>${escapeHtml(item.name)}</b>
          <small>${escapeHtml(item.path)}</small>
        </span>
      </button>`;
  }

  async function hydrateCoverImages(root) {
    const images = [...root.querySelectorAll("img[data-cover-path]:not([src])")];
    await Promise.all(images.map(async (image) => {
      const url = await localImageUrl(image.dataset.coverPath);
      if (url) {
        image.src = url;
        image.classList.add("is-loaded");
      }
    }));
  }

  function renderLibrary() {
    const favorites = Model.orderFavorites(state.library, state.favoriteOrder);
    elements["favorites-grid"].innerHTML = favorites.length
      ? favorites.map(itemCardMarkup).join("")
      : emptyStateMarkup("favorites");
    elements["library-grid"].innerHTML = state.library.length
      ? state.library.map(itemCardMarkup).join("")
      : emptyStateMarkup("library");
    hydrateCoverImages(elements["favorites-grid"]);
    hydrateCoverImages(elements["library-grid"]);
    imageCache.retain(imagePathsInUse());
    watchAppIcons(elements["favorites-grid"]);
    watchAppIcons(elements["library-grid"]);
    if (elements["library-search-results"]) renderDirectorySearch();
  }

  const EXPLORER_SORT_LABELS = { name: "По названию", size: "По размеру", date: "По дате изменения" };
  const explorerShortDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  const explorerFullDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  function explorerSortKey() {
    return Model.EXPLORER_SORTS.includes(state.settings.explorerSort) ? state.settings.explorerSort : "name";
  }

  function explorerViewMode() {
    return state.settings.explorerView === "list" ? "list" : "tiles";
  }

  // Размер и дата нужны только для сортировки по ним и для вида «Список».
  function explorerNeedsStats() {
    return hasNativeApi() && (explorerSortKey() !== "name" || explorerViewMode() === "list");
  }

  function detailMarkup(parts) {
    return parts.filter(Boolean).map(escapeHtml).join('<span class="file-card__detail-separator" aria-hidden="true">·</span>');
  }

  function fileEntryMarkup(item) {
    const path = Model.joinPath(explorerPath, item.entry, getOsName());
    const applicationBundle = Model.isApplicationBundle(item.entry, item.type, getOsName());
    const directory = item.type === "DIRECTORY" && !applicationBundle;
    const launchable = Model.isLaunchableEntry(item.entry, item.type, getOsName());
    const selected = selectedExplorerPath === path ? " is-selected" : "";
    const extension = Model.extensionOf(item.entry).toUpperCase();
    const typeLabel = directory ? "Папка" : applicationBundle ? "Приложение" : extension || "Файл";
    const stat = explorerStats.get(item.entry);
    const size = item.type === "FILE"
      ? (Number.isFinite(stat?.size) ? Model.formatFileSize(stat.size) : "")
      : (explorerFolderSizesNeeded() ? folderSizeText(path) : "");
    const modified = Number.isFinite(stat?.modifiedAt) && stat.modifiedAt > 0 ? new Date(stat.modifiedAt) : null;
    const list = explorerViewMode() === "list";
    const sort = explorerSortKey();
    const detail = list
      ? detailMarkup([typeLabel, size, modified ? explorerFullDate.format(modified) : ""])
      : detailMarkup([
        typeLabel,
        // В плитке размер файлов виден при сортировке по размеру, а размер папок — когда включён их подсчёт.
        sort === "size" || item.type === "DIRECTORY" ? size : "",
        sort === "date" && modified ? explorerShortDate.format(modified) : "",
        launchable ? "Можно добавить" : ""
      ]);
    const appIcon = launchable ? appIconSlot(path) : appIconSlot("");
    const visual = appIcon.image || (list && !directory
      ? `<span class="file-card__type">${escapeHtml((extension || (applicationBundle ? "APP" : "FILE")).slice(0, 4))}</span>`
      : icon(directory ? "folder" : "file"));
    const existing = launchable && state.library.some((libraryItem) => libraryItem.path === path);
    const badge = list && launchable
      ? `<span class="file-card__badge search-result-row__badge${existing ? " is-existing" : ""}">${existing ? "Уже в библиотеке" : "Можно добавить"}</span>`
      : "";
    return `
      <button class="file-card${selected}" title="${escapeHtml(item.entry)}" data-entry-name="${escapeHtml(item.entry)}" data-entry-type="${item.type}" data-entry-path="${escapeHtml(path)}" data-focusable>
        <span class="file-card__visual ${directory ? "is-folder" : "is-file"}${applicationBundle ? " is-application" : ""}${appIcon.className}"${appIcon.attrs} aria-hidden="true">
          ${visual}
        </span>
        <span class="file-card__info">
          <span class="file-card__name">${escapeHtml(item.entry)}</span>
          <span class="file-card__detail">${detail}</span>
        </span>
        ${badge}
      </button>`;
  }

  function explorerFolderSizesEnabled() {
    return state.settings.explorerFolderSizes === true;
  }

  function explorerFolderSizesNeeded() {
    return hasNativeApi() && explorerFolderSizesEnabled() && Boolean(FolderSizes.buildCommand(explorerPath, getOsName()));
  }

  async function setExplorerFolderSizes(enabled) {
    state.settings.explorerFolderSizes = Boolean(enabled);
    await saveState();
    renderExplorer();
    syncFolderSizes();
  }

  function knownFolderSize(path) {
    const cached = folderSizeCache.get(path);
    // Частичный подсчёт с нулём ничего не говорит о размере — считаем его неизвестным.
    return cached && !(cached.partial && cached.size === 0) ? cached : null;
  }

  function folderSizeText(path) {
    const cached = knownFolderSize(path);
    if (cached) return `${cached.partial ? "≥ " : ""}${Model.formatFileSize(cached.size)}`;
    return folderSizeJob?.path === explorerPath ? "считаю…" : "";
  }

  function scheduleFolderSizeRender() {
    clearTimeout(folderSizeRenderTimer);
    folderSizeRenderTimer = setTimeout(() => {
      if (!explorerReadError) renderExplorer();
    }, 250);
  }

  function applyFolderSizeOutput(job, results) {
    if (!results.length) return;
    const now = Date.now();
    results.forEach((result) => {
      folderSizeCache.set(Model.joinPath(job.path, result.name, getOsName()), { size: result.size, partial: result.partial, at: now });
    });
    if (job.path === explorerPath) scheduleFolderSizeRender();
  }

  function finishFolderSizeJob(job) {
    if (folderSizeJob !== job) return;
    clearTimeout(job.timeout);
    folderSizeJob = null;
    if (job.path === explorerPath) scheduleFolderSizeRender();
  }

  function handleFolderSizeEvent(job, detail) {
    if (detail.action === "stdOut") {
      applyFolderSizeOutput(job, job.parser.feed(detail.data));
    } else if (detail.action === "exit") {
      applyFolderSizeOutput(job, job.parser.flush());
      finishFolderSizeJob(job);
    }
  }

  function handleSpawnedProcess(event) {
    const detail = event.detail || {};
    const handler = processHandlers.get(detail.id);
    if (handler) {
      if (detail.action === "exit") processHandlers.delete(detail.id);
      handler(detail);
    } else if (processesStarting > 0) {
      // Вывод может прийти раньше, чем spawnProcess вернёт номер процесса, — придерживаем его.
      earlyProcessEvents.push(detail);
    }
  }

  // Запускает процесс и направляет его события (stdOut, stdErr, exit) в onEvent.
  async function spawnWithEvents(command, onEvent) {
    processesStarting += 1;
    try {
      const process = await globalScope.Neutralino.os.spawnProcess(command);
      processHandlers.set(process.id, onEvent);
      const early = earlyProcessEvents.filter((detail) => detail.id === process.id);
      early.forEach((detail) => earlyProcessEvents.splice(earlyProcessEvents.indexOf(detail), 1));
      early.forEach((detail) => handleSpawnedProcess({ detail }));
      return process;
    } finally {
      processesStarting -= 1;
      if (!processesStarting) earlyProcessEvents.length = 0;
    }
  }

  async function stopBackgroundProcesses() {
    await stopFolderSizeJob();
    await Promise.all([...processHandlers.keys()].map((id) => globalScope.Neutralino.os.updateSpawnedProcess(id, "exit").catch(() => {})));
  }

  async function stopFolderSizeJob(job = folderSizeJob) {
    if (!job) return;
    if (folderSizeJob === job) folderSizeJob = null;
    clearTimeout(job.timeout);
    job.cancelled = true;
    if (job.id !== null) {
      await globalScope.Neutralino.os.updateSpawnedProcess(job.id, "exit").catch(() => {});
    }
  }

  async function startFolderSizeJob(path) {
    const command = FolderSizes.buildCommand(path, getOsName());
    if (!command) return;
    if (folderSizeJob) stopFolderSizeJob(folderSizeJob);
    // Задание становится текущим сразу, чтобы интерфейс тут же показал «считаю…».
    const job = { path, id: null, timeout: 0, cancelled: false, parser: FolderSizes.createParser(getOsName(), path) };
    folderSizeJob = job;
    try {
      const process = await spawnWithEvents(command, (detail) => {
        if (!job.cancelled) handleFolderSizeEvent(job, detail);
      });
      job.id = process.id;
      if (folderSizeJob !== job || job.cancelled) {
        await globalScope.Neutralino.os.updateSpawnedProcess(process.id, "exit").catch(() => {});
        return;
      }
      job.timeout = setTimeout(() => {
        if (folderSizeJob !== job) return;
        stopFolderSizeJob(job);
        if (path === explorerPath) scheduleFolderSizeRender();
      }, FOLDER_SIZE_JOB_TIMEOUT_MS);
    } catch (error) {
      console.warn("Unable to measure folder sizes", error);
      finishFolderSizeJob(job);
    }
  }

  // Запускает подсчёт, если размеры сейчас показываются и для текущей папки их ещё нет (или они устарели).
  function syncFolderSizes() {
    if (!explorerFolderSizesNeeded() || explorerReadError) {
      if (folderSizeJob) {
        stopFolderSizeJob();
        scheduleFolderSizeRender();
      }
      return;
    }
    if (folderSizeJob?.path === explorerPath) return;
    const now = Date.now();
    const stale = explorerEntries.some((entry) => {
      if (entry.type !== "DIRECTORY") return false;
      const cached = folderSizeCache.get(Model.joinPath(explorerPath, entry.entry, getOsName()));
      return !cached || now - cached.at > FOLDER_SIZE_TTL_MS;
    });
    if (stale) {
      startFolderSizeJob(explorerPath);
      renderExplorer();
    } else if (folderSizeJob) {
      stopFolderSizeJob();
    }
  }

  function renderExplorerControls() {
    const sort = explorerSortKey();
    const view = explorerViewMode();
    elements["explorer-sort-label"].textContent = EXPLORER_SORT_LABELS[sort];
    elements["explorer-sort-menu"].querySelectorAll("[data-sort]").forEach((option) => {
      const active = option.dataset.sort === sort;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-explorer-view]").forEach((button) => {
      const active = button.dataset.explorerView === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
    elements["explorer-grid"].classList.toggle("is-list", view === "list");
    elements["explorer-folder-sizes"].checked = explorerFolderSizesEnabled();
    elements["explorer-folder-sizes-switch"].title = getOsName() === "Darwin"
      ? "Размер папок считается в фоне. macOS может спросить разрешение на доступ к «Документам», «Рабочему столу» и «Загрузкам»."
      : "Размер папок считается в фоне; на больших дисках это занимает время.";
  }

  // Neutralino не отдаёт размер и дату в readDirectory, поэтому спрашиваем их по каждому элементу,
  // по 12 запросов одновременно. Результат кешируется для текущей папки.
  async function loadExplorerStats(path, entries, requestId) {
    const pending = entries.filter((entry) => !explorerStats.has(entry.entry));
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length && requestId === explorerRequestId) {
        const entry = pending[cursor];
        cursor += 1;
        try {
          const stats = await globalScope.Neutralino.filesystem.getStats(Model.joinPath(path, entry.entry, getOsName()));
          if (requestId === explorerRequestId) explorerStats.set(entry.entry, { size: Number(stats?.size), modifiedAt: Number(stats?.modifiedAt) });
        } catch (error) {
          if (requestId === explorerRequestId) explorerStats.set(entry.entry, null);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, pending.length) }, worker));
  }

  async function refreshExplorerOrder() {
    renderExplorerControls();
    if (explorerNeedsStats() && explorerPath && !explorerReadError) {
      const requestId = explorerRequestId;
      await loadExplorerStats(explorerPath, explorerEntries, requestId);
      if (requestId !== explorerRequestId) return;
    }
    renderExplorer();
    syncFolderSizes();
  }

  function isExplorerSortMenuOpen() {
    return elements["explorer-sort-menu"].classList.contains("is-open");
  }

  function openExplorerSortMenu() {
    if (isExplorerSortMenuOpen()) return;
    renderExplorerControls();
    elements["explorer-sort-menu"].classList.add("is-open");
    elements["explorer-sort-menu"].setAttribute("aria-hidden", "false");
    elements["explorer-sort-button"].setAttribute("aria-expanded", "true");
    const current = elements["explorer-sort-menu"].querySelector(`[data-sort="${explorerSortKey()}"]`);
    requestAnimationFrame(() => Navigation.setFocus(current, { scroll: false }));
  }

  function closeExplorerSortMenu(options = {}) {
    if (!isExplorerSortMenuOpen()) return false;
    elements["explorer-sort-menu"].classList.remove("is-open");
    elements["explorer-sort-menu"].setAttribute("aria-hidden", "true");
    elements["explorer-sort-button"].setAttribute("aria-expanded", "false");
    if (options.focusButton !== false) requestAnimationFrame(() => Navigation.setFocus(elements["explorer-sort-button"], { scroll: false }));
    return true;
  }

  async function setExplorerSort(sort) {
    closeExplorerSortMenu();
    if (!Model.EXPLORER_SORTS.includes(sort) || sort === explorerSortKey()) return;
    state.settings.explorerSort = sort;
    await saveState();
    await refreshExplorerOrder();
  }

  async function setExplorerView(view) {
    if (!["tiles", "list"].includes(view) || view === explorerViewMode()) return;
    state.settings.explorerView = view;
    await saveState();
    await refreshExplorerOrder();
  }

  function explorerSortStats() {
    const stats = new Map(explorerStats);
    if (!explorerFolderSizesNeeded()) return stats;
    explorerEntries.forEach((entry) => {
      if (entry.type !== "DIRECTORY") return;
      const cached = knownFolderSize(Model.joinPath(explorerPath, entry.entry, getOsName()));
      if (cached) stats.set(entry.entry, { ...(explorerStats.get(entry.entry) || {}), folderSize: cached.size });
    });
    return stats;
  }

  function renderExplorer() {
    renderExplorerControls();
    const focused = document.querySelector(".is-focused");
    const focusedPath = focused && elements["explorer-grid"].contains(focused) ? focused.dataset.entryPath : "";
    const sortedEntries = Model.sortEntries(explorerEntries, getOsName(), { sort: explorerSortKey(), stats: explorerSortStats() });
    const visibleEntries = sortedEntries.filter((entry) => Model.matchesEntrySearch(entry, explorerFilter));
    const filtering = Boolean(explorerFilter.trim());
    elements["explorer-path"].textContent = explorerPath || "Выберите папку";
    elements["explorer-filter"].value = explorerFilter;
    elements["explorer-count"].textContent = explorerReadError ? "" : filtering
      ? `${visibleEntries.length} из ${explorerEntries.length}`
      : explorerEntries.length
        ? `${explorerEntries.length} ${pluralize(explorerEntries.length, ["элемент", "элемента", "элементов"])}`
      : "";
    elements["explorer-grid"].innerHTML = explorerReadError
      ? `<div class="empty-state empty-state--compact"><div class="empty-state__icon">${icon("folder")}</div><h3>Не удалось открыть папку</h3><p>Проверьте доступ к папке и попробуйте снова.</p></div>`
      : visibleEntries.length
      ? visibleEntries.map(fileEntryMarkup).join("")
      : filtering && explorerEntries.length
        ? `<div class="empty-state empty-state--compact"><div class="empty-state__icon">${icon("search")}</div><h3>Ничего не найдено</h3><p>Попробуйте изменить запрос для этой папки.</p></div>`
        : `<div class="empty-state empty-state--compact"><div class="empty-state__icon">${icon("folder")}</div><h3>Папка пуста</h3><p>Здесь нет файлов или вложенных папок.</p></div>`;
    watchAppIcons(elements["explorer-grid"]);
    if (focusedPath) {
      const card = [...elements["explorer-grid"].querySelectorAll("[data-entry-path]")].find((element) => element.dataset.entryPath === focusedPath);
      if (card) Navigation.setFocus(card);
    }
  }

  function pluralize(number, forms) {
    const mod10 = number % 10;
    const mod100 = number % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  function folderKey(path) {
    const normalized = Model.normalizeFolderPath(path, getOsName());
    return getOsName() === "Windows" ? normalized.toLocaleLowerCase() : normalized;
  }

  function pinnedFolders() {
    return Array.isArray(state.settings.explorerPins) ? state.settings.explorerPins : [];
  }

  function isPinnedFolder(path) {
    return pinnedFolders().some((pin) => Model.sameFolder(pin, path, getOsName()));
  }

  function pinLabel(path) {
    return systemFolderLabels.get(folderKey(path)) || Model.folderDisplayName(path, getOsName());
  }

  // Домашняя папка, «Рабочий стол», «Документы» и «Загрузки» — подписи по-русски и стартовый набор закреплённых.
  async function resolveSystemFolders() {
    const folders = [];
    if (!hasNativeApi()) {
      homeFolderPath = "/Users/Player";
      systemFolderLabels.set(folderKey(homeFolderPath), "Домашняя папка");
      return [homeFolderPath];
    }
    const names = [["home", "Домашняя папка"], ["desktop", "Рабочий стол"], ["documents", "Документы"], ["downloads", "Загрузки"]];
    for (const [name, label] of names) {
      try {
        const path = Model.normalizeFolderPath(await globalScope.Neutralino.os.getPath(name), getOsName());
        if (!path) continue;
        if (name === "home") homeFolderPath = path;
        systemFolderLabels.set(folderKey(path), label);
        folders.push(path);
      } catch (error) {
        console.warn(`Unable to resolve the ${name} folder`, error);
      }
    }
    return folders;
  }

  function pinRowMarkup(path, index, total) {
    const active = Model.sameFolder(path, explorerPath, getOsName());
    const parent = Model.parentPath(path, getOsName());
    const subtitle = parent && !Model.sameFolder(parent, path, getOsName()) ? parent : "";
    const label = pinLabel(path);
    const attrs = `data-pin-path="${escapeHtml(path)}"`;
    return `
      <div class="pin-row${active ? " is-active" : ""}">
        <button type="button" class="pin-row__main" data-action="open-pinned-folder" data-pin-role="open" ${attrs} data-focusable title="${escapeHtml(path)}" ${active ? 'aria-current="true"' : ""}>
          <span class="pin-row__icon" aria-hidden="true">${icon("folder")}</span>
          <span class="pin-row__text"><b>${escapeHtml(label)}</b>${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}</span>
        </button>
        ${active ? `
        <div class="pin-row__actions" role="group" aria-label="Управление закреплённой папкой">
          <button type="button" class="pin-row__action" data-action="move-pinned-folder" data-direction="up" data-pin-role="up" ${attrs} data-focusable aria-label="Поднять выше" title="Поднять выше" ${index === 0 ? "disabled" : ""}>${icon("chevron-up")}</button>
          <button type="button" class="pin-row__action" data-action="move-pinned-folder" data-direction="down" data-pin-role="down" ${attrs} data-focusable aria-label="Опустить ниже" title="Опустить ниже" ${index === total - 1 ? "disabled" : ""}>${icon("chevron-down")}</button>
          <button type="button" class="pin-row__action pin-row__action--danger pin-row__action--wide" data-action="unpin-folder" data-pin-role="unpin" ${attrs} data-focusable title="Открепить">${icon("close")}<span>Открепить</span></button>
        </div>` : ""}
      </div>`;
  }

  function pinElement(path, role) {
    return [...elements["explorer-pins"].querySelectorAll("[data-pin-path]")]
      .find((element) => element.dataset.pinRole === role && Model.sameFolder(element.dataset.pinPath, path, getOsName())) || null;
  }

  // focusTarget: { path, role } — куда поставить фокус после перерисовки (иначе сохраняем текущий).
  function renderExplorerPins(focusTarget = null) {
    const pins = pinnedFolders();
    const focused = document.querySelector(".is-focused");
    const keep = focusTarget || (focused && elements["explorer-pins"].contains(focused)
      ? { path: focused.dataset.pinPath, role: focused.dataset.pinRole }
      : null);
    elements["explorer-pins"].innerHTML = pins.length
      ? pins.map((pin, index) => pinRowMarkup(pin, index, pins.length)).join("")
      : '<p class="explorer-pins__empty">Здесь будут закреплённые папки. Нажмите «+», чтобы закрепить текущую, или X на папке.</p>';
    const currentPinned = isPinnedFolder(explorerPath);
    elements["explorer-pin-current"].disabled = !explorerPath || currentPinned;
    elements["explorer-pin-current"].title = currentPinned ? "Текущая папка уже закреплена" : "Закрепить текущую папку";
    if (!keep) return;
    const target = (keep.path && (pinElement(keep.path, keep.role) || pinElement(keep.path, "open"))) || null;
    if (target && !target.disabled) Navigation.setFocus(target, { scroll: false });
    else if (target) Navigation.setFocus(pinElement(keep.path, "open"), { scroll: false });
    else if (keep.fallback) Navigation.setFocus(keep.fallback, { scroll: false });
  }

  async function updatePinnedFolders(pins, focusTarget) {
    state.settings.explorerPins = pins;
    await saveState();
    renderExplorerPins(focusTarget);
  }

  async function pinFolderPath(path) {
    if (!path || isPinnedFolder(path)) return;
    await updatePinnedFolders(Model.pinFolder(pinnedFolders(), path, getOsName()), { path, role: "open" });
    showToast(`Закреплено: ${pinLabel(path)}`);
  }

  async function unpinFolderPath(path) {
    const pins = pinnedFolders();
    const index = pins.findIndex((pin) => Model.sameFolder(pin, path, getOsName()));
    if (index < 0) return;
    const next = Model.unpinFolder(pins, path, getOsName());
    // Фокус переходит на соседнюю папку, а если закреплённых не осталось — на «+».
    const neighbour = next[Math.min(index, next.length - 1)];
    const focusTarget = elements["explorer-pins"].contains(document.querySelector(".is-focused"))
      ? { path: neighbour, role: "open", fallback: elements["explorer-pin-current"] }
      : null;
    await updatePinnedFolders(next, focusTarget);
    showToast(`Откреплено: ${pinLabel(path)}`);
  }

  function manageAttributes(path, name, type) {
    return `data-manage-path="${escapeHtml(path)}" data-manage-name="${escapeHtml(name)}" data-manage-type="${escapeHtml(type)}"`;
  }

  // «Переименовать» и «Удалить» — общие для файлов и папок в Проводнике.
  function manageActionsMarkup(path, name, type) {
    const attrs = manageAttributes(path, name, type);
    return `
      <button class="action-list__item" data-action="rename-entry" ${attrs} data-focusable><span>${icon("edit")}</span><b>Переименовать</b><i>${icon("chevron")}</i></button>
      <button class="action-list__item action-list__item--danger" data-action="delete-entry" ${attrs} data-focusable><span>${icon("trash")}</span><b>Удалить</b><i>${icon("chevron")}</i></button>`;
  }

  function fileManagerOpenLabel() {
    const osName = getOsName();
    if (osName === "Darwin") return "Открыть в Finder";
    if (osName === "Windows") return "Открыть в Проводнике Windows";
    return "Открыть в файловом менеджере";
  }

  function openFolderActions(path, name) {
    const pinned = isPinnedFolder(path);
    const attrs = manageAttributes(path, name, "DIRECTORY");
    openModal({
      title: name,
      eyebrow: "ПАПКА",
      body: `
        <div class="action-list" data-folder-action-path="${escapeHtml(path)}">
          <button class="action-list__item" data-action="open-folder" data-focusable><span>${icon("folder")}</span><b>Открыть</b><i>Enter</i></button>
          <button class="action-list__item" data-action="${pinned ? "unpin-folder" : "pin-folder"}" data-pin-path="${escapeHtml(path)}" data-focusable><span>${icon("pin")}</span><b>${pinned ? "Убрать из закреплённых" : "Закрепить слева"}</b><i>${icon("chevron")}</i></button>
          <button class="action-list__item" data-action="open-in-file-manager" ${attrs} data-focusable><span>${icon("exit")}</span><b>${fileManagerOpenLabel()}</b><i>${icon("chevron")}</i></button>
          ${manageActionsMarkup(path, name, "DIRECTORY")}
        </div>`
    });
  }

  function openFileActions(path, name) {
    const attrs = manageAttributes(path, name, "FILE");
    openModal({
      title: name,
      eyebrow: "ФАЙЛ",
      body: `
        <div class="action-list">
          <button class="action-list__item" data-action="open-file-default" ${attrs} data-focusable><span>${icon("file")}</span><b>Открыть</b><i>Enter</i></button>
          ${manageActionsMarkup(path, name, "FILE")}
        </div>`
    });
  }

  // X или правый клик по карточке: меню зависит от того, где карточка и что это за элемент.
  function openEntryActions(card) {
    const { entryPath: path, entryName: name, entryType: type } = card.dataset;
    const inExplorer = Boolean(card.closest("#explorer-grid"));
    if (Model.isLaunchableEntry(name, type, getOsName())) openExplorerActions(path, name, type, { manage: inExplorer });
    else if (!inExplorer) return false;
    else if (type === "DIRECTORY") openFolderActions(path, name);
    else openFileActions(path, name);
    return true;
  }

  function openRenameDialog(path, name, type) {
    const isFile = type === "FILE";
    openModal({
      title: "Переименовать",
      eyebrow: isFile ? "ФАЙЛ" : Model.isApplicationBundle(name, type, getOsName()) ? "ПРИЛОЖЕНИЕ" : "ПАПКА",
      body: `
        <form class="rename-form" id="rename-form">
          <label class="field field--wide">
            <span>Новое имя</span>
            <input name="entryName" value="${escapeHtml(name)}" autocomplete="off" spellcheck="false" data-focusable>
          </label>
          <p class="inline-notice rename-form__error" data-rename-error role="alert" hidden></p>
          <div class="modal-actions">
            <button type="button" class="action-button" data-action="close-modal" data-focusable>Отмена</button>
            <button type="submit" class="action-button action-button--primary" data-focusable>Переименовать</button>
          </div>
        </form>`,
      onReady: () => {
        const form = document.getElementById("rename-form");
        const input = form.elements.entryName;
        Navigation.setFocus(input, { scroll: false });
        // Как в Finder и Проводнике: выделено имя без расширения.
        const dot = isFile ? name.lastIndexOf(".") : -1;
        input.setSelectionRange(0, dot > 0 ? dot : name.length);
        input.addEventListener("input", () => { form.querySelector("[data-rename-error]").hidden = true; });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          await renameEntry(path, name, input.value, form);
        });
      }
    });
  }

  function openDeleteConfirm(path, name, type) {
    const folder = type === "DIRECTORY" && !Model.isApplicationBundle(name, type, getOsName());
    openModal({
      title: `Удалить «${name}»?`,
      eyebrow: "УДАЛЕНИЕ",
      body: `
        <div class="action-list" ${manageAttributes(path, name, type)}>
          <p class="inline-notice">${folder ? "Папка вместе со всем содержимым будет перемещена" : "Файл будет перемещён"} в Корзину — оттуда ${folder ? "её" : "его"} можно восстановить.</p>
          <button class="action-list__item" data-action="close-modal" data-focusable><span>${icon("close")}</span><b>Отмена</b><i>Esc</i></button>
          <button class="action-list__item action-list__item--danger" data-action="confirm-delete-entry" ${manageAttributes(path, name, type)} data-focusable><span>${icon("trash")}</span><b>Переместить в Корзину</b><i>${icon("chevron")}</i></button>
        </div>`,
      onReady: () => {
        // Безопасный вариант по умолчанию: фокус на «Отмена».
        const cancel = elements["modal-body"].querySelector('[data-action="close-modal"]');
        if (cancel) Navigation.setFocus(cancel, { scroll: false });
      }
    });
  }

  function explorerCard(entryName) {
    return [...elements["explorer-grid"].querySelectorAll("[data-entry-path]")].find((card) => card.dataset.entryName === entryName) || null;
  }

  // После переименования папки пути в библиотеке, закреплённых, папках поиска и фоне указывают на новое место.
  function updatePathsAfterRename(oldPath, newPath) {
    const osName = getOsName();
    const moved = (path) => Model.replacePathPrefix(path, oldPath, newPath, osName);
    state.library.forEach((item) => {
      item.path = moved(item.path) || item.path;
      if (item.coverSource === "file" && item.coverPath) item.coverPath = moved(item.coverPath) || item.coverPath;
    });
    state.settings.explorerPins = pinnedFolders().map((pin) => moved(pin) || pin);
    state.settings.searchPaths = (state.settings.searchPaths || []).map((folder) => moved(folder) || folder);
    if (state.settings.backgroundPath) state.settings.backgroundPath = moved(state.settings.backgroundPath) || state.settings.backgroundPath;
    [...folderSizeCache.keys()].forEach((key) => {
      const next = moved(key);
      if (next && next !== key) {
        folderSizeCache.set(next, folderSizeCache.get(key));
        folderSizeCache.delete(key);
      }
    });
  }

  async function renameEntry(path, oldName, rawName, form) {
    const osName = getOsName();
    const errorElement = form.querySelector("[data-rename-error]");
    const showError = (message) => {
      errorElement.textContent = message;
      errorElement.hidden = false;
    };
    const problem = Model.validateEntryName(rawName, osName);
    if (problem) return showError(problem);
    const newName = String(rawName).trim();
    if (newName === oldName) {
      closeModal();
      return;
    }
    if (!hasNativeApi()) {
      showToast("Переименование доступно в приложении Neutralino", "info");
      return;
    }
    const newPath = Model.renamedPath(path, newName, osName);
    // Смена только регистра букв («game» → «Game») — это тот же файл, проверять занятость имени не нужно.
    if (newName.toLocaleLowerCase() !== oldName.toLocaleLowerCase()) {
      const taken = await globalScope.Neutralino.filesystem.getStats(newPath).then(() => true, () => false);
      if (taken) return showError("Файл или папка с таким именем уже есть");
    }
    try {
      await globalScope.Neutralino.filesystem.move(path, newPath);
    } catch (error) {
      console.error(error);
      return showError("Не удалось переименовать: нет доступа или файл сейчас используется");
    }
    updatePathsAfterRename(path, newPath);
    await saveState();
    renderLibrary();
    applyBackground();
    renderExplorerPins();
    await readExplorerDirectory(explorerPath, { focusEntry: newName });
    returnFocusTarget = explorerCard(newName) || returnFocusTarget;
    closeModal();
    showToast(`Переименовано: ${newName}`);
  }

  async function deleteEntry(path, name) {
    const osName = getOsName();
    const cards = [...elements["explorer-grid"].querySelectorAll("[data-entry-path]")];
    const index = cards.findIndex((card) => card.dataset.entryPath === path);
    const neighbourName = (cards[index + 1] || cards[index - 1])?.dataset.entryName;
    if (!hasNativeApi()) {
      closeModal();
      showToast("Удаление доступно в приложении Neutralino", "info");
      return;
    }
    try {
      await globalScope.Neutralino.os.trashItem(path);
    } catch (error) {
      console.error(error);
      showToast("Не удалось переместить в Корзину: нет доступа или файл сейчас используется", "error");
      return;
    }
    // Закреплённые папки внутри удалённой больше не существуют.
    const pins = pinnedFolders();
    const remainingPins = pins.filter((pin) => !Model.replacePathPrefix(pin, path, path, osName));
    if (remainingPins.length !== pins.length) {
      state.settings.explorerPins = remainingPins;
      await saveState();
      renderExplorerPins();
    }
    [...folderSizeCache.keys()].forEach((key) => {
      if (Model.replacePathPrefix(key, path, path, osName)) folderSizeCache.delete(key);
    });
    await readExplorerDirectory(explorerPath, { focusEntry: neighbourName });
    returnFocusTarget = (neighbourName && explorerCard(neighbourName)) || elements["explorer-grid"].querySelector("[data-entry-path]") || null;
    closeModal();
    showToast(`Перемещено в Корзину: ${name}`);
  }

  // После смены папки: если фокус остался на живом элементе (закреплённая папка, панель инструментов) — не трогаем,
  // иначе ставим его на папку, из которой вышли (при переходе вверх), или на первый элемент списка.
  function focusAfterExplorerRead(focusEntry) {
    if (activeSection !== "explorer" || hasOverlayOpen()) {
      Navigation.ensureFocus();
      return;
    }
    const focused = document.querySelector(".is-focused");
    const cards = [...elements["explorer-grid"].querySelectorAll("[data-entry-path]")];
    const target = focusEntry ? cards.find((card) => card.dataset.entryName === focusEntry) : null;
    if (target) {
      Navigation.setFocus(target);
      return;
    }
    if (focused?.isConnected && !elements["explorer-grid"].contains(focused)) {
      Navigation.ensureFocus();
      return;
    }
    if (cards[0]) Navigation.setFocus(cards[0], { scroll: false });
    else Navigation.ensureFocus();
  }

  function readExplorerParent() {
    const parent = Model.parentPath(explorerPath, getOsName());
    if (!parent || parent === explorerPath) return false;
    const child = Model.folderDisplayName(explorerPath, getOsName());
    readExplorerDirectory(parent, { focusEntry: child });
    return true;
  }

  async function readExplorerDirectory(path, options = {}) {
    if (!path) return;
    const requestId = ++explorerRequestId;
    explorerStats = new Map();
    explorerPath = path;
    renderExplorerPins();
    explorerFilter = "";
    selectedExplorerPath = "";
    explorerReadError = false;
    elements["explorer-path"].textContent = path;
    elements["explorer-grid"].innerHTML = '<div class="loading-state"><span></span><p>Читаю папку…</p></div>';
    try {
      if (!hasNativeApi()) {
        explorerEntries = [
          { entry: "Games", type: "DIRECTORY" },
          { entry: "Example Game.exe", type: "FILE" },
          { entry: "Notes.txt", type: "FILE" }
        ];
      } else {
        const entries = await globalScope.Neutralino.filesystem.readDirectory(path);
        if (requestId !== explorerRequestId) return;
        explorerEntries = entries;
        if (explorerNeedsStats()) await loadExplorerStats(path, entries, requestId);
        if (requestId !== explorerRequestId) return;
      }
      renderExplorer();
      syncFolderSizes();
      requestAnimationFrame(() => focusAfterExplorerRead(options.focusEntry));
    } catch (error) {
      if (requestId !== explorerRequestId) return;
      if (options.fallbackPath && !Model.sameFolder(options.fallbackPath, path, getOsName())) {
        showToast(`Папка «${pinLabel(path)}» недоступна — открываю домашнюю`, "info");
        readExplorerDirectory(options.fallbackPath);
        return;
      }
      explorerEntries = [];
      explorerReadError = true;
      renderExplorer();
      showToast("Не удалось открыть папку", "error");
      console.error(error);
    }
  }

  function directorySearchResultMarkup(result) {
    const applicationBundle = Model.isApplicationBundle(result.name, result.type, getOsName());
    const extension = Model.extensionOf(result.name).toUpperCase() || "FILE";
    const existing = state.library.some((item) => item.path === result.path);
    const selected = selectedExplorerPath === result.path ? " is-selected" : "";
    const launchable = result.launchable ?? Model.isLaunchableEntry(result.name, result.type, getOsName());
    const badge = !launchable
      ? { label: "Открыть", className: " is-file" }
      : existing
        ? { label: "Уже в библиотеке", className: " is-existing" }
        : { label: "Можно добавить", className: "" };
    const revealLabel = fileManagerLabel();
    const appIcon = launchable ? appIconSlot(result.path) : appIconSlot("");
    return `
      <div class="search-result-wrap">
      <button class="file-card search-result-row${selected}" title="${escapeHtml(result.path)}" data-entry-name="${escapeHtml(result.name)}" data-entry-type="${result.type}" data-entry-path="${escapeHtml(result.path)}" data-focusable>
        <span class="file-card__visual is-file${applicationBundle ? " is-application" : ""}${appIcon.className}"${appIcon.attrs} aria-hidden="true">
          ${appIcon.image || `<span class="file-card__type">${escapeHtml(extension.slice(0, 4))}</span>`}
        </span>
        <span class="file-card__info">
          <span class="file-card__name">${escapeHtml(Model.nameFromPath(result.name))}</span>
          <span class="search-result-row__path">${escapeHtml(result.path)}</span>
        </span>
        <span class="file-card__badge search-result-row__badge${badge.className}">${badge.label}</span>
      </button>
      <button type="button" class="search-result-row__reveal" data-action="reveal-in-file-manager" data-reveal-path="${escapeHtml(result.path)}" data-focusable aria-label="${revealLabel}" title="${revealLabel}">${icon("folder")}</button>
      </div>`;
  }

  function fileManagerLabel() {
    const osName = getOsName();
    if (osName === "Darwin") return "Показать в Finder";
    if (osName === "Windows") return "Показать в Проводнике Windows";
    return "Открыть папку";
  }

  async function revealInFileManager(path) {
    if (!hasNativeApi()) {
      showToast("Открытие папки доступно в приложении Neutralino", "info");
      return;
    }
    try {
      await globalScope.Neutralino.os.execCommand(Platform.buildRevealCommand(path, getOsName()), { background: true });
      const osName = getOsName();
      showToast(osName === "Darwin" ? "Открываю папку в Finder" : osName === "Windows" ? "Открываю папку в Проводнике Windows" : "Открываю папку");
    } catch (error) {
      showToast("Не удалось открыть папку", "error");
      console.error(error);
    }
  }

  function directorySearchPlaceholder(iconName, title, text, action = "") {
    return `
      <div class="empty-state empty-state--compact search-placeholder">
        <div class="empty-state__icon">${icon(iconName)}</div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
        ${action}
      </div>`;
  }

  function launchableExtensionsText() {
    const extensions = Model.LAUNCHABLE_EXTENSIONS[getOsName()] || [];
    return extensions.length ? extensions.map((extension) => `.${extension}`).join(", ") : "исполняемые файлы";
  }

  function renderSearchScope() {
    const allFiles = Boolean(state.settings.searchAllFiles);
    document.querySelectorAll('[data-action="set-search-scope"]').forEach((button) => {
      const active = (button.dataset.scope === "all") === allFiles;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-checked", String(active));
    });
    elements["library-search-input"].placeholder = allFiles ? "Имя файла" : "Название игры или приложения";
  }

  function renderDirectorySearch() {
    const searchPaths = Array.isArray(state.settings.searchPaths) ? state.settings.searchPaths.filter(Boolean) : [];
    const pathCount = searchPaths.length;
    renderSearchScope();
    elements["library-search-input"].value = directorySearchQuery;
    elements["library-search-scope"].textContent = pathCount
      ? `Поиск по ${pathCount} ${pluralize(pathCount, ["папке", "папкам", "папкам"])}`
      : "Папки поиска не выбраны";
    elements["library-search-summary"].textContent = "";

    if (!pathCount) {
      elements["library-search-results"].innerHTML = directorySearchPlaceholder(
        "folder",
        "Добавьте папки поиска",
        "GamePad UI будет просматривать только выбранные вами расположения.",
        `<button class="action-button action-button--primary" data-action="open-search-settings" data-focusable>${icon("plus")} Добавить папки</button>`
      );
      return;
    }

    if (directorySearchMode === "idle") {
      elements["library-search-results"].innerHTML = directorySearchPlaceholder("search", "Введите запрос", "Поиск начнётся после ввода минимум трёх символов.");
      return;
    }

    if (directorySearchMode === "short") {
      const remaining = DirectorySearch.MIN_QUERY_LENGTH - DirectorySearch.normalizeQuery(directorySearchQuery).length;
      elements["library-search-results"].innerHTML = directorySearchPlaceholder("search", "Запрос слишком короткий", `Введите ещё ${remaining} ${pluralize(remaining, ["символ", "символа", "символов"])}.`);
      return;
    }

    if (directorySearchMode === "queued" || directorySearchMode === "loading") {
      elements["library-search-summary"].textContent = "Поиск…";
      elements["library-search-results"].innerHTML = `<div class="loading-state"><span></span><p>Просматриваю выбранные папки…</p></div>`;
      return;
    }

    if (directorySearchMode === "native-required") {
      elements["library-search-results"].innerHTML = directorySearchPlaceholder("search", "Нужен запуск через Neutralino", "Поиск по локальным файлам недоступен в браузерном предпросмотре.");
      return;
    }

    if (directorySearchMode === "error") {
      elements["library-search-results"].innerHTML = directorySearchPlaceholder("search", "Не удалось выполнить поиск", "Проверьте доступ к выбранным папкам и попробуйте снова.");
      return;
    }

    const count = directorySearchResults.length;
    const details = [];
    if (directorySearchOutcome?.truncated) details.push("выдача ограничена");
    if (directorySearchOutcome?.readErrors) details.push(`недоступно папок: ${directorySearchOutcome.readErrors}`);
    elements["library-search-summary"].textContent = `${count} ${pluralize(count, ["результат", "результата", "результатов"])}${details.length ? ` · ${details.join(" · ")}` : ""}`;
    elements["library-search-results"].innerHTML = count
      ? directorySearchResults.map(directorySearchResultMarkup).join("")
      : state.settings.searchAllFiles
        ? directorySearchPlaceholder("search", "Ничего не найдено", "Попробуйте другое слово или добавьте ещё одну папку поиска.")
        : directorySearchPlaceholder(
          "search",
          "Приложения не найдены",
          `Сейчас ищутся только приложения (${launchableExtensionsText()}). Чтобы найти документы, архивы и другие файлы, включите «Все файлы».`,
          `<button class="action-button action-button--primary" data-action="set-search-scope" data-scope="all" data-focusable>${icon("search")} Искать все файлы</button>`
        );
    watchAppIcons(elements["library-search-results"]);
  }

  async function setSearchScope(scope) {
    const allFiles = scope === "all";
    if (Boolean(state.settings.searchAllFiles) === allFiles) return;
    state.settings.searchAllFiles = allFiles;
    await saveState();
    queueDirectorySearch();
  }

  // Файл — программой, назначенной в системе; папка (options.folder) — в Finder или Проводнике Windows.
  async function openFileWithDefaultApp(path, name, options = {}) {
    if (!hasNativeApi()) {
      showToast(`Предпросмотр открытия: ${name}`, "info");
      return;
    }
    try {
      await globalScope.Neutralino.os.execCommand(Platform.buildOpenCommand(path, getOsName()), { background: true });
      showToast(options.folder ? `${fileManagerOpenLabel().replace("Открыть", "Открываю")}: ${name}` : `Открываю: ${name}`);
    } catch (error) {
      showToast(options.folder ? "Не удалось открыть папку" : "Не удалось открыть файл", "error");
      console.error(error);
    }
  }

  async function runDirectorySearch(query, requestId) {
    directorySearchMode = "loading";
    renderDirectorySearch();
    try {
      const outcome = await DirectorySearch.find({
        roots: [...state.settings.searchPaths],
        query,
        osName: getOsName(),
        readDirectory: (path) => globalScope.Neutralino.filesystem.readDirectory(path),
        joinPath: Model.joinPath,
        isLaunchableEntry: Model.isLaunchableEntry,
        includeAllFiles: Boolean(state.settings.searchAllFiles),
        shouldCancel: () => requestId !== directorySearchRequestId
      });
      if (requestId !== directorySearchRequestId || outcome.cancelled) return;
      directorySearchOutcome = outcome;
      directorySearchResults = outcome.results;
      directorySearchMode = "results";
      renderDirectorySearch();
    } catch (error) {
      if (requestId !== directorySearchRequestId) return;
      directorySearchMode = "error";
      renderDirectorySearch();
      console.error(error);
    }
  }

  function queueDirectorySearch() {
    clearTimeout(directorySearchTimer);
    directorySearchRequestId += 1;
    directorySearchQuery = elements["library-search-input"].value.trim();
    directorySearchResults = [];
    directorySearchOutcome = null;
    const normalizedQuery = DirectorySearch.normalizeQuery(directorySearchQuery);
    const searchPaths = Array.isArray(state.settings.searchPaths) ? state.settings.searchPaths.filter(Boolean) : [];

    if (!normalizedQuery) directorySearchMode = "idle";
    else if (!DirectorySearch.isQueryReady(normalizedQuery)) directorySearchMode = "short";
    else if (!searchPaths.length) directorySearchMode = "idle";
    else if (!hasNativeApi()) directorySearchMode = "native-required";
    else directorySearchMode = "queued";
    renderDirectorySearch();

    if (directorySearchMode !== "queued") return;
    const requestId = directorySearchRequestId;
    directorySearchTimer = setTimeout(() => runDirectorySearch(normalizedQuery, requestId), 320);
  }

  async function defaultExplorerPath() {
    if (!hasNativeApi()) return "/Users/Player";
    try {
      return await globalScope.Neutralino.os.getPath("home");
    } catch (error) {
      console.warn(error);
      return typeof globalScope.NL_CWD === "string" ? globalScope.NL_CWD : "";
    }
  }

  function switchSection(section, options = {}) {
    if (!SECTION_ORDER.includes(section)) return;
    closeExplorerSortMenu({ focusButton: false });
    activeSection = section;
    document.querySelectorAll("[data-section]").forEach((tab) => {
      const active = tab.dataset.section === section;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll("[data-view]").forEach((view) => {
      const active = view.dataset.view === section;
      view.hidden = !active;
      view.classList.toggle("is-active", active);
    });
    selectedItemId = "";
    selectedExplorerPath = "";
    if (section === "explorer" && !explorerEntries.length && explorerPath) readExplorerDirectory(explorerPath, { fallbackPath: homeFolderPath });
    if (options.focus !== false) {
      const first = section === "search"
        ? elements["library-search-input"]
        : document.querySelector(`[data-view="${section}"] [data-focusable]`);
      requestAnimationFrame(() => Navigation.setFocus(first));
    }
  }

  function cycleSection(offset) {
    const index = SECTION_ORDER.indexOf(activeSection);
    const target = SECTION_ORDER[(index + offset + SECTION_ORDER.length) % SECTION_ORDER.length];
    Sound.play("section");
    switchSection(target);
  }

  function showToast(message, type = "success") {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast is-visible toast--${type}`;
    toastTimer = setTimeout(() => { elements.toast.classList.remove("is-visible"); }, 3200);
  }

  // Запоминаем элемент основного экрана, чтобы после закрытия меню или окна фокус вернулся туда же.
  function rememberReturnFocus() {
    const focused = document.querySelector(".is-focused");
    if (focused && !focused.closest("#modal, #system-panel, #apps-panel")) returnFocusTarget = focused;
  }

  function restoreReturnFocus() {
    if (hasOverlayOpen()) return;
    const target = returnFocusTarget?.isConnected
      ? returnFocusTarget
      : document.querySelector(`[data-section="${activeSection}"]`);
    returnFocusTarget = null;
    Navigation.setFocus(target, { scroll: false });
    Navigation.ensureFocus();
  }

  function openModal({ title, eyebrow = "GAMEPAD UI", body, wide = false, onReady }) {
    closeExplorerSortMenu({ focusButton: false });
    rememberReturnFocus();
    elements["modal-title"].textContent = title;
    elements["modal-eyebrow"].textContent = eyebrow;
    elements["modal-body"].innerHTML = body;
    elements.modal.classList.toggle("modal--wide", wide);
    elements["modal-layer"].hidden = false;
    requestAnimationFrame(() => {
      elements["modal-layer"].classList.add("is-open");
      const first = elements.modal.querySelector("[data-focusable]");
      Navigation.setFocus(first, { scroll: false });
      onReady?.();
    });
  }

  function closeModal() {
    if (elements["modal-layer"].hidden) return false;
    elements["modal-layer"].classList.remove("is-open");
    setTimeout(() => {
      elements["modal-layer"].hidden = true;
      elements["modal-body"].innerHTML = "";
      restoreReturnFocus();
    }, 160);
    return true;
  }

  function openSystemMenu() {
    if (elements["system-panel"].classList.contains("is-open")) return;
    closeExplorerSortMenu({ focusButton: false });
    rememberReturnFocus();
    closeAppsPanel();
    elements["system-scrim"].hidden = false;
    elements["system-panel"].classList.add("is-open");
    elements["system-panel"].setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => Navigation.setFocus(elements["system-panel"].querySelector("[data-focusable]"), { scroll: false }));
  }

  function closeSystemMenu() {
    if (!elements["system-panel"].classList.contains("is-open")) return false;
    elements["system-panel"].classList.remove("is-open");
    elements["system-panel"].setAttribute("aria-hidden", "true");
    setTimeout(() => { elements["system-scrim"].hidden = true; }, 220);
    requestAnimationFrame(restoreReturnFocus);
    return true;
  }

  function isAppsPanelOpen() {
    return elements["apps-panel"].classList.contains("is-open");
  }

  // Настоящие значки приложений (.app в macOS; .exe, .lnk, .url в Windows) вместо инициалов и типа файла.
  async function setupAppIcons() {
    const osName = getOsName();
    if (!hasNativeApi() || !AppIcons.supportsIcons(osName)) return;
    try {
      const cachePath = await globalScope.Neutralino.os.getPath("cache");
      if (!cachePath) return;
      iconLoader = AppIcons.createIconLoader({
        osName,
        cacheDir: AppIcons.cacheDirectory(cachePath, osName),
        stat: (file) => globalScope.Neutralino.filesystem.getStats(file),
        readUrl: (file, fresh) => iconImages.get(file, { fresh }),
        spawn: spawnWithEvents,
        write: (id, text) => globalScope.Neutralino.os.updateSpawnedProcess(id, "stdIn", text),
        end: (id) => globalScope.Neutralino.os.updateSpawnedProcess(id, "stdInEnd"),
        onIcon: showAppIcon,
        warn: (...args) => console.warn(...args)
      });
    } catch (error) {
      console.warn("App icons are unavailable", error);
    }
  }

  const DEFAULT_ICON_SYMBOLS = { web: "globe", link: "link", script: "terminal", app: "app-window" };

  function defaultIconMarkup(kind) {
    const safeKind = DEFAULT_ICON_SYMBOLS[kind] ? kind : "app";
    return `<span class="default-app-icon default-app-icon--${safeKind}">${icon(DEFAULT_ICON_SYMBOLS[safeKind])}</span>`;
  }

  // Плитка без обложки: настоящий значок, а если его нет или быть не может — значок по типу (сайт, программа, скрипт).
  function cardIconMarkup(path) {
    const kind = AppIcons.defaultIconKind(path);
    const slot = appIconSlot(path);
    if (!slot.attrs) return `<span class="game-card__app-icon has-default-icon" aria-hidden="true">${defaultIconMarkup(kind)}</span>`;
    if (slot.image) return `<span class="game-card__app-icon has-app-icon"${slot.attrs} aria-hidden="true">${slot.image}</span>`;
    const missing = iconLoader.status(path) === "none";
    return `<span class="game-card__app-icon${missing ? " has-default-icon" : ""}"${slot.attrs} data-fallback-icon="${kind}" aria-hidden="true">${missing ? defaultIconMarkup(kind) : ""}</span>`;
  }

  function appIconImage(url) {
    return `<img class="app-icon" src="${escapeHtml(url)}" alt="" draggable="false">`;
  }

  // Уже извлечённый значок вставляется сразу; для остальных запоминаем путь — значок подставится, когда будет готов.
  function appIconSlot(path) {
    if (!iconLoader || !AppIcons.wantsIcon(path, getOsName())) return { attrs: "", className: "", image: "" };
    const url = iconLoader.peek(path);
    return {
      attrs: ` data-app-icon="${escapeHtml(path)}"`,
      className: url ? " has-app-icon" : "",
      image: url ? appIconImage(url) : ""
    };
  }

  function showAppIcon(path, url) {
    const osName = getOsName();
    const key = AppIcons.iconKey(path, osName);
    document.querySelectorAll("[data-app-icon]").forEach((slot) => {
      if (AppIcons.iconKey(slot.dataset.appIcon, osName) !== key) return;
      if (!url) {
        // Значка нет: плитки показывают значок по типу, сайдбар и Проводник оставляют инициалы и тип файла.
        if (slot.dataset.fallbackIcon && !slot.classList.contains("has-app-icon")) {
          slot.innerHTML = defaultIconMarkup(slot.dataset.fallbackIcon);
          slot.classList.add("has-default-icon");
        }
        return;
      }
      const image = slot.querySelector("img.app-icon");
      if (image) {
        image.src = url;
        return;
      }
      slot.innerHTML = appIconImage(url);
      slot.classList.remove("has-default-icon");
      slot.classList.add("has-app-icon");
    });
  }

  // Значки извлекаются только для строк, которые видны (или вот-вот появятся) на экране.
  function watchAppIcons(root) {
    if (!iconLoader || typeof IntersectionObserver === "undefined") return;
    if (!iconObserver) {
      iconObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          iconObserver.unobserve(entry.target);
          observedIconSlots.delete(entry.target);
          iconLoader.request(entry.target.dataset.appIcon);
        });
      }, { rootMargin: "240px" });
    }
    observedIconSlots.forEach((slot) => {
      if (slot.isConnected) return;
      iconObserver.unobserve(slot);
      observedIconSlots.delete(slot);
    });
    root.querySelectorAll("[data-app-icon]:not(.has-app-icon):not(.has-default-icon)").forEach((slot) => {
      observedIconSlots.add(slot);
      iconObserver.observe(slot);
    });
  }

  function appsRootLabel() {
    return getOsName() === "Windows" ? "Главное меню" : "Программы";
  }

  function appRowMarkup(app) {
    const favorite = Boolean(state.library.find((item) => item.path === app.path)?.favorite);
    const favoriteLabel = favorite ? "Убрать из избранного" : "Добавить в избранное";
    const appIcon = appIconSlot(app.path);
    return `
      <div class="app-row-wrap">
        <button class="app-row" data-app-path="${escapeHtml(app.path)}" title="${escapeHtml(app.path)}" data-focusable>
          <span class="app-row__icon${appIcon.className}"${appIcon.attrs} aria-hidden="true">${appIcon.image || escapeHtml(initials(app.name))}</span>
          <span class="app-row__text"><b>${escapeHtml(app.name)}</b><small>${escapeHtml(app.group || appsRootLabel())}</small></span>
        </button>
        <button type="button" class="app-row__favorite${favorite ? " is-active" : ""}" data-app-favorite="${escapeHtml(app.path)}" tabindex="-1" aria-label="${favoriteLabel}" title="${favoriteLabel}">${icon("star")}</button>
      </div>`;
  }

  function renderAppsPanel() {
    const osName = getOsName();
    elements["apps-eyebrow"].textContent = osName === "Windows" ? "ГЛАВНОЕ МЕНЮ" : osName === "Darwin" ? "ПРОГРАММЫ" : "ПРИЛОЖЕНИЯ";
    elements["apps-filter"].value = appsFilter;
    elements["apps-meta"].textContent = "";
    const placeholder = (iconName, title, text) => directorySearchPlaceholder(iconName, title, text);

    if (appsStatus === "native-required") {
      elements["apps-list"].innerHTML = placeholder("library", "Нужен запуск через Neutralino", "Список приложений недоступен в браузерном предпросмотре.");
      return;
    }
    if (appsStatus === "unsupported") {
      elements["apps-list"].innerHTML = placeholder("library", "Пока только Windows и macOS", "На этой платформе список приложений ещё не поддерживается.");
      return;
    }
    if (appsStatus === "idle" || appsStatus === "loading") {
      elements["apps-meta"].textContent = "Загрузка…";
      elements["apps-list"].innerHTML = '<div class="loading-state"><span></span><p>Собираю список приложений…</p></div>';
      return;
    }
    if (appsStatus === "error") {
      elements["apps-list"].innerHTML = placeholder("library", "Не удалось прочитать список", "Папки с приложениями недоступны. Попробуйте обновить список.");
      return;
    }

    const visible = Apps.filterApps(appsList, appsFilter);
    const total = `${appsList.length} ${pluralize(appsList.length, ["приложение", "приложения", "приложений"])}`;
    elements["apps-meta"].textContent = appsFilter.trim() ? `${visible.length} из ${appsList.length}` : total;
    elements["apps-list"].innerHTML = visible.length
      ? visible.map(appRowMarkup).join("")
      : appsList.length
        ? placeholder("search", "Ничего не найдено", "Попробуйте изменить запрос.")
        : placeholder("library", "Приложения не найдены", "В папках с приложениями нет ярлыков.");
    watchAppIcons(elements["apps-list"]);
  }

  function focusAppsPanel() {
    const target = elements["apps-list"].querySelector("[data-app-path]") || elements["apps-filter"];
    Navigation.setFocus(target, { scroll: false });
  }

  async function readEnvironmentVariable(name) {
    try {
      return String(await globalScope.Neutralino.os.getEnv(name) || "").trim();
    } catch (error) {
      return "";
    }
  }

  async function appSourceEnvironment(osName) {
    if (osName === "Windows") {
      let appData = await readEnvironmentVariable("APPDATA");
      if (!appData) {
        try { appData = await globalScope.Neutralino.os.getPath("data"); } catch (error) { appData = ""; }
      }
      return { appData, programData: await readEnvironmentVariable("ProgramData") || "C:\\ProgramData" };
    }
    if (osName === "Darwin") return { home: await readEnvironmentVariable("HOME") };
    return {};
  }

  async function loadApps() {
    const requestId = ++appsRequestId;
    if (!hasNativeApi()) {
      appsStatus = "native-required";
      renderAppsPanel();
      return;
    }
    const osName = getOsName();
    appsStatus = "loading";
    renderAppsPanel();
    try {
      const sources = Apps.getAppSources(osName, await appSourceEnvironment(osName));
      if (!sources.length) {
        appsStatus = "unsupported";
      } else {
        const outcome = await Apps.collectApps({
          sources,
          osName,
          readDirectory: (path) => globalScope.Neutralino.filesystem.readDirectory(path),
          joinPath: Model.joinPath
        });
        if (requestId !== appsRequestId) return;
        appsList = outcome.apps;
        appsStatus = outcome.failedSources >= sources.length ? "error" : "ready";
      }
    } catch (error) {
      if (requestId !== appsRequestId) return;
      appsStatus = "error";
      console.error(error);
    }
    renderAppsPanel();
    if (!isAppsPanelOpen()) return;
    const focused = document.querySelector(".is-focused");
    const typing = focused === elements["apps-filter"] && appsFilter.trim();
    if (!typing && !focused?.closest('[data-action="refresh-apps"]')) focusAppsPanel();
  }

  function openAppsPanel() {
    if (isAppsPanelOpen()) return;
    closeExplorerSortMenu({ focusButton: false });
    rememberReturnFocus();
    closeSystemMenu();
    elements["apps-scrim"].hidden = false;
    elements["apps-panel"].classList.add("is-open");
    elements["apps-panel"].setAttribute("aria-hidden", "false");
    elements["apps-toggle"].setAttribute("aria-expanded", "true");
    elements["apps-list"].scrollTop = 0;
    if (appsStatus === "idle") loadApps();
    else renderAppsPanel();
    requestAnimationFrame(focusAppsPanel);
  }

  function closeAppsPanel() {
    if (!isAppsPanelOpen()) return false;
    elements["apps-panel"].classList.remove("is-open");
    elements["apps-panel"].setAttribute("aria-hidden", "true");
    elements["apps-toggle"].setAttribute("aria-expanded", "false");
    setTimeout(() => { if (!isAppsPanelOpen()) elements["apps-scrim"].hidden = true; }, 220);
    requestAnimationFrame(restoreReturnFocus);
    return true;
  }

  function findApp(path) {
    return appsList.find((app) => app.path === path);
  }

  function launchApp(path) {
    const app = findApp(path);
    if (!app) return;
    const libraryItem = state.library.find((item) => item.path === path);
    closeAppsPanel();
    launchItem(libraryItem || Model.normalizeItem({ name: app.name, path }));
  }

  async function toggleAppFavorite(path) {
    const app = findApp(path);
    if (!app) return;
    const existing = state.library.find((item) => item.path === path);
    let favorite = true;
    if (existing) {
      existing.favorite = !existing.favorite;
      favorite = existing.favorite;
    } else {
      state.library.push(Model.normalizeItem({ name: app.name, path, favorite: true }));
    }
    await saveState();
    renderLibrary();
    elements["apps-list"].querySelectorAll("[data-app-favorite]").forEach((button) => {
      if (button.dataset.appFavorite !== path) return;
      const label = favorite ? "Убрать из избранного" : "Добавить в избранное";
      button.classList.toggle("is-active", favorite);
      button.setAttribute("aria-label", label);
      button.title = label;
    });
    showToast(favorite ? `«${app.name}» добавлено в избранное` : `«${app.name}» убрано из избранного`);
  }

  async function chooseFile(filters, defaultPath) {
    if (!hasNativeApi()) {
      showToast("Выбор файлов доступен в приложении Neutralino", "info");
      return "";
    }
    const entries = await globalScope.Neutralino.os.showOpenDialog("Выберите файл", {
      multiSelections: false,
      defaultPath,
      filters
    });
    return entries?.[0] || "";
  }

  function itemFormMarkup(item = {}) {
    const normalized = Model.normalizeItem(item);
    const coverSource = normalized.coverSource || "file";
    const fileCover = coverSource === "file" ? normalized.coverPath : "";
    const urlCover = coverSource === "url" ? normalized.coverPath : "";
    const gameStoryCover = coverSource === "gamestory" ? normalized.coverPath : "";
    return `
      <form class="item-form" id="item-form" data-form-item-id="${escapeHtml(item.id || "")}">
        <label class="field field--wide">
          <span>Название</span>
          <input name="name" value="${escapeHtml(item.name || "")}" placeholder="Например, Forza Horizon" autocomplete="off" data-focusable required>
        </label>
        <label class="field field--wide">
          <span>Исполняемый файл, ярлык, приложение .app или ссылка на сайт</span>
          <div class="field__picker">
            <input name="path" value="${escapeHtml(item.path || "")}" placeholder="C:\\Games\\Game.exe или https://example.com" autocomplete="off" data-focusable required>
            <button type="button" class="action-button" data-action="pick-executable" data-focusable>Обзор</button>
          </div>
        </label>
        <label class="field field--wide">
          <span>Аргументы запуска <small>необязательно, для ссылок не используются</small></span>
          <input name="arguments" value="${escapeHtml(item.arguments || "")}" placeholder="--fullscreen" autocomplete="off" data-focusable>
        </label>
        <div class="cover-field">
          <div class="cover-field__heading"><b>Обложка</b><small>необязательно</small></div>
          <div class="cover-source-options" role="radiogroup" aria-label="Способ выбора обложки">
            <label class="cover-source-choice">
              <input type="radio" name="coverSource" value="file" ${coverSource === "file" ? "checked" : ""} data-focusable>
              <span>Файл</span>
            </label>
            <label class="cover-source-choice">
              <input type="radio" name="coverSource" value="url" ${coverSource === "url" ? "checked" : ""} data-focusable>
              <span>URL-ссылка</span>
            </label>
            <label class="cover-source-choice">
              <input type="radio" name="coverSource" value="gamestory" ${coverSource === "gamestory" ? "checked" : ""} data-focusable>
              <span>GameStory</span>
            </label>
          </div>
          <div class="cover-source-panel" data-cover-source-panel="file" ${coverSource === "file" ? "" : "hidden"}>
            <div class="field__picker">
              <input class="cover-source-input" name="coverFilePath" value="${escapeHtml(fileCover)}" placeholder="Путь к JPG, PNG или WebP" autocomplete="off" data-focusable>
              <button type="button" class="action-button" data-action="pick-cover" data-focusable>Выбрать</button>
            </div>
          </div>
          <div class="cover-source-panel" data-cover-source-panel="url" ${coverSource === "url" ? "" : "hidden"}>
            <input class="cover-source-input" type="url" name="coverUrl" value="${escapeHtml(urlCover)}" placeholder="https://example.com/cover.jpg" autocomplete="off" data-focusable>
          </div>
          <div class="cover-source-panel cover-source-panel--gamestory" data-cover-source-panel="gamestory" ${coverSource === "gamestory" ? "" : "hidden"}>
            <div class="field__picker">
              <input class="cover-source-input" name="coverSearchQuery" value="${escapeHtml(item.name || "")}" placeholder="Название игры" autocomplete="off" data-focusable>
              <button type="button" class="action-button" data-action="search-gamestory-cover" data-focusable>${icon("search")} Найти</button>
            </div>
            <div class="cover-search-results" data-cover-search-results aria-live="polite"></div>
          </div>
          <input type="hidden" name="gameStoryCover" value="${escapeHtml(gameStoryCover)}">
          <input type="hidden" name="coverPath" value="${escapeHtml(normalized.coverPath)}">
          <div class="cover-preview" data-cover-preview>
            <span>Обложка не выбрана</span>
            <img alt="">
          </div>
        </div>
        <label class="toggle-row">
          <input type="checkbox" name="favorite" ${normalized.favorite ? "checked" : ""} data-focusable>
          <span class="toggle"><i></i></span>
          <span><b>Добавить в избранное</b><small>Показывать на первом экране</small></span>
        </label>
        <div class="modal-actions">
          <button type="button" class="action-button" data-action="close-modal" data-focusable>Отмена</button>
          <button type="submit" class="action-button action-button--primary" data-focusable>${item.id ? "Сохранить" : "Добавить"}</button>
        </div>
      </form>`;
  }

  function openItemForm(item = {}) {
    closeSystemMenu();
    openModal({
      title: item.id ? "Изменить приложение" : "Добавить приложение",
      eyebrow: item.id ? "БИБЛИОТЕКА" : "НОВЫЙ ЭЛЕМЕНТ",
      body: itemFormMarkup(item),
      wide: true,
      onReady: () => {
        const form = document.getElementById("item-form");
        form.querySelectorAll('input[name="coverSource"]').forEach((input) => {
          input.addEventListener("change", () => selectCoverSource(form, input.value));
        });
        form.elements.coverFilePath.addEventListener("input", () => {
          if (form.elements.coverSource.value !== "file") return;
          form.elements.coverPath.value = form.elements.coverFilePath.value.trim();
          updateCoverPreview(form, form.elements.coverPath.value);
        });
        form.elements.coverUrl.addEventListener("input", () => {
          if (form.elements.coverSource.value !== "url") return;
          form.elements.coverPath.value = form.elements.coverUrl.value.trim();
          updateCoverPreview(form, form.elements.coverPath.value);
        });
        selectCoverSource(form, form.elements.coverSource.value);
        form.elements.path.addEventListener("change", () => {
          const path = form.elements.path.value.trim();
          if (!form.elements.name.value.trim() && Model.isWebUrl(path)) form.elements.name.value = Model.nameFromPath(path);
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const formData = new FormData(form);
          const updated = Model.normalizeItem({
            id: form.dataset.formItemId || undefined,
            name: formData.get("name"),
            path: formData.get("path"),
            arguments: formData.get("arguments"),
            coverPath: formData.get("coverPath"),
            coverSource: formData.get("coverSource"),
            favorite: formData.get("favorite") === "on",
            addedAt: item.addedAt
          });
          if (!updated.name || !updated.path) {
            showToast("Укажите название и путь", "error");
            return;
          }
          if (/^https?:/i.test(updated.path) && !Model.isWebUrl(updated.path)) {
            showToast("Проверьте ссылку: она должна выглядеть как https://example.com", "error");
            return;
          }
          if (/^www\.[^\s\\/]+\.[a-z]{2,}/i.test(updated.path)) {
            showToast("Добавьте https:// в начало ссылки, например https://" + updated.path, "error");
            return;
          }
          if (["url", "gamestory"].includes(updated.coverSource) && updated.coverPath && !/^https?:\/\//i.test(updated.coverPath)) {
            showToast("Укажите корректную ссылку на обложку", "error");
            return;
          }
          const existingIndex = state.library.findIndex((libraryItem) => libraryItem.id === updated.id);
          if (existingIndex >= 0) state.library.splice(existingIndex, 1, updated);
          else state.library.push(updated);
          await saveState();
          renderLibrary();
          closeModal();
          showToast(existingIndex >= 0 ? "Изменения сохранены" : "Добавлено в библиотеку");
        });
      }
    });
  }

  async function launchItem(item) {
    if (!item) return;
    const launchedAt = recentLaunches.get(item.path);
    if (launchedAt && Date.now() - launchedAt < LAUNCH_REPEAT_GUARD_MS) {
      showToast(`«${item.name}» уже запускается`, "info");
      return;
    }
    recentLaunches.set(item.path, Date.now());
    if (!hasNativeApi()) {
      showToast(`Предпросмотр запуска: ${item.name}`, "info");
      return;
    }
    try {
      const command = Platform.buildLaunchCommand(item, getOsName());
      await globalScope.Neutralino.os.execCommand(command, { background: true });
      showToast(Model.isWebUrl(item.path) ? `Открываю в браузере: ${item.name}` : `Запускаю: ${item.name}`);
    } catch (error) {
      recentLaunches.delete(item.path);
      showToast("Не удалось запустить приложение", "error");
      console.error(error);
    }
  }

  function openItemActions(item) {
    if (!item) return;
    const position = Model.favoritePosition(state.library, state.favoriteOrder, item.id);
    const orderAction = activeSection === "favorites" && position.index >= 0
      ? `<button class="action-list__item" data-action="open-favorite-order" data-focusable><span>${icon("reorder")}</span><b>Порядок</b><i>${position.index + 1} из ${position.total}</i></button>`
      : "";
    openModal({
      title: item.name,
      eyebrow: "ДЕЙСТВИЯ",
      body: `
        <div class="action-list" data-action-item-id="${escapeHtml(item.id)}">
          <button class="action-list__item" data-action="launch-current-item" data-focusable><span>${icon("play")}</span><b>Запустить</b><i>Enter</i></button>
          <button class="action-list__item" data-action="toggle-favorite" data-focusable><span>${icon("star")}</span><b>${item.favorite ? "Убрать из избранного" : "Добавить в избранное"}</b><i>X</i></button>
          ${orderAction}
          <button class="action-list__item" data-action="edit-current-item" data-focusable><span>${icon("edit")}</span><b>Изменить</b><i>${icon("chevron")}</i></button>
          <button class="action-list__item action-list__item--danger" data-action="remove-current-item" data-focusable><span>${icon("trash")}</span><b>Удалить из библиотеки</b><i>${icon("chevron")}</i></button>
        </div>`
    });
  }

  const FAVORITE_MOVE_OPTIONS = [
    { move: "first", icon: "to-start", label: "Сделать первой" },
    { move: "previous", icon: "arrow-left", label: "Сделать предыдущей" },
    { move: "next", icon: "chevron", label: "Сделать следующей" },
    { move: "last", icon: "to-end", label: "Сделать последней" }
  ];

  function favoriteMoveDisabled(move, index, total) {
    return move === "first" || move === "previous" ? index <= 0 : index >= total - 1;
  }

  function favoritePositionText(index, total) {
    return `Позиция ${index + 1} из ${total} в избранном`;
  }

  function openFavoriteOrder(item) {
    const { index, total } = Model.favoritePosition(state.library, state.favoriteOrder, item.id);
    openModal({
      title: item.name,
      eyebrow: "ПОРЯДОК В ИЗБРАННОМ",
      body: `
        <div class="action-list" data-order-item-id="${escapeHtml(item.id)}">
          <p class="inline-notice" data-order-position aria-live="polite">${favoritePositionText(index, total)}</p>
          ${FAVORITE_MOVE_OPTIONS.map((option) => `
            <button class="action-list__item" data-action="move-favorite" data-move="${option.move}" data-focusable ${favoriteMoveDisabled(option.move, index, total) ? "disabled" : ""}><span>${icon(option.icon)}</span><b>${option.label}</b><i></i></button>`).join("")}
        </div>`,
      onReady: () => {
        const first = elements["modal-body"].querySelector("[data-move]:not(:disabled)");
        if (first) Navigation.setFocus(first, { scroll: false });
      }
    });
  }

  // Переставляем уже отрисованные карточки, а не перерисовываем сетку: обложки не перезагружаются,
  // а карточка, на которую вернётся фокус после закрытия окна, остаётся той же.
  function applyFavoriteOrderToGrid() {
    const grid = elements["favorites-grid"];
    const cards = new Map([...grid.querySelectorAll(".game-card[data-item-id]")].map((card) => [card.dataset.itemId, card]));
    const ordered = Model.orderFavorites(state.library, state.favoriteOrder);
    if (ordered.some((item) => !cards.has(item.id))) {
      renderLibrary();
      return;
    }
    ordered.forEach((item) => grid.appendChild(cards.get(item.id)));
  }

  async function moveFavoriteItem(id, move) {
    state.favoriteOrder = Model.moveFavorite(state.library, state.favoriteOrder, id, move);
    await saveState();
    applyFavoriteOrderToGrid();
    const card = [...elements["favorites-grid"].querySelectorAll(".game-card[data-item-id]")].find((element) => element.dataset.itemId === id);
    if (card) returnFocusTarget = card;

    const list = elements["modal-body"].querySelector("[data-order-item-id]");
    if (!list || list.dataset.orderItemId !== id) return;
    const { index, total } = Model.favoritePosition(state.library, state.favoriteOrder, id);
    list.querySelector("[data-order-position]").textContent = favoritePositionText(index, total);
    list.querySelectorAll("[data-move]").forEach((button) => {
      button.disabled = favoriteMoveDisabled(button.dataset.move, index, total);
    });
    const focused = document.querySelector(".is-focused");
    if (!focused || focused.disabled) {
      const next = list.querySelector("[data-move]:not(:disabled)");
      if (next) Navigation.setFocus(next, { scroll: false });
    }
  }

  function explorerActionsMarkup(path, name, options = {}) {
    const existing = state.library.find((item) => item.path === path);
    return `
      <div class="action-list" data-explorer-action-path="${escapeHtml(path)}" data-explorer-action-name="${escapeHtml(name)}">
        ${existing ? '<p class="inline-notice">Этот файл уже есть в библиотеке.</p>' : ""}
        <button class="action-list__item" data-action="add-explorer-library" data-focusable ${existing ? "disabled" : ""}><span>${icon("plus")}</span><b>Добавить в библиотеку</b><i>${icon("chevron")}</i></button>
        <button class="action-list__item" data-action="add-explorer-favorites" data-focusable ${existing ? "disabled" : ""}><span>${icon("star")}</span><b>Добавить в избранное</b><i>${icon("chevron")}</i></button>
        <button class="action-list__item" data-action="launch-explorer-file" data-focusable><span>${icon("play")}</span><b>Запустить сейчас</b><i>Enter</i></button>
        ${options.manage ? manageActionsMarkup(path, name, options.type || "FILE") : ""}
      </div>`;
  }

  function openExplorerActions(path, name, entryType = "FILE", options = {}) {
    const applicationBundle = Model.isApplicationBundle(name, entryType, getOsName());
    openModal({ title: name, eyebrow: applicationBundle ? "ПРИЛОЖЕНИЕ" : "ФАЙЛ", body: explorerActionsMarkup(path, name, { ...options, type: entryType }) });
  }

  async function addExplorerItem(path, name, favorite) {
    if (state.library.some((item) => item.path === path)) {
      showToast("Этот файл уже есть в библиотеке", "info");
      return;
    }
    state.library.push(Model.normalizeItem({ name: Model.nameFromPath(name), path, favorite }));
    await saveState();
    renderLibrary();
    closeModal();
    showToast(favorite ? "Добавлено в избранное" : "Добавлено в библиотеку");
  }

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function detectDisplays() {
    if (!hasNativeApi()) return { status: "native-required", displays: [] };
    const command = Displays.buildQueryCommand(getOsName());
    if (!command) return { status: "unsupported", displays: [] };
    try {
      const result = await globalScope.Neutralino.os.execCommand(command);
      const displays = Displays.parseDisplays(result?.stdOut, getOsName());
      return { status: displays.length ? "ready" : "error", displays };
    } catch (error) {
      console.warn("Unable to detect displays", error);
      return { status: "error", displays: [] };
    }
  }

  function displayChoiceMarkup(value, title, detail, checked, badge) {
    return `
      <label class="display-choice">
        <input type="radio" name="display" value="${escapeHtml(value)}" ${checked ? "checked" : ""} data-focusable>
        <span class="display-choice__badge" aria-hidden="true">${badge}</span>
        <span class="display-choice__text"><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small></span>
      </label>`;
  }

  function displayOptionsMarkup(outcome) {
    const messages = {
      "native-required": "Выбор монитора доступен в приложении Neutralino.",
      unsupported: "На этой платформе выбор монитора пока не поддерживается.",
      error: "Не удалось определить подключённые мониторы."
    };
    if (messages[outcome.status]) return `<p class="muted-copy">${messages[outcome.status]}</p>`;
    const { displays } = outcome;
    if (displays.length < 2) {
      const only = displays[0];
      return `<p class="muted-copy">Подключён один монитор (${only.pixelWidth} × ${only.pixelHeight}). Выбор появится, когда подключите второй.</p>`;
    }
    const preference = state.settings.display;
    const saved = Displays.findDisplay(displays, preference);
    // Сохранённый монитор сейчас не подключён: не сбрасываем выбор, если пользователь меняет другие настройки.
    const missing = preference && !saved
      ? displayChoiceMarkup("keep", "Сохранённый монитор", "Сейчас не подключён — окно останется здесь", true, icon("view"))
      : "";
    return `
      <div class="display-options" role="radiogroup" aria-label="Монитор">
        ${displayChoiceMarkup("auto", "Автоматически", "Монитор, который выберет система", !preference, icon("view"))}
        ${missing}
        ${displays.map((display) => displayChoiceMarkup(
          String(display.index),
          display.label,
          `${display.pixelWidth} × ${display.pixelHeight} · ${Displays.relativePosition(display, displays)}`,
          saved === display,
          String(display.index + 1)
        )).join("")}
      </div>`;
  }

  async function waitForFullScreen(expected, timeout = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await globalScope.Neutralino.window.isFullScreen().catch(() => expected) === expected) return true;
      await delay(100);
    }
    return false;
  }

  async function isWindowOnDisplay(display) {
    try {
      const [position, size] = await Promise.all([globalScope.Neutralino.window.getPosition(), globalScope.Neutralino.window.getSize()]);
      return Displays.containsPoint(display, position.x + size.width / 2, position.y + size.height / 2);
    } catch (error) {
      return false;
    }
  }

  // Полноэкранное окно нельзя просто передвинуть: выходим из полноэкранного режима, переносим окно
  // внутрь нужного монитора и разворачиваем снова — система откроет его на мониторе, где оно находится.
  async function moveWindowToDisplay(display, options = {}) {
    if (!hasNativeApi() || !display) return false;
    const nativeWindow = globalScope.Neutralino.window;
    if (await isWindowOnDisplay(display)) return true;
    try {
      const wasFullScreen = await nativeWindow.isFullScreen().catch(() => false);
      const wasMaximized = !wasFullScreen && await nativeWindow.isMaximized().catch(() => false);
      if (wasFullScreen) {
        await nativeWindow.exitFullScreen();
        await waitForFullScreen(false);
        await delay(getOsName() === "Darwin" ? 700 : 120);
      } else if (wasMaximized) {
        await nativeWindow.unmaximize();
      }
      const bounds = Displays.targetWindowBounds(display);
      // Размер задаём до переноса: в macOS window.setSize заодно центрирует окно на основном
      // экране (так устроена библиотека webview внутри Neutralino) и отменил бы перенос.
      await nativeWindow.setSize({ width: bounds.width, height: bounds.height });
      await nativeWindow.move(bounds.x, bounds.y);
      let moved = await isWindowOnDisplay(display);
      if (!moved) {
        // Окно могло ещё доигрывать анимацию выхода из полноэкранного режима — пробуем ещё раз.
        await delay(400);
        await nativeWindow.move(bounds.x, bounds.y);
        moved = await isWindowOnDisplay(display);
      }
      if (wasFullScreen) {
        await delay(150);
        await nativeWindow.setFullScreen();
      } else if (wasMaximized) {
        await nativeWindow.maximize();
      }
      if (options.announce) {
        showToast(moved ? `Окно перенесено: ${display.label}` : "Не удалось перенести окно на другой монитор", moved ? "success" : "error");
      }
      return moved;
    } catch (error) {
      console.error(error);
      if (options.announce) showToast("Не удалось перенести окно на другой монитор", "error");
      return false;
    }
  }

  async function applySavedDisplay() {
    if (!state.settings.display || !hasNativeApi()) return;
    const outcome = await detectDisplays();
    detectedDisplays = outcome.displays;
    const display = Displays.findDisplay(outcome.displays, state.settings.display);
    if (display && outcome.displays.length > 1) await moveWindowToDisplay(display);
  }

  function openSettings(options = {}) {
    closeSystemMenu();
    const searchPaths = state.settings.searchPaths || [];
    openModal({
      title: "Настройки",
      eyebrow: "ПЕРСОНАЛИЗАЦИЯ",
      wide: true,
      body: `
        <form class="settings-form" id="settings-form">
          <section class="settings-section">
            <div><h3>Тема интерфейса</h3><p>Меняет текст, стеклянные поверхности и подложки для светлых или тёмных обоев.</p></div>
            <div class="theme-options" role="radiogroup" aria-label="Тема интерфейса">
              <label class="theme-choice">
                <input type="radio" name="theme" value="light" ${state.settings.theme !== "dark" ? "checked" : ""} data-focusable>
                <span class="theme-choice__preview theme-choice__preview--light"><i></i><i></i><i></i></span>
                <b>Светлая</b>
              </label>
              <label class="theme-choice">
                <input type="radio" name="theme" value="dark" ${state.settings.theme === "dark" ? "checked" : ""} data-focusable>
                <span class="theme-choice__preview theme-choice__preview--dark"><i></i><i></i><i></i></span>
                <b>Тёмная</b>
              </label>
            </div>
          </section>
          <section class="settings-section">
            <div><h3>Цвет акцента</h3><p>Используется для фокуса, активного раздела, кнопок и пиктограмм.</p></div>
            <div class="accent-options" role="radiogroup" aria-label="Цвет акцента">
              ${[
                ["plum", "Сливовый", "#956b83"],
                ["blue", "Черничный", "#647fa3"],
                ["terracotta", "Терракота", "#b56f58"],
                ["amber", "Медовый", "#a97932"],
                ["rose", "Пыльная роза", "#ad6476"],
                ["lavender", "Лавандовый", "#796fa6"]
              ].map(([value, label, color]) => `
                <label class="accent-choice" style="--swatch: ${color}">
                  <input type="radio" name="accent" value="${value}" ${state.settings.accent === value || (!state.settings.accent && value === "plum") ? "checked" : ""} data-focusable>
                  <span></span><b>${label}</b>
                </label>`).join("")}
            </div>
          </section>
          <section class="settings-section">
            <div><h3>Фоновое изображение</h3><p>Локальный JPG, PNG или WebP.</p></div>
            <div class="settings-section__controls">
              <div class="field__picker">
                <input name="backgroundPath" value="${escapeHtml(state.settings.backgroundPath)}" placeholder="Фон по умолчанию" data-focusable>
                <button type="button" class="action-button" data-action="pick-background" data-focusable>Выбрать</button>
              </div>
              <button type="button" class="text-button" data-action="clear-background" data-focusable>Сбросить фон</button>
            </div>
          </section>
          <section class="settings-section settings-section--slider">
            <div><h3>Затемнение</h3><p>Повышает читаемость текста поверх фона.</p></div>
            <label class="range-field"><input type="range" name="backgroundDim" min="20" max="85" value="${state.settings.backgroundDim}" data-focusable><output>${state.settings.backgroundDim}%</output></label>
          </section>
          <section class="settings-section settings-section--slider">
            <div><h3>Размытие</h3><p>Мягко отделяет интерфейс от изображения.</p></div>
            <label class="range-field"><input type="range" name="backgroundBlur" min="0" max="24" value="${state.settings.backgroundBlur}" data-focusable><output>${state.settings.backgroundBlur}px</output></label>
          </section>
          <section class="settings-section">
            <div><h3>Монитор</h3><p>На каком мониторе показывать GamePad UI, если подключено несколько.</p></div>
            <div class="settings-section__controls" id="display-options"><p class="muted-copy">Определяю мониторы…</p></div>
          </section>
          <section class="settings-section">
            <div><h3>Звуки интерфейса</h3><p>Короткие сигналы при перемещении по интерфейсу и нажатии на элементы.</p></div>
            <div class="settings-section__controls">
              <label class="toggle-row">
                <input type="checkbox" name="soundEnabled" ${state.settings.soundEnabled !== false ? "checked" : ""} data-focusable>
                <span class="toggle"><i></i></span>
                <span><b>Звуки навигации и нажатий</b><small>Перемещение, выбор, возврат и смена раздела</small></span>
              </label>
            </div>
          </section>
          <section class="settings-section">
            <div><h3>Папки поиска</h3><p>Поиск запускается только по запросу и просматривает вложенные папки.</p></div>
            <div class="search-paths" id="search-paths">
              ${searchPaths.length ? searchPaths.map((path) => `<div class="search-path"><span>${escapeHtml(path)}</span><button type="button" data-remove-search-path="${escapeHtml(path)}" data-focusable aria-label="Удалить папку">×</button></div>`).join("") : '<p class="muted-copy">Папки ещё не выбраны.</p>'}
              <button type="button" class="action-button" data-action="add-search-path" data-focusable>${icon("plus")} Добавить папку</button>
            </div>
          </section>
          <div class="modal-actions">
            <button type="button" class="action-button" data-action="close-modal" data-focusable>Отмена</button>
            <button type="submit" class="action-button action-button--primary" data-focusable>Сохранить</button>
          </div>
        </form>`,
      onReady: () => {
        const form = document.getElementById("settings-form");
        form.querySelectorAll('input[type="range"]').forEach((input) => {
          input.addEventListener("input", () => { input.nextElementSibling.value = `${input.value}${input.name === "backgroundBlur" ? "px" : "%"}`; });
        });
        detectDisplays().then((outcome) => {
          detectedDisplays = outcome.displays;
          const container = form.isConnected ? form.querySelector("#display-options") : null;
          if (container) container.innerHTML = displayOptionsMarkup(outcome);
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const formData = new FormData(form);
          const displayChoice = formData.get("display");
          let targetDisplay = null;
          if (displayChoice === "auto") {
            state.settings.display = null;
          } else if (displayChoice !== null && displayChoice !== "keep") {
            targetDisplay = detectedDisplays.find((display) => String(display.index) === displayChoice) || null;
            if (targetDisplay) state.settings.display = Displays.displayPreference(targetDisplay);
          }
          state.settings.theme = String(formData.get("theme") || "light");
          state.settings.accent = String(formData.get("accent") || "plum");
          state.settings.backgroundPath = String(formData.get("backgroundPath") || "").trim();
          state.settings.backgroundDim = Number(formData.get("backgroundDim"));
          state.settings.backgroundBlur = Number(formData.get("backgroundBlur"));
          state.settings.soundEnabled = formData.get("soundEnabled") === "on";
          await saveState();
          await applySettings({ refreshBackground: form.dataset.backgroundPicked === "true" });
          queueDirectorySearch();
          closeModal();
          showToast("Настройки сохранены");
          if (targetDisplay) moveWindowToDisplay(targetDisplay, { announce: true });
        });
        if (options.revealSearchPaths) {
          requestAnimationFrame(() => {
            const addSearchPath = form.querySelector('[data-action="add-search-path"]');
            Navigation.setFocus(addSearchPath);
          });
        }
      }
    });
  }

  async function requestSystemAction(action) {
    const labels = { sleep: "Перевести компьютер в спящий режим?", restart: "Перезагрузить компьютер?", shutdown: "Выключить компьютер?" };
    let confirmed = false;
    if (hasNativeApi()) {
      const answer = await globalScope.Neutralino.os.showMessageBox("Подтверждение", labels[action], "YES_NO", "QUESTION");
      confirmed = answer === "YES";
    } else {
      confirmed = globalScope.confirm(labels[action]);
    }
    if (!confirmed) return;
    const command = Platform.buildSystemCommand(action, getOsName());
    if (!command || !hasNativeApi()) {
      showToast("Системная команда недоступна в режиме предпросмотра", "info");
      return;
    }
    try {
      await globalScope.Neutralino.os.execCommand(command, { background: true });
    } catch (error) {
      showToast("Системная команда завершилась с ошибкой", "error");
      console.error(error);
    }
  }

  async function handleActionClick(action, target) {
    switch (action) {
      case "add-item": openItemForm(); break;
      case "open-system-menu": openSystemMenu(); break;
      case "toggle-apps-panel":
        if (isAppsPanelOpen()) closeAppsPanel();
        else openAppsPanel();
        break;
      case "close-apps-panel": closeAppsPanel(); break;
      case "refresh-apps": loadApps(); break;
      case "set-search-scope": await setSearchScope(target.dataset.scope); break;
      case "reveal-in-file-manager": await revealInFileManager(target.dataset.revealPath); break;
      case "toggle-explorer-sort":
        if (isExplorerSortMenuOpen()) closeExplorerSortMenu();
        else openExplorerSortMenu();
        break;
      case "set-explorer-sort": await setExplorerSort(target.dataset.sort); break;
      case "set-explorer-view": await setExplorerView(target.dataset.explorerView); break;
      case "open-pinned-folder": readExplorerDirectory(target.dataset.pinPath); break;
      case "move-pinned-folder": {
        const path = target.dataset.pinPath;
        await updatePinnedFolders(Model.movePinnedFolder(pinnedFolders(), path, target.dataset.direction, getOsName()), { path, role: target.dataset.pinRole });
        break;
      }
      case "unpin-folder":
        if (target.closest("#modal")) closeModal();
        await unpinFolderPath(target.dataset.pinPath);
        break;
      case "pin-current-folder": await pinFolderPath(explorerPath); break;
      case "pin-folder":
        closeModal();
        await pinFolderPath(target.dataset.pinPath);
        break;
      case "open-in-file-manager":
        closeModal();
        await openFileWithDefaultApp(target.dataset.managePath, target.dataset.manageName, { folder: true });
        break;
      case "open-file-default":
        closeModal();
        await openFileWithDefaultApp(target.dataset.managePath, target.dataset.manageName);
        break;
      case "rename-entry": openRenameDialog(target.dataset.managePath, target.dataset.manageName, target.dataset.manageType); break;
      case "delete-entry": openDeleteConfirm(target.dataset.managePath, target.dataset.manageName, target.dataset.manageType); break;
      case "confirm-delete-entry": await deleteEntry(target.dataset.managePath, target.dataset.manageName); break;
      case "open-folder": {
        const path = target.closest("[data-folder-action-path]").dataset.folderActionPath;
        closeModal();
        readExplorerDirectory(path);
        break;
      }
      case "exit-application": {
        if (hasNativeApi()) {
          await stopFolderSizeJob();
          await globalScope.Neutralino.app.exit();
        }
        else {
          closeSystemMenu();
          showToast("В приложении Neutralino этот пункт закроет GamePad UI", "info");
        }
        break;
      }
      case "close-modal": closeModal(); break;
      case "close-system-menu": closeSystemMenu(); break;
      case "open-settings": openSettings(); break;
      case "open-search-settings": openSettings({ revealSearchPaths: true }); break;
      case "choose-folder": {
        if (!hasNativeApi()) {
          showToast("Выбор папки доступен в приложении Neutralino", "info");
          break;
        }
        const path = await globalScope.Neutralino.os.showFolderDialog("Выберите папку", { defaultPath: explorerPath });
        if (path) readExplorerDirectory(path);
        break;
      }
      case "explorer-up":
        readExplorerParent();
        break;
      case "pick-executable": {
        const form = target.closest("form");
        const path = await chooseFile([{ name: "Приложения и ярлыки", extensions: ["exe", "lnk", "bat", "cmd", "com", "app", "AppImage", "desktop", "sh"] }, { name: "Все файлы", extensions: ["*"] }], form.elements.path.value);
        if (path) {
          form.elements.path.value = path;
          if (!form.elements.name.value) form.elements.name.value = Model.nameFromPath(path);
        }
        break;
      }
      case "pick-cover": {
        const form = target.closest("form");
        const path = await chooseFile([{ name: "Изображения", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }], form.elements.coverFilePath.value);
        if (path) {
          form.elements.coverFilePath.value = path;
          form.elements.coverPath.value = path;
          updateCoverPreview(form, path, { fresh: true });
        }
        break;
      }
      case "search-gamestory-cover": {
        const form = target.closest("form");
        const resultsElement = form.querySelector("[data-cover-search-results]");
        const query = String(form.elements.coverSearchQuery.value || form.elements.name.value || "").trim();
        if (!query) {
          showToast("Введите название игры", "error");
          break;
        }
        target.disabled = true;
        resultsElement.innerHTML = '<p class="cover-search-message">Ищу обложки…</p>';
        try {
          const results = await searchGameStoryCovers(query);
          resultsElement.innerHTML = gameStoryCoverResultsMarkup(results, form.elements.gameStoryCover.value);
        } catch (error) {
          const nativeRequired = error?.message === "native-api-required";
          resultsElement.innerHTML = `<p class="cover-search-message cover-search-message--error">${nativeRequired ? "Поиск GameStory доступен при запуске через Neutralino." : "Не удалось получить обложки. Проверьте подключение и попробуйте снова."}</p>`;
          if (!nativeRequired) console.error(error);
        } finally {
          target.disabled = false;
          Navigation.ensureFocus();
        }
        break;
      }
      case "pick-background": {
        const form = target.closest("form");
        const path = await chooseFile([{ name: "Изображения", extensions: ["jpg", "jpeg", "png", "webp"] }], form.elements.backgroundPath.value);
        if (path) {
          form.elements.backgroundPath.value = path;
          form.dataset.backgroundPicked = "true";
        }
        break;
      }
      case "clear-background": target.closest("form").elements.backgroundPath.value = ""; break;
      case "add-search-path": {
        if (!hasNativeApi()) {
          showToast("Выбор папки доступен в приложении Neutralino", "info");
          break;
        }
        const path = await globalScope.Neutralino.os.showFolderDialog("Добавить папку поиска");
        if (path && !state.settings.searchPaths.includes(path)) {
          state.settings.searchPaths.push(path);
          openSettings({ revealSearchPaths: true });
        }
        break;
      }
      case "launch-current-item": {
        const id = target.closest("[data-action-item-id]").dataset.actionItemId;
        closeModal();
        launchItem(state.library.find((item) => item.id === id));
        break;
      }
      case "open-favorite-order": {
        const id = target.closest("[data-action-item-id]").dataset.actionItemId;
        const item = state.library.find((libraryItem) => libraryItem.id === id);
        if (item) openFavoriteOrder(item);
        break;
      }
      case "move-favorite": {
        const list = target.closest("[data-order-item-id]");
        await moveFavoriteItem(list.dataset.orderItemId, target.dataset.move);
        break;
      }
      case "toggle-favorite": {
        const id = target.closest("[data-action-item-id]").dataset.actionItemId;
        const item = state.library.find((libraryItem) => libraryItem.id === id);
        if (item) item.favorite = !item.favorite;
        await saveState();
        renderLibrary();
        closeModal();
        showToast(item.favorite ? "Добавлено в избранное" : "Удалено из избранного");
        break;
      }
      case "edit-current-item": {
        const id = target.closest("[data-action-item-id]").dataset.actionItemId;
        const item = state.library.find((libraryItem) => libraryItem.id === id);
        closeModal();
        setTimeout(() => openItemForm(item), 170);
        break;
      }
      case "remove-current-item": {
        const id = target.closest("[data-action-item-id]").dataset.actionItemId;
        const item = state.library.find((libraryItem) => libraryItem.id === id);
        const confirmed = hasNativeApi()
          ? await globalScope.Neutralino.os.showMessageBox("Удаление", `Удалить «${item.name}» из библиотеки?`, "YES_NO", "QUESTION") === "YES"
          : globalScope.confirm(`Удалить «${item.name}» из библиотеки?`);
        if (confirmed) {
          state.library = state.library.filter((libraryItem) => libraryItem.id !== id);
          await saveState();
          renderLibrary();
          closeModal();
          showToast("Удалено из библиотеки");
        }
        break;
      }
      case "add-explorer-library":
      case "add-explorer-favorites": {
        const actionList = target.closest("[data-explorer-action-path]");
        await addExplorerItem(actionList.dataset.explorerActionPath, actionList.dataset.explorerActionName, action === "add-explorer-favorites");
        break;
      }
      case "launch-explorer-file": {
        const actionList = target.closest("[data-explorer-action-path]");
        closeModal();
        launchItem(Model.normalizeItem({ path: actionList.dataset.explorerActionPath, name: actionList.dataset.explorerActionName }));
        break;
      }
      default: break;
    }
  }

  function handleDocumentClick(event) {
    if (isExplorerSortMenuOpen() && !event.target.closest("#explorer-sort")) closeExplorerSortMenu({ focusButton: false });

    const appFavorite = event.target.closest("[data-app-favorite]");
    if (appFavorite) {
      toggleAppFavorite(appFavorite.dataset.appFavorite);
      return;
    }

    const appRow = event.target.closest("[data-app-path]");
    if (appRow) {
      launchApp(appRow.dataset.appPath);
      return;
    }

    const tab = event.target.closest("[data-section]");
    if (tab) {
      switchSection(tab.dataset.section);
      return;
    }

    const coverResult = event.target.closest("[data-cover-result-url]");
    if (coverResult) {
      const form = coverResult.closest("form");
      const coverUrl = coverResult.dataset.coverResultUrl;
      form.elements.gameStoryCover.value = coverUrl;
      form.elements.coverPath.value = coverUrl;
      form.querySelectorAll("[data-cover-result-url]").forEach((result) => result.classList.toggle("is-selected", result === coverResult));
      updateCoverPreview(form, coverUrl);
      return;
    }

    const gameCard = event.target.closest(".game-card[data-item-id]");
    if (gameCard) {
      selectedItemId = gameCard.dataset.itemId;
      launchItem(state.library.find((item) => item.id === selectedItemId));
      return;
    }

    const fileCard = event.target.closest("[data-entry-path]");
    if (fileCard) {
      selectedExplorerPath = fileCard.dataset.entryPath;
      if (Model.isLaunchableEntry(fileCard.dataset.entryName, fileCard.dataset.entryType, getOsName())) {
        openExplorerActions(fileCard.dataset.entryPath, fileCard.dataset.entryName, fileCard.dataset.entryType);
      } else if (fileCard.dataset.entryType === "DIRECTORY") readExplorerDirectory(fileCard.dataset.entryPath);
      else if (fileCard.closest("#library-search-results, #explorer-grid")) openFileWithDefaultApp(fileCard.dataset.entryPath, fileCard.dataset.entryName);
      else showToast("Для этого типа файла пока нет действий", "info");
      return;
    }

    const removePath = event.target.closest("[data-remove-search-path]");
    if (removePath) {
      state.settings.searchPaths = state.settings.searchPaths.filter((path) => path !== removePath.dataset.removeSearchPath);
      openSettings({ revealSearchPaths: true });
      return;
    }

    const systemCommand = event.target.closest("[data-system-command]");
    if (systemCommand) {
      requestSystemAction(systemCommand.dataset.systemCommand);
      return;
    }

    const actionTarget = event.target.closest("[data-action]");
    if (actionTarget) handleActionClick(actionTarget.dataset.action, actionTarget);
  }

  function clickSoundFor(target) {
    const element = target instanceof Element
      ? target.closest("button, a, label, input, select, textarea, [data-focusable], [data-action], .scrim")
      : null;
    if (!element) return "";
    if (element.closest("[data-section]")) return "section";
    if (element.closest('[data-action="close-modal"], [data-action="close-system-menu"], [data-action="close-apps-panel"], .scrim')) return "back";
    return "select";
  }

  function handleClickSound(event) {
    const sound = clickSoundFor(event.target);
    if (sound) Sound.play(sound);
  }

  function handleContextMenu(event) {
    const appRow = event.target.closest("[data-app-path]");
    if (appRow) {
      event.preventDefault();
      updateInputStatus("mouse");
      Sound.play("select");
      toggleAppFavorite(appRow.dataset.appPath);
      return;
    }
    const itemCard = event.target.closest(".game-card[data-item-id]");
    const fileCard = event.target.closest("[data-entry-path]");
    if (itemCard) {
      event.preventDefault();
      updateInputStatus("mouse");
      Sound.play("select");
      selectedItemId = itemCard.dataset.itemId;
      openItemActions(state.library.find((item) => item.id === selectedItemId));
    } else if (fileCard && (fileCard.closest("#explorer-grid") || Model.isLaunchableEntry(fileCard.dataset.entryName, fileCard.dataset.entryType, getOsName()))) {
      event.preventDefault();
      updateInputStatus("mouse");
      Sound.play("select");
      selectedExplorerPath = fileCard.dataset.entryPath;
      openEntryActions(fileCard);
    }
  }

  function hasOverlayOpen() {
    return !elements["modal-layer"].hidden || elements["system-panel"].classList.contains("is-open") || isAppsPanelOpen();
  }

  function handleGamepadAction(event) {
    const action = event.detail.action;
    if (action === "back") {
      if (closeExplorerSortMenu() || closeModal() || closeSystemMenu() || closeAppsPanel()) {
        Sound.play("back");
        return;
      }
      if (activeSection === "explorer") {
        if (readExplorerParent()) Sound.play("back");
      }
    } else if (action === "apps") {
      if (!elements["modal-layer"].hidden) return;
      if (isAppsPanelOpen()) {
        Sound.play("back");
        closeAppsPanel();
      } else {
        Sound.play("select");
        openAppsPanel();
      }
    } else if (action === "menu") {
      if (elements["system-panel"].classList.contains("is-open")) {
        Sound.play("back");
        closeSystemMenu();
      } else {
        Sound.play("select");
        openSystemMenu();
      }
    } else if (action === "search") {
      const closedModal = closeModal();
      const closedMenu = closeSystemMenu();
      const closedApps = closeAppsPanel();
      if (closedModal || closedMenu || closedApps || activeSection !== "search") Sound.play("section");
      switchSection("search");
    } else if (action === "previous-section") {
      if (!hasOverlayOpen()) cycleSection(-1);
    } else if (action === "next-section") {
      if (!hasOverlayOpen()) cycleSection(1);
    } else if (action === "options") {
      if (!elements["modal-layer"].hidden) return;
      const focused = document.querySelector(".is-focused");
      const appRow = focused?.closest("[data-app-path]");
      if (appRow) {
        Sound.play("select");
        toggleAppFavorite(appRow.dataset.appPath);
        return;
      }
      const itemCard = focused?.closest(".game-card[data-item-id]");
      const fileCard = focused?.closest("[data-entry-path]");
      if (itemCard) {
        Sound.play("select");
        openItemActions(state.library.find((item) => item.id === itemCard.dataset.itemId));
      } else if (fileCard && (fileCard.closest("#explorer-grid") || Model.isLaunchableEntry(fileCard.dataset.entryName, fileCard.dataset.entryType, getOsName()))) {
        Sound.play("select");
        openEntryActions(fileCard);
      }
    }
  }

  function updateClock() {
    const now = new Date();
    elements["clock-time"].textContent = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now);
    elements["clock-date"].textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(now);
  }

  function updateInputStatus(type, id) {
    const typeChanged = elements["input-status"].dataset.type !== type;
    elements["input-status"].dataset.type = type;
    const labels = { keyboard: "Клавиатура", mouse: "Мышь", gamepad: id ? id.replace(/\s*\([^)]*\)\s*/g, " ").trim() : "Геймпад" };
    elements["input-status-text"].textContent = labels[type] || "Клавиатура";
    // Перерисовываем подсказки только при смене способа ввода, иначе сбрасывается фокус на кнопке «Меню».
    if (typeChanged) renderControlHints(type);
  }

  function renderControlHints(type) {
    const hintSets = {
      keyboard: [
        { key: "↵", label: "Запустить" },
        { key: "Esc", label: "Назад", wide: true },
        { key: "X", label: "Действия" },
        { key: "Y", label: "Поиск" },
        { key: "Ctrl ␣", label: "Приложения", wide: true }
      ],
      gamepad: [
        { key: "A", label: "Запустить", tone: "a" },
        { key: "B", label: "Назад", tone: "b" },
        { key: "X", label: "Действия", tone: "x" },
        { key: "Y", label: "Поиск", tone: "y" },
        { key: icon("view"), label: "Приложения", menu: true }
      ],
      mouse: [
        { key: "ЛКМ", label: "Открыть", wide: true },
        { key: "ПКМ", label: "Действия", wide: true }
      ]
    };
    const hints = hintSets[type] || hintSets.keyboard;
    elements["control-hints"].innerHTML = `${hints.map((hint) => `
      <div class="control-hint">
        <kbd class="key ${hint.wide ? "key--wide" : ""} ${hint.menu ? "key--menu" : ""} ${hint.tone ? `key--${hint.tone}` : ""}">${hint.key}</kbd>
        <span>${hint.label}</span>
      </div>`).join("")}
      <button type="button" class="control-hint control-hint--menu" data-action="open-system-menu" data-focusable>
        <kbd class="key key--menu">${icon("menu")}</kbd><span>Меню</span>
      </button>`;
  }

  // Окно лаунчера ушло в фон (запустилась игра, открыто другое окно) или вернулось.
  function setWindowActive(active) {
    Navigation.setWindowActive(active);
    // Вернулись в лаунчер — значит, запущенная игра уже открылась или закрылась: повторный запуск снова разрешён.
    if (active) recentLaunches.clear();
  }

  function bindEvents() {
    elements["explorer-folder-sizes"].addEventListener("change", (event) => setExplorerFolderSizes(event.currentTarget.checked));
    // Enter переключает так же, как пробел и кнопка A на геймпаде.
    elements["explorer-folder-sizes"].addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.currentTarget.click();
    });
    if (hasNativeApi()) {
      globalScope.Neutralino.events.on("windowBlur", () => setWindowActive(false));
      globalScope.Neutralino.events.on("windowFocus", () => setWindowActive(true));
    } else {
      globalScope.addEventListener("blur", () => setWindowActive(false));
      globalScope.addEventListener("focus", () => setWindowActive(true));
    }
    if (hasNativeApi()) globalScope.Neutralino.events.on("spawnedProcess", handleSpawnedProcess);
    document.addEventListener("click", handleClickSound, true);
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("gamepad-action", handleGamepadAction);
    document.addEventListener("gamepad-focus", (event) => {
      if (event.detail?.source === "move") Sound.play("move");
      const itemCard = event.target.closest(".game-card[data-item-id]");
      const fileCard = event.target.closest("[data-entry-path]");
      if (itemCard) selectedItemId = itemCard.dataset.itemId;
      if (fileCard) selectedExplorerPath = fileCard.dataset.entryPath;
    });
    document.addEventListener("input-mode", (event) => updateInputStatus(event.detail.type, event.detail.id));
    document.addEventListener("gamepad-disconnected", () => updateInputStatus("keyboard"));
    elements["explorer-filter"].addEventListener("input", (event) => {
      explorerFilter = event.currentTarget.value;
      selectedExplorerPath = "";
      renderExplorer();
    });
    elements["explorer-filter"].addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !explorerFilter) return;
      event.preventDefault();
      event.stopPropagation();
      Sound.play("back");
      explorerFilter = "";
      renderExplorer();
    });
    elements["library-search-input"].addEventListener("input", queueDirectorySearch);
    elements["library-search-input"].addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !directorySearchQuery) return;
      event.preventDefault();
      event.stopPropagation();
      Sound.play("back");
      elements["library-search-input"].value = "";
      queueDirectorySearch();
    });
    elements["system-scrim"].addEventListener("click", closeSystemMenu);
    elements["apps-scrim"].addEventListener("click", closeAppsPanel);
    elements["apps-filter"].addEventListener("input", (event) => {
      appsFilter = event.currentTarget.value;
      if (appsStatus === "ready") renderAppsPanel();
    });
    elements["apps-filter"].addEventListener("keydown", (event) => {
      const firstApp = elements["apps-list"].querySelector("[data-app-path]");
      if (event.key === "ArrowDown" && firstApp) {
        event.preventDefault();
        Navigation.setFocus(firstApp);
        Sound.play("move");
      } else if (event.key === "Enter" && firstApp) {
        event.preventDefault();
        Sound.play("select");
        launchApp(firstApp.dataset.appPath);
      } else if (event.key === "Escape" && appsFilter) {
        event.preventDefault();
        event.stopPropagation();
        Sound.play("back");
        appsFilter = "";
        renderAppsPanel();
      }
    });
  }

  async function init() {
    cacheElements();
    await initializeNativeApi();
    await loadState();
    await setupAppIcons();
    const systemFolders = await resolveSystemFolders();
    if (!Array.isArray(state.settings.explorerPins)) {
      state.settings.explorerPins = systemFolders.reduce((pins, path) => Model.pinFolder(pins, path, getOsName()), []);
      await saveState();
    }
    explorerPath = pinnedFolders()[0] || homeFolderPath || await defaultExplorerPath();
    renderExplorerPins();
    renderLibrary();
    renderExplorer();
    renderDirectorySearch();
    await applySettings();
    updateClock();
    updateInputStatus("keyboard");
    setInterval(updateClock, 15_000);
    bindEvents();
    Navigation.init();
    switchSection("favorites", { focus: false });
    applySavedDisplay();
  }

  init().catch((error) => {
    console.error(error);
    document.body.innerHTML = `<div class="fatal-error"><h1>GamePad UI</h1><p>Не удалось запустить интерфейс.</p><pre>${escapeHtml(error?.message || error)}</pre></div>`;
  });
})(window);
