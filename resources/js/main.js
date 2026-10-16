(function initApplication(globalScope) {
  "use strict";

  const Model = globalScope.GamePadModel;
  const DirectorySearch = globalScope.GamePadSearch;
  const Platform = globalScope.GamePadPlatform;
  const Navigation = globalScope.GamePadNavigation;
  const STORAGE_KEY = "gamepad-ui-state-v1";
  const DEFAULT_STATE = {
    library: [],
    settings: {
      theme: "light",
      accent: "plum",
      backgroundPath: "",
      backgroundDim: 58,
      backgroundBlur: 0,
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
  let blobUrls = [];

  const elements = {};

  function cacheElements() {
    [
      "background-image", "background-wash", "clock-time", "clock-date", "input-status",
      "input-status-text", "favorites-grid", "library-grid", "explorer-grid", "explorer-path", "explorer-filter",
      "explorer-count", "library-search-input", "library-search-scope", "library-search-summary",
      "library-search-results", "section-tabs", "system-panel", "system-scrim", "modal-layer", "modal",
      "modal-title", "modal-eyebrow", "modal-body", "toast", "control-hints"
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
      globalScope.Neutralino.events.on("windowClose", () => globalScope.Neutralino.app.exit());
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
        settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) }
      };
    } catch (error) {
      if (error?.code !== "NE_ST_NOSTKEX") console.warn("Unable to load state", error);
    }
  }

  async function saveState() {
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

  function revokeBlobUrls() {
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
    blobUrls = [];
  }

  async function localImageUrl(path) {
    if (!path) return "";
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    if (!hasNativeApi()) return "";
    try {
      const buffer = await globalScope.Neutralino.filesystem.readBinaryFile(path);
      const extension = Model.extensionOf(path);
      const blob = new Blob([buffer], { type: IMAGE_MIME_TYPES[extension] || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      blobUrls.push(url);
      return url;
    } catch (error) {
      console.warn(`Unable to read image: ${path}`, error);
      return "";
    }
  }

  function coverValueForSource(form, source) {
    if (source === "file") return String(form.elements.coverFilePath?.value || "").trim();
    if (source === "url") return String(form.elements.coverUrl?.value || "").trim();
    if (source === "gamestory") return String(form.elements.gameStoryCover?.value || "").trim();
    return "";
  }

  async function updateCoverPreview(form, path) {
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

    const imageUrl = await localImageUrl(normalizedPath);
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

  async function applySettings() {
    document.body.dataset.theme = state.settings.theme || "light";
    document.body.dataset.accent = state.settings.accent || "plum";
    elements["background-wash"].style.setProperty("--background-dim", state.settings.backgroundDim / 100);
    elements["background-image"].style.setProperty("--background-blur", `${state.settings.backgroundBlur}px`);
    const backgroundUrl = await localImageUrl(state.settings.backgroundPath);
    elements["background-image"].style.backgroundImage = backgroundUrl ? `url("${backgroundUrl}")` : "";
    document.body.classList.toggle("has-custom-background", Boolean(backgroundUrl));
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
    return `
      <button class="game-card color-${colorIndex(item.id)}${selected}" data-item-id="${escapeHtml(item.id)}" data-focusable>
        <span class="game-card__art">
          <span class="game-card__initials">${escapeHtml(initials(item.name))}</span>
          ${item.coverPath ? `<img data-cover-path="${escapeHtml(item.coverPath)}" alt="">` : ""}
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
    const images = [...root.querySelectorAll("img[data-cover-path]")];
    await Promise.all(images.map(async (image) => {
      const url = await localImageUrl(image.dataset.coverPath);
      if (url) {
        image.src = url;
        image.classList.add("is-loaded");
      }
    }));
  }

  function renderLibrary() {
    revokeBlobUrls();
    const favorites = state.library.filter((item) => item.favorite);
    elements["favorites-grid"].innerHTML = favorites.length
      ? favorites.map(itemCardMarkup).join("")
      : emptyStateMarkup("favorites");
    elements["library-grid"].innerHTML = state.library.length
      ? state.library.map(itemCardMarkup).join("")
      : emptyStateMarkup("library");
    hydrateCoverImages(elements["favorites-grid"]);
    hydrateCoverImages(elements["library-grid"]);
    applySettings();
    if (elements["library-search-results"]) renderDirectorySearch();
  }

  function fileEntryMarkup(item) {
    const path = Model.joinPath(explorerPath, item.entry, getOsName());
    const applicationBundle = Model.isApplicationBundle(item.entry, item.type, getOsName());
    const directory = item.type === "DIRECTORY" && !applicationBundle;
    const launchable = Model.isLaunchableEntry(item.entry, item.type, getOsName());
    const selected = selectedExplorerPath === path ? " is-selected" : "";
    const extension = Model.extensionOf(item.entry).toUpperCase();
    const typeLabel = directory ? "Папка" : applicationBundle ? "Приложение" : extension || "Файл";
    return `
      <button class="file-card${selected}" title="${escapeHtml(item.entry)}" data-entry-name="${escapeHtml(item.entry)}" data-entry-type="${item.type}" data-entry-path="${escapeHtml(path)}" data-focusable>
        <span class="file-card__visual ${directory ? "is-folder" : "is-file"}${applicationBundle ? " is-application" : ""}" aria-hidden="true">
          ${icon(directory ? "folder" : "file")}
        </span>
        <span class="file-card__info">
          <span class="file-card__name">${escapeHtml(item.entry)}</span>
          <span class="file-card__detail">${escapeHtml(typeLabel)}${launchable ? '<span class="file-card__detail-separator" aria-hidden="true">·</span>Можно добавить' : ""}</span>
        </span>
      </button>`;
  }

  function renderExplorer() {
    const visibleEntries = explorerEntries.filter((entry) => Model.matchesEntrySearch(entry, explorerFilter));
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
  }

  function pluralize(number, forms) {
    const mod10 = number % 10;
    const mod100 = number % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
    return forms[2];
  }

  async function readExplorerDirectory(path) {
    if (!path) return;
    explorerPath = path;
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
        explorerEntries = Model.sortEntries(await globalScope.Neutralino.filesystem.readDirectory(path), getOsName());
      }
      renderExplorer();
      requestAnimationFrame(() => Navigation.ensureFocus());
    } catch (error) {
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
    return `
      <button class="file-card search-result-card${selected}" data-entry-name="${escapeHtml(result.name)}" data-entry-type="${result.type}" data-entry-path="${escapeHtml(result.path)}" data-focusable>
        <span class="file-card__visual is-file${applicationBundle ? " is-application" : ""}">
          <span class="file-card__type">${escapeHtml(extension.slice(0, 5))}</span>
          <span class="file-card__corner">${applicationBundle ? "ПРИЛОЖЕНИЕ" : escapeHtml(extension)}</span>
        </span>
        <span class="file-card__name">${escapeHtml(Model.nameFromPath(result.name))}</span>
        <span class="search-result-card__path" title="${escapeHtml(result.path)}">${escapeHtml(result.path)}</span>
        <span class="file-card__badge">${existing ? "Уже в библиотеке" : "Можно добавить"}</span>
      </button>`;
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

  function renderDirectorySearch() {
    const searchPaths = Array.isArray(state.settings.searchPaths) ? state.settings.searchPaths.filter(Boolean) : [];
    const pathCount = searchPaths.length;
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
      : directorySearchPlaceholder("search", "Ничего не найдено", "Попробуйте другое слово или добавьте ещё одну папку поиска.");
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
    if (section === "explorer" && !explorerEntries.length && explorerPath) readExplorerDirectory(explorerPath);
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
    switchSection(target);
  }

  function showToast(message, type = "success") {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast is-visible toast--${type}`;
    toastTimer = setTimeout(() => { elements.toast.classList.remove("is-visible"); }, 3200);
  }

  function openModal({ title, eyebrow = "GAMEPAD UI", body, wide = false, onReady }) {
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
      Navigation.ensureFocus();
    }, 160);
    return true;
  }

  function openSystemMenu() {
    if (elements["system-panel"].classList.contains("is-open")) return;
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
    requestAnimationFrame(() => Navigation.ensureFocus());
    return true;
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
          <span>Исполняемый файл, ярлык или приложение .app</span>
          <div class="field__picker">
            <input name="path" value="${escapeHtml(item.path || "")}" placeholder="C:\\Games\\Game.exe" autocomplete="off" data-focusable required>
            <button type="button" class="action-button" data-action="pick-executable" data-focusable>Обзор</button>
          </div>
        </label>
        <label class="field field--wide">
          <span>Аргументы запуска <small>необязательно</small></span>
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
    if (!hasNativeApi()) {
      showToast(`Предпросмотр запуска: ${item.name}`, "info");
      return;
    }
    try {
      const command = Platform.buildLaunchCommand(item, getOsName());
      await globalScope.Neutralino.os.execCommand(command, { background: true });
      showToast(`Запускаю: ${item.name}`);
    } catch (error) {
      showToast("Не удалось запустить приложение", "error");
      console.error(error);
    }
  }

  function openItemActions(item) {
    if (!item) return;
    openModal({
      title: item.name,
      eyebrow: "ДЕЙСТВИЯ",
      body: `
        <div class="action-list" data-action-item-id="${escapeHtml(item.id)}">
          <button class="action-list__item" data-action="launch-current-item" data-focusable><span>${icon("play")}</span><b>Запустить</b><i>Enter</i></button>
          <button class="action-list__item" data-action="toggle-favorite" data-focusable><span>${icon("star")}</span><b>${item.favorite ? "Убрать из избранного" : "Добавить в избранное"}</b><i>X</i></button>
          <button class="action-list__item" data-action="edit-current-item" data-focusable><span>${icon("edit")}</span><b>Изменить</b><i>${icon("chevron")}</i></button>
          <button class="action-list__item action-list__item--danger" data-action="remove-current-item" data-focusable><span>${icon("trash")}</span><b>Удалить из библиотеки</b><i>${icon("chevron")}</i></button>
        </div>`
    });
  }

  function explorerActionsMarkup(path, name) {
    const existing = state.library.find((item) => item.path === path);
    return `
      <div class="action-list" data-explorer-action-path="${escapeHtml(path)}" data-explorer-action-name="${escapeHtml(name)}">
        ${existing ? '<p class="inline-notice">Этот файл уже есть в библиотеке.</p>' : ""}
        <button class="action-list__item" data-action="add-explorer-library" data-focusable ${existing ? "disabled" : ""}><span>${icon("plus")}</span><b>Добавить в библиотеку</b><i>${icon("chevron")}</i></button>
        <button class="action-list__item" data-action="add-explorer-favorites" data-focusable ${existing ? "disabled" : ""}><span>${icon("star")}</span><b>Добавить в избранное</b><i>${icon("chevron")}</i></button>
        <button class="action-list__item" data-action="launch-explorer-file" data-focusable><span>${icon("play")}</span><b>Запустить сейчас</b><i>Enter</i></button>
      </div>`;
  }

  function openExplorerActions(path, name, entryType = "FILE") {
    const applicationBundle = Model.isApplicationBundle(name, entryType, getOsName());
    openModal({ title: name, eyebrow: applicationBundle ? "ПРИЛОЖЕНИЕ" : "ФАЙЛ", body: explorerActionsMarkup(path, name) });
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
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const formData = new FormData(form);
          state.settings.theme = String(formData.get("theme") || "light");
          state.settings.accent = String(formData.get("accent") || "plum");
          state.settings.backgroundPath = String(formData.get("backgroundPath") || "").trim();
          state.settings.backgroundDim = Number(formData.get("backgroundDim"));
          state.settings.backgroundBlur = Number(formData.get("backgroundBlur"));
          await saveState();
          await applySettings();
          queueDirectorySearch();
          closeModal();
          showToast("Настройки сохранены");
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
      case "exit-application": {
        if (hasNativeApi()) await globalScope.Neutralino.app.exit();
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
      case "explorer-up": {
        const parent = Model.parentPath(explorerPath, getOsName());
        if (parent && parent !== explorerPath) readExplorerDirectory(parent);
        break;
      }
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
          updateCoverPreview(form, path);
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
        if (path) form.elements.backgroundPath.value = path;
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

  function handleContextMenu(event) {
    const itemCard = event.target.closest(".game-card[data-item-id]");
    const fileCard = event.target.closest("[data-entry-path]");
    if (itemCard) {
      event.preventDefault();
      updateInputStatus("mouse");
      selectedItemId = itemCard.dataset.itemId;
      openItemActions(state.library.find((item) => item.id === selectedItemId));
    } else if (fileCard && Model.isLaunchableEntry(fileCard.dataset.entryName, fileCard.dataset.entryType, getOsName())) {
      event.preventDefault();
      updateInputStatus("mouse");
      selectedExplorerPath = fileCard.dataset.entryPath;
      openExplorerActions(fileCard.dataset.entryPath, fileCard.dataset.entryName, fileCard.dataset.entryType);
    }
  }

  function handleGamepadAction(event) {
    const action = event.detail.action;
    if (action === "back") {
      if (closeModal() || closeSystemMenu()) return;
      if (activeSection === "explorer") {
        const parent = Model.parentPath(explorerPath, getOsName());
        if (parent && parent !== explorerPath) readExplorerDirectory(parent);
      }
    } else if (action === "menu") {
      if (elements["system-panel"].classList.contains("is-open")) closeSystemMenu();
      else openSystemMenu();
    } else if (action === "search") {
      closeModal();
      closeSystemMenu();
      switchSection("search");
    } else if (action === "previous-section") {
      if (elements["modal-layer"].hidden && !elements["system-panel"].classList.contains("is-open")) cycleSection(-1);
    } else if (action === "next-section") {
      if (elements["modal-layer"].hidden && !elements["system-panel"].classList.contains("is-open")) cycleSection(1);
    } else if (action === "options") {
      if (!elements["modal-layer"].hidden) return;
      const focused = document.querySelector(".is-focused");
      const itemCard = focused?.closest(".game-card[data-item-id]");
      const fileCard = focused?.closest("[data-entry-path]");
      if (itemCard) openItemActions(state.library.find((item) => item.id === itemCard.dataset.itemId));
      else if (fileCard && Model.isLaunchableEntry(fileCard.dataset.entryName, fileCard.dataset.entryType, getOsName())) {
        openExplorerActions(fileCard.dataset.entryPath, fileCard.dataset.entryName, fileCard.dataset.entryType);
      }
    }
  }

  function updateClock() {
    const now = new Date();
    elements["clock-time"].textContent = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now);
    elements["clock-date"].textContent = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(now);
  }

  function updateInputStatus(type, id) {
    elements["input-status"].dataset.type = type;
    const labels = { keyboard: "Клавиатура", mouse: "Мышь", gamepad: id ? id.replace(/\s*\([^)]*\)\s*/g, " ").trim() : "Геймпад" };
    elements["input-status-text"].textContent = labels[type] || "Клавиатура";
    renderControlHints(type);
  }

  function renderControlHints(type) {
    const hintSets = {
      keyboard: [
        { key: "↵", label: "Запустить" },
        { key: "Esc", label: "Назад", wide: true },
        { key: "X", label: "Действия" },
        { key: "Y", label: "Поиск" }
      ],
      gamepad: [
        { key: "A", label: "Запустить", tone: "a" },
        { key: "B", label: "Назад", tone: "b" },
        { key: "X", label: "Действия", tone: "x" },
        { key: "Y", label: "Поиск", tone: "y" }
      ],
      mouse: [
        { key: "ЛКМ", label: "Открыть", wide: true },
        { key: "ПКМ", label: "Действия", wide: true }
      ]
    };
    const hints = hintSets[type] || hintSets.keyboard;
    elements["control-hints"].innerHTML = `${hints.map((hint) => `
      <div class="control-hint">
        <kbd class="key ${hint.wide ? "key--wide" : ""} ${hint.tone ? `key--${hint.tone}` : ""}">${hint.key}</kbd>
        <span>${hint.label}</span>
      </div>`).join("")}
      <button type="button" class="control-hint control-hint--menu" data-action="open-system-menu" data-focusable>
        <kbd class="key key--menu">${icon("menu")}</kbd><span>Меню</span>
      </button>`;
  }

  function bindEvents() {
    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("gamepad-action", handleGamepadAction);
    document.addEventListener("gamepad-focus", (event) => {
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
      explorerFilter = "";
      renderExplorer();
    });
    elements["library-search-input"].addEventListener("input", queueDirectorySearch);
    elements["library-search-input"].addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !directorySearchQuery) return;
      event.preventDefault();
      event.stopPropagation();
      elements["library-search-input"].value = "";
      queueDirectorySearch();
    });
    elements["system-scrim"].addEventListener("click", closeSystemMenu);
  }

  async function init() {
    cacheElements();
    await initializeNativeApi();
    await loadState();
    explorerPath = await defaultExplorerPath();
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
  }

  init().catch((error) => {
    console.error(error);
    document.body.innerHTML = `<div class="fatal-error"><h1>GamePad UI</h1><p>Не удалось запустить интерфейс.</p><pre>${escapeHtml(error?.message || error)}</pre></div>`;
  });
})(window);
