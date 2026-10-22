(function initDisplays(globalScope) {
  "use strict";

  const Platform = globalScope.GamePadPlatform || (typeof require === "function" ? require("./platform.js") : null);
  const WINDOW_INSET = 40;

  // Neutralino знает только разрешения мониторов, но не их расположение, поэтому спрашиваем систему.
  // Windows: процесс PowerShell переводим в режим DPI-aware, чтобы получить реальные пиксельные координаты.
  const WINDOWS_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    "try { Add-Type -Namespace GamePadUI -Name Dpi -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);'; [GamePadUI.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$screens = foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) { [pscustomobject]@{ name = $screen.DeviceName; primary = $screen.Primary; x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height } }",
    "ConvertTo-Json -InputObject @($screens) -Compress"
  ].join("; ");

  // macOS: JavaScript for Automation. Координаты Cocoa отсчитываются от нижнего края основного экрана.
  const MAC_SCRIPT = [
    "ObjC.import('AppKit');",
    "JSON.stringify($.NSScreen.screens.js.map(function (screen) {",
    "var frame = screen.frame; var name = '';",
    "try { name = ObjC.unwrap(screen.localizedName) || ''; } catch (error) {}",
    "return { name: name, x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height, scale: screen.backingScaleFactor };",
    "}))"
  ].join(" ");

  function buildQueryCommand(osName) {
    if (osName === "Windows") return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Platform.encodePowerShell(WINDOWS_SCRIPT)}`;
    if (osName === "Darwin") return `osascript -l JavaScript -e ${Platform.shellQuote(MAC_SCRIPT)}`;
    if (osName === "Linux") return "xrandr --listmonitors";
    return "";
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : 0;
  }

  function parseJsonList(output) {
    const text = String(output || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  function parseWindows(output) {
    return parseJsonList(output).map((screen, index) => {
      const number = String(screen?.name || "").match(/DISPLAY(\d+)/i)?.[1];
      return {
        index,
        name: String(screen?.name || ""),
        label: `Монитор ${number || index + 1}`,
        primary: Boolean(screen?.primary),
        x: toNumber(screen?.x),
        y: toNumber(screen?.y),
        width: toNumber(screen?.width),
        height: toNumber(screen?.height),
        pixelWidth: toNumber(screen?.width),
        pixelHeight: toNumber(screen?.height)
      };
    });
  }

  function parseMac(output) {
    const screens = parseJsonList(output);
    const primaryHeight = toNumber(screens[0]?.height);
    return screens.map((screen, index) => {
      const width = toNumber(screen?.width);
      const height = toNumber(screen?.height);
      const scale = Number(screen?.scale) > 0 ? Number(screen.scale) : 1;
      const name = String(screen?.name || "").trim();
      return {
        index,
        name,
        label: name || `Монитор ${index + 1}`,
        primary: index === 0,
        x: toNumber(screen?.x),
        // Переводим в координаты окна Neutralino: от верхнего края основного экрана.
        y: primaryHeight - (toNumber(screen?.y) + height),
        width,
        height,
        pixelWidth: Math.round(width * scale),
        pixelHeight: Math.round(height * scale)
      };
    });
  }

  function parseLinux(output) {
    const pattern = /^\s*(\d+):\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/;
    return String(output || "").split(/\r?\n/)
      .map((line) => line.match(pattern))
      .filter(Boolean)
      .map((match, index) => ({
        index,
        name: match[3],
        label: match[3],
        primary: match[2] === "*",
        x: toNumber(match[6]),
        y: toNumber(match[7]),
        width: toNumber(match[4]),
        height: toNumber(match[5]),
        pixelWidth: toNumber(match[4]),
        pixelHeight: toNumber(match[5])
      }));
  }

  function parseDisplays(output, osName) {
    const parsers = { Windows: parseWindows, Darwin: parseMac, Linux: parseLinux };
    const displays = (parsers[osName] || (() => []))(output).filter((display) => display.width > 0 && display.height > 0);
    if (displays.length && !displays.some((display) => display.primary)) displays[0].primary = true;
    return displays;
  }

  // Где монитор находится относительно основного — чтобы в настройках было понятно, какой из них какой.
  function relativePosition(display, displays) {
    const primary = displays.find((item) => item.primary);
    if (!primary || primary === display) return "основной";
    const dx = (display.x + display.width / 2) - (primary.x + primary.width / 2);
    const dy = (display.y + display.height / 2) - (primary.y + primary.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "справа" : "слева";
    return dy > 0 ? "снизу" : "сверху";
  }

  function displayPreference(display) {
    if (!display) return null;
    const { index, name, x, y, width, height } = display;
    return { index, name, x, y, width, height };
  }

  // Сначала ищем монитор с теми же координатами, потом по имени, потом по номеру.
  function findDisplay(displays, preference) {
    if (!preference || !Array.isArray(displays) || !displays.length) return null;
    const sameBounds = displays.find((display) => display.x === preference.x && display.y === preference.y
      && display.width === preference.width && display.height === preference.height);
    if (sameBounds) return sameBounds;
    const sameName = preference.name ? displays.find((display) => display.name === preference.name) : null;
    return sameName || displays.find((display) => display.index === preference.index) || null;
  }

  function containsPoint(display, x, y) {
    return x >= display.x && x < display.x + display.width && y >= display.y && y < display.y + display.height;
  }

  // Окно целиком помещается внутрь выбранного монитора: полноэкранный режим откроется именно на нём.
  function targetWindowBounds(display) {
    return {
      x: display.x + WINDOW_INSET,
      y: display.y + WINDOW_INSET,
      width: Math.max(960, display.width - WINDOW_INSET * 2),
      height: Math.max(540, display.height - WINDOW_INSET * 2)
    };
  }

  const api = {
    buildQueryCommand,
    containsPoint,
    displayPreference,
    findDisplay,
    parseDisplays,
    relativePosition,
    targetWindowBounds
  };

  globalScope.GamePadDisplays = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
