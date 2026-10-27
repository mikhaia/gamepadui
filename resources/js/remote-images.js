(function initRemoteImages(globalScope) {
  "use strict";

  const Platform = globalScope.GamePadPlatform || (typeof require === "function" ? require("./platform.js") : null);
  const AppIcons = globalScope.GamePadAppIcons || (typeof require === "function" ? require("./app-icons.js") : null);

  // Картинки по ссылке (обложки GameStory, SteamGridDB, «По ссылке», фон) скачиваются
  // в <кеш системы>/GamePadUI/images и дальше читаются с диска — так они видны и без интернета.
  // Имя файла — хеш ссылки, расширение — по содержимому: «a1b2….jpg».
  const CACHE_FOLDER = "GamePadUI";
  const IMAGES_FOLDER = "images";
  // Сколько ссылок скачивает один запуск процесса.
  const BATCH_SIZE = 20;
  // Процесс, который столько молчит, считается зависшим и завершается.
  const STALL_MS = 120_000;
  // Ненужные файлы удаляются не сразу после изменения библиотеки, а после паузы.
  const PRUNE_DELAY_MS = 5_000;
  const MAX_BYTES = 30 * 1024 * 1024;
  const USER_AGENT = "Mozilla/5.0 (compatible; GamePadUI)";
  const CACHE_FILE_PATTERN = /^([0-9a-f]{16})\.(png|jpg|gif|webp|avif|bmp|svg)$/;
  const PART_FILE_PATTERN = /^([0-9a-f]{16})\.part$/;

  // Ссылка в том виде, в котором её получит curl/PowerShell: пробелы и не-ASCII закодированы,
  // поэтому её можно передать одной строкой stdin. "" — не http(s)-ссылка.
  function downloadUrl(path) {
    const value = String(path || "").trim();
    if (!/^https?:\/\//i.test(value) || /[\r\n\0]/.test(value)) return "";
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && url.hostname ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function isDownloadable(path) {
    return Boolean(downloadUrl(path));
  }

  function cacheKey(path) {
    return AppIcons.hashText(String(path || "").trim());
  }

  function imagesDirectory(baseCachePath, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    return [String(baseCachePath || "").replace(/[\\/]+$/, ""), CACHE_FOLDER, IMAGES_FOLDER].join(separator);
  }

  function ascii(bytes, from, to) {
    return String.fromCharCode(...bytes.slice(from, to));
  }

  // Тип картинки по первым байтам файла; "" — это не картинка (например, HTML-страница с ошибкой).
  function sniffImageType(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((value, index) => bytes[index] === value)) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (ascii(bytes, 0, 4) === "GIF8") return "gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
    if (ascii(bytes, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(bytes, 8, 12))) return "avif";
    if (ascii(bytes, 0, 2) === "BM" && bytes.length >= 26) return "bmp";
    const text = ascii(bytes, 0, Math.min(bytes.length, 512)).replace(/^\xEF\xBB\xBF/, "").trimStart().toLowerCase();
    if (text.startsWith("<") && text.includes("<svg") && !text.includes("<html")) return "svg";
    return "";
  }

  // Содержимое папки кеша: готовые файлы по хешу и недокачанные «.part» от прошлых запусков.
  function readListing(entries) {
    const files = new Map();
    const leftovers = [];
    (entries || []).forEach((item) => {
      if (item?.type && item.type !== "FILE") return;
      const name = String(item?.entry || "");
      const match = CACHE_FILE_PATTERN.exec(name);
      if (match && !files.has(match[1])) files.set(match[1], name);
      else if (match || PART_FILE_PATTERN.test(name)) leftovers.push(name);
    });
    return { files, leftovers };
  }

  // Процесс читает из stdin строки «хеш ссылка», качает каждую в «хеш.part»
  // и отвечает строкой «ok хеш» или «fail хеш причина». Проверку и переименование делает приложение.
  const WINDOWS_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$dir = __DIR__
$ua = __UA__
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
try { [IO.Directory]::CreateDirectory($dir) | Out-Null } catch { exit 1 }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Trim().Split(' ', 2)
  if ($parts.Length -ne 2 -or $parts[0] -cnotmatch '^[0-9a-f]{16}$') { continue }
  $hash = $parts[0]
  $part = [IO.Path]::Combine($dir, $hash + '.part')
  $response = $null
  try {
    $request = [Net.WebRequest]::Create($parts[1])
    $request.UserAgent = $ua
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 60000
    $response = $request.GetResponse()
    $source = $response.GetResponseStream()
    $target = [IO.File]::Create($part)
    try { $source.CopyTo($target) } finally { $target.Dispose(); $source.Dispose() }
    [Console]::Out.WriteLine('ok ' + $hash)
  } catch {
    try { [IO.File]::Delete($part) } catch {}
    [Console]::Out.WriteLine('fail ' + $hash + ' ' + ($_.Exception.Message -replace '\s+', ' '))
  } finally {
    if ($response) { $response.Dispose() }
  }
  [Console]::Out.Flush()
}
`;

  function unixCommand(directory) {
    const curl = `curl -fsSL --connect-timeout 15 --max-time 90 --max-filesize ${MAX_BYTES} -A "$ua" -o "$part" "$url"`;
    const wget = 'wget -q -T 60 -U "$ua" -O "$part" "$url"';
    return [
      `dir=${Platform.shellQuote(directory)}`,
      `ua=${Platform.shellQuote(USER_AGENT)}`,
      'mkdir -p "$dir" || exit 1',
      `if command -v curl >/dev/null 2>&1; then fetch() { ${curl}; }; else fetch() { ${wget}; }; fi`,
      "while IFS=' ' read -r hash url; do " +
        "case \"$hash\" in ''|*[!0-9a-f]*) continue;; esac; " +
        'part="$dir/$hash.part"; ' +
        'if fetch </dev/null >/dev/null 2>&1; then echo "ok $hash"; ' +
        'else code=$?; rm -f "$part"; echo "fail $hash exit $code"; fi; ' +
        "done"
    ].join("; ");
  }

  function windowsScript(directory) {
    return WINDOWS_SCRIPT
      .replace("__DIR__", () => Platform.powerShellLiteral(directory))
      .replace("__UA__", () => Platform.powerShellLiteral(USER_AGENT));
  }

  function buildDownloader(osName, directory) {
    if (!directory) return null;
    if (osName === "Windows") {
      return { command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Platform.encodePowerShell(windowsScript(directory))}` };
    }
    if (osName === "Darwin" || osName === "Linux" || osName === "FreeBSD") return { command: unixCommand(directory) };
    return null;
  }

  function encodeJob(hash, path) {
    return `${hash} ${downloadUrl(path)}\n`;
  }

  // Хранилище: какие ссылки уже лежат на диске, докачка недостающих и уборка ненужных файлов.
  //   directory                 — папка кеша (imagesDirectory(...));
  //   list(dir)                 → Promise<[{entry, type}]> (readDirectory);
  //   readHead(file)            → Promise<Uint8Array> первые байты файла;
  //   move(from, to), remove(file);
  //   spawn(command, onEvent)   → Promise<{id}>; write(id, text), end(id), kill(id) — stdin и остановка;
  //   onReady(url, file)        — картинка по ссылке скачана.
  function createRemoteImageStore(options) {
    const {
      osName, directory, list, readHead, move, remove, spawn, write, end, kill,
      onReady = () => {}, warn = () => {}, setTimer = setTimeout, clearTimer = clearTimeout
    } = options;
    const separator = osName === "Windows" ? "\\" : "/";
    const files = new Map();
    const urls = new Map();
    const failed = new Set();
    const running = new Set();
    let queue = [];
    let wanted = new Set();
    let leftovers = [];
    let worker = null;
    let broken = !buildDownloader(osName, directory);
    let loaded = false;
    let pruneTimer = 0;

    const fullPath = (name) => `${directory}${separator}${name}`;

    async function load() {
      try {
        const listing = readListing(await list(directory));
        listing.files.forEach((name, hash) => files.set(hash, name));
        leftovers = listing.leftovers;
      } catch (error) {
        // Папки ещё нет — кеш пуст.
      }
      loaded = true;
      pump();
      schedulePrune();
    }

    function localPath(url) {
      if (!isDownloadable(url)) return "";
      const name = files.get(cacheKey(url));
      return name ? fullPath(name) : "";
    }

    function status(url) {
      if (!isDownloadable(url)) return "none";
      const hash = cacheKey(url);
      if (files.has(hash)) return "ready";
      if (running.has(hash)) return "downloading";
      if (queue.includes(hash)) return "queued";
      if (failed.has(hash)) return "failed";
      return "none";
    }

    // Файл кеша не прочитался (удалили вручную) — забываем его и при необходимости качаем заново.
    function forget(url) {
      const hash = cacheKey(url);
      if (!files.delete(hash)) return;
      if (!broken && wanted.has(hash) && !queue.includes(hash) && !running.has(hash)) {
        queue.push(hash);
        pump();
      }
    }

    // paths — все картинки, которые сейчас используются; недостающие ставятся в очередь.
    function sync(paths) {
      wanted = new Set();
      [...(paths || [])].forEach((path) => {
        if (!isDownloadable(path)) return;
        const hash = cacheKey(path);
        wanted.add(hash);
        if (!urls.has(hash)) urls.set(hash, String(path).trim());
        if (!broken && !files.has(hash) && !failed.has(hash) && !running.has(hash) && !queue.includes(hash)) queue.push(hash);
      });
      pump();
      schedulePrune();
    }

    function pump() {
      if (worker || broken || !loaded) return;
      queue = queue.filter((hash) => wanted.has(hash) && !files.has(hash));
      if (!queue.length) return;
      start(queue.splice(0, BATCH_SIZE));
    }

    function start(batch) {
      const spec = buildDownloader(osName, directory);
      const current = { id: null, batch: new Set(batch), answered: 0, rest: "", timer: 0, chain: Promise.resolve() };
      worker = current;
      batch.forEach((hash) => running.add(hash));
      Promise.resolve(spawn(spec.command, (detail) => handleEvent(current, detail)))
        .then(async (process) => {
          current.id = process.id;
          if (worker !== current) return;
          watch(current);
          await write(process.id, batch.map((hash) => encodeJob(hash, urls.get(hash))).join(""));
          await end(process.id);
        })
        .catch((error) => {
          if (worker !== current) return;
          warn("Unable to start the image downloader", error);
          broken = true;
          finish(current);
        });
    }

    function watch(current) {
      clearTimer(current.timer);
      current.timer = setTimer(() => {
        if (worker !== current) return;
        warn("Image downloader stalled, stopping it");
        Promise.resolve(kill(current.id)).catch(() => {});
        finish(current);
      }, STALL_MS);
    }

    function handleEvent(current, detail) {
      if (detail.action === "stdOut") {
        if (worker === current && current.id !== null) watch(current);
        const lines = (current.rest + String(detail.data || "")).split(/\r?\n/);
        current.rest = lines.pop();
        lines.forEach((line) => handleLine(current, line));
      } else if (detail.action === "stdErr") {
        warn("Image downloader:", String(detail.data || "").trim());
      } else if (detail.action === "exit") {
        if (current.rest) handleLine(current, current.rest);
        current.rest = "";
        current.chain = current.chain.then(() => {
          // Упал, не ответив ни разу (нет curl, нельзя создать папку…) — больше не пытаемся в этом сеансе.
          if (!current.answered && Number(detail.data) !== 0 && worker === current) {
            warn("Image downloader exited without answering", detail.data);
            broken = true;
          }
          finish(current);
        });
      }
    }

    function handleLine(current, line) {
      const match = /^(ok|fail) ([0-9a-f]{16})(?: (.*))?$/.exec(String(line).trim());
      if (!match || !current.batch.has(match[2])) return;
      current.answered += 1;
      const [, result, hash, message] = match;
      current.chain = current.chain.then(() => (result === "ok" ? accept(hash) : reject(hash, message)));
    }

    async function accept(hash) {
      const part = fullPath(`${hash}.part`);
      const extension = sniffImageType(await Promise.resolve().then(() => readHead(part)).catch(() => null));
      if (!extension) {
        await Promise.resolve().then(() => remove(part)).catch(() => {});
        reject(hash, "the link does not lead to an image");
        return;
      }
      const name = `${hash}.${extension}`;
      try {
        await move(part, fullPath(name));
      } catch (error) {
        await Promise.resolve().then(() => remove(part)).catch(() => {});
        reject(hash, error?.message || String(error));
        return;
      }
      running.delete(hash);
      files.set(hash, name);
      onReady(urls.get(hash), fullPath(name));
    }

    function reject(hash, message) {
      running.delete(hash);
      failed.add(hash);
      warn(`Unable to download ${urls.get(hash)}:`, message || "");
    }

    function finish(current) {
      if (worker !== current) return;
      clearTimer(current.timer);
      worker = null;
      current.batch.forEach((hash) => {
        if (running.has(hash)) reject(hash, "no answer from the downloader");
      });
      if (broken) queue = [];
      else pump();
    }

    function schedulePrune() {
      clearTimer(pruneTimer);
      pruneTimer = setTimer(() => {
        prune().catch((error) => warn("Unable to clean the image cache", error));
      }, PRUNE_DELAY_MS);
    }

    // Удаляет файлы ссылок, которые больше нигде не используются, и недокачанные остатки.
    async function prune() {
      // Ни одной картинки по ссылке — возможно, библиотека не прочиталась; кеш не трогаем.
      if (!loaded || !wanted.size) return;
      const names = leftovers.filter((name) => !running.has(name.slice(0, 16)));
      leftovers = [];
      files.forEach((name, hash) => {
        if (wanted.has(hash)) return;
        names.push(name);
        files.delete(hash);
      });
      await Promise.all(names.map((name) => Promise.resolve()
        .then(() => remove(fullPath(name)))
        .catch((error) => warn(`Unable to remove ${name}`, error))));
    }

    return {
      load,
      sync,
      localPath,
      forget,
      status,
      prune,
      get directory() {
        return directory;
      },
      get pending() {
        return queue.length + running.size;
      }
    };
  }

  const api = {
    BATCH_SIZE,
    STALL_MS,
    PRUNE_DELAY_MS,
    buildDownloader,
    cacheKey,
    createRemoteImageStore,
    downloadUrl,
    encodeJob,
    imagesDirectory,
    isDownloadable,
    readListing,
    sniffImageType,
    windowsScript
  };

  globalScope.GamePadRemoteImages = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
