(function initAutostart(globalScope) {
  "use strict";

  const Platform = globalScope.GamePadPlatform || (typeof require === "function" ? require("./platform.js") : null);

  const ENTRY_NAME = "GamePad UI";
  const DEFAULT_APP_ID = "ui.gamepad.launcher";
  const WINDOWS_RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  // Отключение в «Диспетчере задач → Автозагрузка» хранится отдельно: нечётный первый байт — выключено.
  const WINDOWS_APPROVED_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
  const MAC_AGENTS_DIR = "$HOME/Library/LaunchAgents";
  const LINUX_AUTOSTART_DIR = "${XDG_CONFIG_HOME:-$HOME/.config}/autostart";
  // Флаги Neutralino, без которых приложение не найдёт свои ресурсы; остальные (инспектор, dev-расширение) не нужны.
  const KEEP_FLAGS = ["--load-dir-res", "--res-mode", "--config-file"];

  function supportsAutostart(osName) {
    return osName === "Windows" || osName === "Darwin" || osName === "Linux";
  }

  function safeAppId(appId) {
    const value = String(appId || "");
    return /^[A-Za-z0-9._-]+$/.test(value) ? value : DEFAULT_APP_ID;
  }

  function isAbsolutePath(path, osName) {
    const value = String(path || "");
    return osName === "Windows" ? /^([a-z]:[\\/]|\\\\)/i.test(value) : value.startsWith("/");
  }

  // Делает путь абсолютным относительно рабочей папки и убирает «.» и «..».
  function resolvePath(path, cwd, osName) {
    const separator = osName === "Windows" ? "\\" : "/";
    let value = String(path || "");
    if (!value) return "";
    if (!isAbsolutePath(value, osName)) value = `${String(cwd || "").replace(/[\\/]+$/, "")}${separator}${value}`;
    const unc = osName === "Windows" && value.startsWith("\\\\");
    const parts = value.split(/[\\/]+/);
    const head = unc ? "" : parts.shift();
    const stack = [];
    parts.forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") stack.pop();
      else stack.push(part);
    });
    if (unc) return `\\\\${stack.join(separator)}`;
    if (osName === "Windows") return `${head}${separator}${stack.join(separator)}`;
    return `/${stack.join(separator)}`;
  }

  function directoryOf(path) {
    const value = String(path || "");
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    return index > 0 ? value.slice(0, index) : value;
  }

  // Как запустить эту же копию приложения: из NL_ARGS (argv), NL_CWD и NL_PATH.
  function launchSpec({ osName, args, cwd, appPath }) {
    const list = Array.isArray(args) ? args.map(String) : [];
    if (!list.length || !list[0]) return null;
    const executable = resolvePath(list[0], cwd, osName);
    const rest = list.slice(1);
    const kept = rest.filter((arg) => KEEP_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
    const directoryResources = kept.some((arg) => arg === "--load-dir-res" || arg === "--res-mode=directory");
    const explicitPath = rest.some((arg) => arg.startsWith("--path="));
    const workingDirectory = resolvePath(appPath || directoryOf(executable), cwd, osName);
    // Ресурсы из папки (режим разработки, neu run) ищутся относительно --path, а не папки программы.
    const pathFlag = directoryResources || explicitPath ? [`--path=${workingDirectory}`] : [];
    return {
      executable,
      arguments: [...kept, ...pathFlag],
      workingDirectory,
      devMode: directoryResources || rest.some((arg) => arg.startsWith("--neu-dev-"))
    };
  }

  // Правила разбора командной строки Windows (CommandLineToArgvW).
  function windowsQuote(value, force = false) {
    const text = String(value);
    if (!force && text && !/[\s"]/.test(text)) return text;
    return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
  }

  function windowsCommandLine(spec) {
    return [windowsQuote(spec.executable, true), ...spec.arguments.map((arg) => windowsQuote(arg))].join(" ");
  }

  function windowsExecutable(command) {
    const value = String(command || "").trim();
    if (value.startsWith("\"")) {
      const end = value.indexOf("\"", 1);
      return end > 0 ? value.slice(1, end) : value.slice(1);
    }
    return value.split(/\s+/)[0] || "";
  }

  function xmlEscape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function xmlUnescape(value) {
    return String(value)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, "&");
  }

  function macPlist(spec, appId) {
    const programArguments = [spec.executable, ...spec.arguments].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>Label</key>",
      `  <string>${xmlEscape(safeAppId(appId))}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      programArguments,
      "  </array>",
      "  <key>WorkingDirectory</key>",
      `  <string>${xmlEscape(spec.workingDirectory)}</string>`,
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>ProcessType</key>",
      "  <string>Interactive</string>",
      "</dict>",
      "</plist>",
      ""
    ].join("\n");
  }

  // Exec= в .desktop: аргумент в кавычках, внутри экранируются " ` $ \, а % удваивается.
  function desktopQuote(value) {
    const text = String(value).replace(/%/g, "%%");
    if (text && !/[\s"'\\><~|&;$*?#()`]/.test(text)) return text;
    return `"${text.replace(/(["`$\\])/g, "\\$1")}"`;
  }

  function desktopEscape(value) {
    // Значения ключей .desktop сами по себе разбирают «\\» как «\».
    return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  }

  function linuxDesktopEntry(spec) {
    const exec = [spec.executable, ...spec.arguments].map(desktopQuote).join(" ");
    return [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${ENTRY_NAME}`,
      `Exec=${desktopEscape(exec)}`,
      `Path=${desktopEscape(spec.workingDirectory)}`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      ""
    ].join("\n");
  }

  function desktopTokens(exec) {
    const tokens = [];
    let current = "";
    let quoted = false;
    let started = false;
    for (let index = 0; index < exec.length; index += 1) {
      const character = exec[index];
      if (quoted) {
        if (character === "\\" && index + 1 < exec.length) {
          current += exec[index + 1];
          index += 1;
        } else if (character === "\"") {
          quoted = false;
        } else {
          current += character;
        }
      } else if (character === "\"") {
        quoted = true;
        started = true;
      } else if (/\s/.test(character)) {
        if (started) tokens.push(current);
        current = "";
        started = false;
      } else {
        current += character;
        started = true;
      }
    }
    if (started) tokens.push(current);
    return tokens.map((token) => token.replace(/%%/g, "%"));
  }

  function macPlistPath(appId) {
    return `${MAC_AGENTS_DIR}/${safeAppId(appId)}.plist`;
  }

  function linuxEntryPath(appId) {
    return `${LINUX_AUTOSTART_DIR}/${safeAppId(appId)}.desktop`;
  }

  function powerShell(script) {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Platform.encodePowerShell(script)}`;
  }

  function buildStatusCommand(osName, appId) {
    if (osName === "Windows") {
      return powerShell([
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
        `$name = ${Platform.powerShellLiteral(ENTRY_NAME)}`,
        `$value = (Get-ItemProperty -Path ${Platform.powerShellLiteral(WINDOWS_RUN_KEY)} -Name $name -ErrorAction SilentlyContinue).$name`,
        `$approved = (Get-ItemProperty -Path ${Platform.powerShellLiteral(WINDOWS_APPROVED_KEY)} -Name $name -ErrorAction SilentlyContinue).$name`,
        "$disabled = $false",
        "if ($approved -is [byte[]] -and $approved.Length -gt 0) { $disabled = ($approved[0] % 2) -eq 1 }",
        "@{ command = [string]$value; disabled = $disabled } | ConvertTo-Json -Compress"
      ].join("\n"));
    }
    if (osName === "Darwin") return `cat "${macPlistPath(appId)}" 2>/dev/null || true`;
    if (osName === "Linux") return `cat "${linuxEntryPath(appId)}" 2>/dev/null || true`;
    return "";
  }

  // Состояние автозапуска: { enabled, disabled (выключен в системе), executable, arguments, command }.
  function parseStatus(osName, output) {
    const text = String(output || "");
    const off = { enabled: false, disabled: false, executable: "", arguments: [], command: "" };
    if (osName === "Windows") {
      const start = text.indexOf("{");
      if (start < 0) return off;
      try {
        const data = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
        const command = String(data.command || "").trim();
        if (!command) return off;
        return { enabled: true, disabled: Boolean(data.disabled), executable: windowsExecutable(command), arguments: [], command };
      } catch (error) {
        return off;
      }
    }
    if (osName === "Darwin") {
      const array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
      if (!array) return off;
      const values = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]));
      if (!values.length) return off;
      return {
        enabled: true,
        disabled: /<key>Disabled<\/key>\s*<true\s*\/>/.test(text),
        executable: values[0],
        arguments: values.slice(1),
        command: values.join(" ")
      };
    }
    if (osName === "Linux") {
      const exec = text.match(/^Exec=(.*)$/m);
      if (!exec) return off;
      const tokens = desktopTokens(exec[1].replace(/\\\\/g, "\\"));
      if (!tokens.length) return off;
      return {
        enabled: true,
        disabled: /^Hidden=true\s*$/m.test(text) || /^X-GNOME-Autostart-enabled=false\s*$/m.test(text),
        executable: tokens[0],
        arguments: tokens.slice(1),
        command: tokens.join(" ")
      };
    }
    return off;
  }

  // Автозапуск указывает именно на эту копию приложения (а не на старую папку или другую сборку).
  function matchesSpec(status, spec, osName) {
    if (!status?.enabled || !spec) return false;
    if (osName === "Windows") return status.command.toLowerCase() === windowsCommandLine(spec).toLowerCase();
    return status.executable === spec.executable && status.arguments.join("\u0000") === spec.arguments.join("\u0000");
  }

  function buildEnableCommand(osName, spec, appId) {
    if (!spec) return "";
    if (osName === "Windows") {
      return powerShell([
        "$ErrorActionPreference = 'Stop'",
        `$name = ${Platform.powerShellLiteral(ENTRY_NAME)}`,
        `$key = ${Platform.powerShellLiteral(WINDOWS_RUN_KEY)}`,
        "if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }",
        `Set-ItemProperty -Path $key -Name $name -Value ${Platform.powerShellLiteral(windowsCommandLine(spec))}`,
        // Если автозапуск выключали в «Диспетчере задач», снимаем этот запрет.
        `try { Remove-ItemProperty -Path ${Platform.powerShellLiteral(WINDOWS_APPROVED_KEY)} -Name $name -ErrorAction Stop } catch {}`
      ].join("\n"));
    }
    if (osName === "Darwin") {
      return `mkdir -p "${MAC_AGENTS_DIR}" && printf '%s' ${Platform.shellQuote(macPlist(spec, appId))} > "${macPlistPath(appId)}"`;
    }
    if (osName === "Linux") {
      return `mkdir -p "${LINUX_AUTOSTART_DIR}" && printf '%s' ${Platform.shellQuote(linuxDesktopEntry(spec))} > "${linuxEntryPath(appId)}"`;
    }
    return "";
  }

  function buildDisableCommand(osName, appId) {
    if (osName === "Windows") {
      return powerShell([
        `$name = ${Platform.powerShellLiteral(ENTRY_NAME)}`,
        `try { Remove-ItemProperty -Path ${Platform.powerShellLiteral(WINDOWS_RUN_KEY)} -Name $name -ErrorAction Stop } catch {}`,
        `try { Remove-ItemProperty -Path ${Platform.powerShellLiteral(WINDOWS_APPROVED_KEY)} -Name $name -ErrorAction Stop } catch {}`
      ].join("\n"));
    }
    // Агент не выгружаем через launchctl: если лаунчер сам запущен им, bootout завершил бы его.
    if (osName === "Darwin") return `rm -f "${macPlistPath(appId)}"`;
    if (osName === "Linux") return `rm -f "${linuxEntryPath(appId)}"`;
    return "";
  }

  const api = {
    ENTRY_NAME,
    buildDisableCommand,
    buildEnableCommand,
    buildStatusCommand,
    launchSpec,
    linuxDesktopEntry,
    macPlist,
    matchesSpec,
    parseStatus,
    resolvePath,
    supportsAutostart,
    windowsCommandLine
  };

  globalScope.GamePadAutostart = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
