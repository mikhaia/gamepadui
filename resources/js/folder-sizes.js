(function initFolderSizes(globalScope) {
  "use strict";

  const Platform = globalScope.GamePadPlatform || (typeof require === "function" ? require("./platform.js") : null);
  // В Windows каждую подпапку считаем не дольше 8 секунд — размер огромных папок будет «не меньше N».
  const WINDOWS_FOLDER_BUDGET_MS = 8000;

  function trimTrailingSeparators(path) {
    const value = String(path || "");
    const trimmed = value.replace(/[\\/]+$/, "");
    return trimmed || value.slice(0, 1);
  }

  // PowerShell: обходим подпапки сами (без ссылок-джанкшенов, чтобы не считать дважды) и печатаем
  // по строке JSON на подпапку сразу, как только она посчитана. Не-ASCII символы экранируем,
  // чтобы имена не зависели от кодировки консоли.
  function windowsScript(parentPath) {
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      `$parent = [System.IO.DirectoryInfo]::new(${Platform.powerShellLiteral(parentPath)})`,
      "$reparse = [System.IO.FileAttributes]::ReparsePoint",
      "try { $folders = @($parent.EnumerateDirectories()) } catch { $folders = @() }",
      "foreach ($folder in $folders) {",
      "  if ($folder.Attributes -band $reparse) { continue }",
      "  $size = [long]0; $partial = $false",
      "  $timer = [System.Diagnostics.Stopwatch]::StartNew()",
      "  $stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'",
      "  $stack.Push($folder)",
      "  while ($stack.Count -gt 0) {",
      `    if ($timer.ElapsedMilliseconds -gt ${WINDOWS_FOLDER_BUDGET_MS}) { $partial = $true; break }`,
      "    $current = $stack.Pop()",
      "    try { foreach ($file in $current.EnumerateFiles()) { $size += $file.Length } } catch {}",
      "    try { foreach ($child in $current.EnumerateDirectories()) { if (-not ($child.Attributes -band $reparse)) { $stack.Push($child) } } } catch {}",
      "  }",
      "  $json = ConvertTo-Json -Compress -InputObject ([ordered]@{ name = $folder.Name; size = $size; partial = $partial })",
      "  $json = [regex]::Replace($json, '[^\\x00-\\x7F]', { param($match) '\\u{0:x4}' -f [int][char]$match.Value })",
      "  [Console]::Out.WriteLine($json)",
      "  [Console]::Out.Flush()",
      "}"
    ].join("\n");
  }

  function buildCommand(parentPath, osName) {
    const parent = trimTrailingSeparators(parentPath);
    if (!parent) return "";
    if (osName === "Windows") return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Platform.encodePowerShell(windowsScript(parent))}`;
    // du сообщает о каждой подпапке, как только досчитал её; -x не уходит на другие диски.
    if (osName === "Darwin" || osName === "Linux") return `du -k -x -d 1 ${Platform.shellQuote(parent)}`;
    return "";
  }

  function lastSegment(path) {
    return String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
  }

  // Разбирает вывод по кускам: строки могут приходить разорванными посреди.
  function createParser(osName, parentPath) {
    const parent = trimTrailingSeparators(parentPath).replace(/\\/g, "/");
    let buffer = "";

    function parseLine(line) {
      const text = line.trim();
      if (!text) return null;
      if (osName === "Windows") {
        try {
          const item = JSON.parse(text);
          const size = Number(item?.size);
          return item?.name && Number.isFinite(size) ? { name: String(item.name), size, partial: Boolean(item.partial) } : null;
        } catch (error) {
          return null;
        }
      }
      const match = text.match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const path = trimTrailingSeparators(match[2]).replace(/\/{2,}/g, "/");
      if (path === parent || path === `${parent}/` || !path.startsWith(parent === "/" ? "/" : `${parent}/`)) return null;
      return { name: lastSegment(path), size: Number(match[1]) * 1024, partial: false };
    }

    function feed(chunk) {
      buffer += String(chunk ?? "");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      return lines.map(parseLine).filter(Boolean);
    }

    function flush() {
      const rest = buffer;
      buffer = "";
      return [rest].map(parseLine).filter(Boolean);
    }

    return { feed, flush };
  }

  const api = { buildCommand, createParser, WINDOWS_FOLDER_BUDGET_MS };

  globalScope.GamePadFolderSizes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
