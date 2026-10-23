(function initAppIcons(globalScope) {
  "use strict";

  const Platform = globalScope.GamePadPlatform || (typeof require === "function" ? require("./platform.js") : null);

  // Значки рисуются 128×128 px: самое крупное место — 64 px в плитках библиотеки, на Retina/HiDPI это ×2.
  const ICON_PIXELS = 128;
  const CACHE_FOLDER = "GamePadUI";
  const CACHE_VERSION = "icons-v2";
  const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Файл нулевой длины означает «значок извлечь не удалось» — повторяем попытку через сутки.
  const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
  // Процесс извлечения живёт, пока есть работа, и завершается после паузы.
  const IDLE_MS = 20_000;
  const ICON_EXTENSIONS = {
    Windows: ["exe", "lnk", "url"],
    Darwin: ["app"]
  };

  // Windows: Shell-интерфейс IShellItemImageFactory — тот же значок, что в Проводнике
  // (exe, ярлыки .lnk и .url из Steam, без стрелки ярлыка), с прозрачностью. Если компиляция
  // запрещена политикой, берём ExtractAssociatedIcon (32 px).
  const WINDOWS_EXTRACTOR = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class GamePadIconExtractor
{
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize { public int Width; public int Height; }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(NativeSize size, int flags, out IntPtr bitmap);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory factory);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr handle);

    private const int IconOnly = 0x4;

    public static void Save(string path, string output, int size)
    {
        IShellItemImageFactory factory;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
        IntPtr handle = IntPtr.Zero;
        try
        {
            NativeSize requested;
            requested.Width = size;
            requested.Height = size;
            int result = factory.GetImage(requested, IconOnly, out handle);
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            using (Bitmap bitmap = ToBitmap(handle))
            {
                bitmap.Save(output, ImageFormat.Png);
            }
        }
        finally
        {
            if (handle != IntPtr.Zero) DeleteObject(handle);
            Marshal.ReleaseComObject(factory);
        }
    }

    // Image.FromHbitmap отбрасывает альфа-канал, хотя байты прозрачности на месте, — переносим их сами.
    private static Bitmap ToBitmap(IntPtr handle)
    {
        using (Bitmap source = Image.FromHbitmap(handle))
        {
            if (Image.GetPixelFormatSize(source.PixelFormat) < 32) return new Bitmap(source);
            Rectangle area = new Rectangle(0, 0, source.Width, source.Height);
            BitmapData data = source.LockBits(area, ImageLockMode.ReadOnly, source.PixelFormat);
            int stride = data.Stride;
            byte[] pixels = new byte[stride * source.Height];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
            source.UnlockBits(data);

            bool hasAlpha = false;
            for (int index = 3; index < pixels.Length; index += 4)
            {
                if (pixels[index] != 0) { hasAlpha = true; break; }
            }
            if (!hasAlpha) return new Bitmap(source);

            Bitmap result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            BitmapData target = result.LockBits(area, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int rowBytes = Math.Min(stride, target.Stride);
            for (int row = 0; row < source.Height; row++)
            {
                Marshal.Copy(pixels, row * stride, new IntPtr(target.Scan0.ToInt64() + (long)row * target.Stride), rowBytes);
            }
            result.UnlockBits(target);
            return result;
        }
    }
}
`;

  // Запросы приходят строками «id base64(путь) base64(файл.png)» через stdin, ответы — JSON-строки.
  // Сам скрипт тоже приходит первой строкой stdin: в командную строку cmd.exe (8191 символ) он не помещается.
  const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$size = __SIZE__
$utf8 = New-Object System.Text.UTF8Encoding $false
$native = $true
try {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $extractorSource
} catch {
  $native = $false
  try { Add-Type -AssemblyName System.Drawing } catch {}
  [Console]::Out.WriteLine('{"warning":' + ($_.Exception.Message | ConvertTo-Json -Compress) + '}')
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -ne 3 -or $parts[0] -notmatch '^\d+$') { continue }
  $id = $parts[0]
  $output = $null
  try {
    $path = $utf8.GetString([Convert]::FromBase64String($parts[1]))
    $output = $utf8.GetString([Convert]::FromBase64String($parts[2]))
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($output))
    if ($native) {
      [GamePadIconExtractor]::Save($path, $output, $size)
    } else {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
      $bitmap = $icon.ToBitmap()
      $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      $icon.Dispose()
    }
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true}')
  } catch {
    if ($output) { try { [System.IO.File]::WriteAllBytes($output, [byte[]]@()) } catch {} }
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"error":' + ($_.Exception.Message | ConvertTo-Json -Compress) + '}')
  }
  [Console]::Out.Flush()
}
`;

  // Короткий загрузчик: читает основной скрипт (base64 UTF-8) из первой строки stdin и выполняет его.
  const WINDOWS_BOOTSTRAP = "$s=[Console]::In.ReadLine();& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))))";

  // macOS: NSWorkspace.iconForFile — тот же значок, что в Finder и Dock (в том числе из Assets.car).
  const MAC_SCRIPT = String.raw`
ObjC.import("AppKit");
var SIZE = __SIZE__;
var input = $.NSFileHandle.fileHandleWithStandardInput;
var output = $.NSFileHandle.fileHandleWithStandardOutput;
var manager = $.NSFileManager.defaultManager;
var workspace = $.NSWorkspace.sharedWorkspace;
var noOptions = $.NSDictionary.dictionary;

function emit(value) {
  output.writeData($(JSON.stringify(value) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}

function decode(value) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions(value, 0);
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}

function drawPng(image) {
  var bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, SIZE, SIZE, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  var context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, SIZE, SIZE), $.NSMakeRect(0, 0, 0, 0), 2, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return bitmap.representationUsingTypeProperties(4, noOptions);
}

function tiffPng(image) {
  image.setSize($.NSMakeSize(SIZE, SIZE));
  var bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  return bitmap.representationUsingTypeProperties(4, noOptions);
}

function handle(line) {
  var parts = line.split(" ");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0])) return;
  var id = Number(parts[0]);
  var target = "";
  try {
    var path = decode(parts[1]);
    target = decode(parts[2]);
    manager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(target).stringByDeletingLastPathComponent, true, noOptions, null);
    var image = workspace.iconForFile(path);
    var png = null;
    try { png = drawPng(image); } catch (error) { png = null; }
    if (!png || png.isNil()) png = tiffPng(image);
    if (!png || png.isNil() || !png.writeToFileAtomically(target, true)) throw new Error("PNG was not written");
    emit({ id: id, ok: true });
  } catch (error) {
    if (target) $.NSData.data.writeToFileAtomically(target, true);
    emit({ id: id, ok: false, error: String(error) });
  }
}

var buffer = "";
for (;;) {
  var chunk = input.availableData;
  if (!chunk || chunk.length === 0) break;
  buffer += $.NSString.alloc.initWithDataEncoding(chunk, $.NSUTF8StringEncoding).js;
  var index = buffer.indexOf("\n");
  while (index >= 0) {
    var request = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (request) handle(request);
    index = buffer.indexOf("\n");
  }
}
`;

  function supportsIcons(osName) {
    return Boolean(ICON_EXTENSIONS[osName]);
  }

  function extensionOf(path) {
    const match = String(path || "").match(/\.([^./\\]+)[\\/]*$/);
    return match ? match[1].toLowerCase() : "";
  }

  // Для каких записей показывать настоящий значок: .app в macOS; .exe, .lnk и .url в Windows.
  function wantsIcon(path, osName) {
    // Ссылки на сайты (https://…/setup.exe) — не файлы на диске.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(path || ""))) return false;
    return (ICON_EXTENSIONS[osName] || []).includes(extensionOf(path));
  }

  const SCRIPT_EXTENSIONS = ["bat", "cmd", "ps1", "sh", "command"];

  // Значок по умолчанию, когда настоящего нет: сайт, ссылка (steam://, .url), скрипт или программа.
  function defaultIconKind(path) {
    const value = String(path || "").trim();
    if (/^https?:\/\//i.test(value)) return "web";
    if (/^[a-z][a-z0-9+.-]+:/i.test(value)) return "link";
    const extension = extensionOf(value);
    if (SCRIPT_EXTENSIONS.includes(extension)) return "script";
    if (extension === "url") return "link";
    return "app";
  }

  function iconKey(path, osName) {
    const value = String(path || "");
    return osName === "Windows" ? value.toLowerCase() : value;
  }

  // Два 32-битных FNV-1a с разными началами — имя файла кеша из 16 шестнадцатеричных знаков.
  function hashText(text) {
    let first = 0x811c9dc5;
    let second = 0x01000193 ^ 0x5bd1e995;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x01000193) >>> 0;
      second = (second ^ (second >>> 13)) >>> 0;
    }
    return first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
  }

  function cacheDirectory(baseCachePath, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    return [String(baseCachePath || "").replace(/[\\/]+$/, ""), CACHE_FOLDER, CACHE_VERSION].join(separator);
  }

  function cacheFileFor(directory, path, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    return `${directory}${separator}${hashText(iconKey(path, osName))}.png`;
  }

  // stats — результат getStats файла кеша (или null, если его нет).
  function cacheState(stats, now) {
    if (!stats) return "missing";
    const age = now - Number(stats.modifiedAt || 0);
    if (!(Number(stats.size) > 0)) return age < FAILED_TTL_MS ? "failed" : "missing";
    return age < ICON_TTL_MS ? "fresh" : "stale";
  }

  function utf8Base64(text) {
    if (typeof Buffer !== "undefined") return Buffer.from(String(text), "utf8").toString("base64");
    const bytes = new TextEncoder().encode(String(text));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function encodeRequest(id, path, output) {
    return `${id} ${utf8Base64(path)} ${utf8Base64(output)}\n`;
  }

  function windowsScript() {
    // Исходник C# передаётся переменной, чтобы в нём не пришлось ничего экранировать.
    return `$extractorSource = @'${WINDOWS_EXTRACTOR}'@\n${WINDOWS_SCRIPT.replace("__SIZE__", String(ICON_PIXELS))}`;
  }

  // command — что запустить; preamble — что первым делом отправить в stdin.
  function buildProcess(osName) {
    if (osName === "Windows") {
      return {
        command: `powershell.exe -NoProfile -NonInteractive -STA -EncodedCommand ${Platform.encodePowerShell(WINDOWS_BOOTSTRAP)}`,
        preamble: `${utf8Base64(windowsScript())}\n`
      };
    }
    if (osName === "Darwin") {
      return {
        command: `osascript -l JavaScript -e ${Platform.shellQuote(MAC_SCRIPT.replace("__SIZE__", String(ICON_PIXELS)))}`,
        preamble: ""
      };
    }
    return null;
  }

  // Разбирает поток stdout на JSON-объекты; посторонние строки (например, итог osascript) пропускает.
  function createLineParser() {
    let rest = "";
    const parse = (lines) => lines.map((line) => line.trim()).filter((line) => line.startsWith("{")).map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    }).filter(Boolean);
    return {
      feed(chunk) {
        const lines = (rest + String(chunk || "")).split(/\r?\n/);
        rest = lines.pop();
        return parse(lines);
      },
      flush() {
        const lines = [rest];
        rest = "";
        return parse(lines);
      }
    };
  }

  // Загрузчик значков: сначала дисковый кеш, при промахе — извлечение в фоновом процессе.
  //   cacheDir                       — папка кеша (cacheDirectory(...));
  //   stat(file)                     → Promise<{size, modifiedAt}>, отклоняется, если файла нет;
  //   readUrl(file, fresh)           → Promise<url> картинки из файла кеша;
  //   spawn(command, onEvent)        → Promise<{id}>; onEvent получает {action, data} этого процесса;
  //   write(id, text), end(id)       — stdin процесса;
  //   onIcon(path, url)              — значок готов ("" — значка нет).
  function createIconLoader(options) {
    const {
      osName, cacheDir, stat, readUrl, spawn, write, end, onIcon,
      now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, warn = () => {}
    } = options;
    const entries = new Map();
    const queue = [];
    const running = new Map();
    let worker = null;
    let broken = !supportsIcons(osName) || !cacheDir;
    let nextRequestId = 1;
    let idleTimer = 0;

    function deliver(entry, url) {
      if (url) entry.url = url;
      onIcon(entry.path, url || entry.url || "");
    }

    function giveUp(entry) {
      entry.status = "done";
      if (!entry.url) deliver(entry, "");
    }

    async function check(entry) {
      const stats = await stat(entry.file).catch(() => null);
      const state = cacheState(stats, now());
      if (state === "fresh" || state === "stale") {
        const url = await Promise.resolve(readUrl(entry.file, false)).catch(() => "");
        if (url) deliver(entry, url);
        if (state === "fresh" && url) {
          entry.status = "done";
          return;
        }
      }
      if (state === "failed") {
        giveUp(entry);
        return;
      }
      enqueue(entry);
    }

    function enqueue(entry) {
      if (broken) {
        giveUp(entry);
        return;
      }
      entry.status = "queued";
      queue.push(entry);
      pump();
    }

    function scheduleIdle() {
      clearTimer(idleTimer);
      idleTimer = setTimer(() => {
        if (!worker || worker.id === null || worker.ending || queue.length || running.size) return;
        worker.ending = true;
        Promise.resolve(end(worker.id)).catch(() => {});
      }, IDLE_MS);
    }

    function send(current, text) {
      current.chain = current.chain
        .then(() => write(current.id, text))
        .catch((error) => warn("Unable to send icon requests", error));
    }

    function pump() {
      clearTimer(idleTimer);
      if (!queue.length) {
        if (!running.size) scheduleIdle();
        return;
      }
      if (!worker || worker.ending) startWorker();
      if (!worker || worker.id === null) return;
      const lines = queue.splice(0).map((entry) => {
        const id = nextRequestId;
        nextRequestId += 1;
        running.set(id, entry);
        entry.status = "running";
        return encodeRequest(id, entry.path, entry.file);
      });
      send(worker, lines.join(""));
    }

    function startWorker() {
      const spec = buildProcess(osName);
      if (!spec) {
        broken = true;
        queue.splice(0).forEach(giveUp);
        return;
      }
      const current = { id: null, ending: false, answered: false, parser: createLineParser(), chain: Promise.resolve() };
      worker = current;
      Promise.resolve(spawn(spec.command, (detail) => handleEvent(current, detail)))
        .then((process) => {
          current.id = process.id;
          if (spec.preamble) send(current, spec.preamble);
          if (worker === current) pump();
        })
        .catch((error) => {
          warn("Unable to start the icon extractor", error);
          if (worker === current) worker = null;
          broken = true;
          queue.splice(0).forEach(giveUp);
        });
    }

    function handleEvent(current, detail) {
      if (detail.action === "stdOut") {
        current.parser.feed(detail.data).forEach((message) => handleMessage(current, message));
      } else if (detail.action === "stdErr") {
        warn("Icon extractor:", String(detail.data || "").trim());
      } else if (detail.action === "exit") {
        current.parser.flush().forEach((message) => handleMessage(current, message));
        if (worker !== current) return;
        worker = null;
        // Процесс упал, не ответив ни разу, — значит, извлечение здесь не работает; не перезапускаем.
        if (!current.answered && !current.ending) broken = true;
        running.forEach((entry) => giveUp(entry));
        running.clear();
        if (broken) queue.splice(0).forEach(giveUp);
        else pump();
      }
    }

    async function handleMessage(current, message) {
      if (message.warning) warn("Icon extractor:", message.warning);
      if (!Number.isInteger(message.id)) return;
      current.answered = true;
      const entry = running.get(message.id);
      if (!entry) return;
      running.delete(message.id);
      if (message.ok) {
        const url = await Promise.resolve(readUrl(entry.file, true)).catch(() => "");
        entry.status = "done";
        deliver(entry, url);
      } else {
        if (message.error) warn(`No icon for ${entry.path}:`, message.error);
        giveUp(entry);
      }
      if (!queue.length && !running.size) scheduleIdle();
    }

    return {
      request(path) {
        if (!path || !supportsIcons(osName) || !cacheDir) return;
        const key = iconKey(path, osName);
        if (entries.has(key)) return;
        const entry = { path, file: cacheFileFor(cacheDir, path, osName), url: "", status: "checking" };
        entries.set(key, entry);
        check(entry);
      },
      peek(path) {
        return entries.get(iconKey(path, osName))?.url || "";
      },
      // "ready" — значок есть, "none" — получить не удалось, "pending" — ещё извлекается, "unknown" — не запрашивался.
      status(path) {
        const entry = entries.get(iconKey(path, osName));
        if (!entry) return "unknown";
        if (entry.url) return "ready";
        return entry.status === "done" ? "none" : "pending";
      },
      get pending() {
        return queue.length + running.size;
      }
    };
  }

  const api = {
    ICON_PIXELS,
    buildProcess,
    cacheDirectory,
    cacheFileFor,
    cacheState,
    createIconLoader,
    createLineParser,
    defaultIconKind,
    encodeRequest,
    hashText,
    iconKey,
    supportsIcons,
    wantsIcon,
    windowsScript,
    WINDOWS_BOOTSTRAP,
    MAC_SCRIPT
  };

  globalScope.GamePadAppIcons = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
