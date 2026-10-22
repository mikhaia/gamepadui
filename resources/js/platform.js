(function initPlatform(globalScope) {
  "use strict";

  const Model = globalScope.GamePadModel || (typeof require === "function" ? require("./model.js") : null);

  function powerShellLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function encodePowerShell(script) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(script, "utf16le").toString("base64");
    }

    const bytes = [];
    for (let index = 0; index < script.length; index += 1) {
      const code = script.charCodeAt(index);
      bytes.push(String.fromCharCode(code & 0xff, code >> 8));
    }
    return globalScope.btoa(bytes.join(""));
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
  }

  function splitArguments(input) {
    const result = [];
    let current = "";
    let quote = null;
    let escaped = false;

    for (const character of String(input || "")) {
      if (escaped) {
        current += character;
        escaped = false;
      } else if (character === "\\" && quote !== "'") {
        escaped = true;
      } else if (quote && character === quote) {
        quote = null;
      } else if (!quote && (character === "'" || character === '"')) {
        quote = character;
      } else if (!quote && /\s/.test(character)) {
        if (current) {
          result.push(current);
          current = "";
        }
      } else {
        current += character;
      }
    }

    if (escaped) current += "\\";
    if (current) result.push(current);
    return result;
  }

  function parentDirectory(path) {
    const value = String(path || "").replace(/[\\/]+$/, "");
    const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    return index > 0 ? value.slice(0, index) : "";
  }

  // Ссылку открывает браузер по умолчанию. Адрес передаётся только в кавычках, которые оболочка
  // не раскрывает (в отличие от Neutralino.os.open, где $(...) в ссылке выполнился бы как команда).
  function buildUrlCommand(url, osName) {
    const target = String(url || "").trim();
    if (!Model.isWebUrl(target)) throw new Error("Некорректная ссылка");
    if (osName === "Windows") {
      return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(`Start-Process -FilePath ${powerShellLiteral(target)}`)}`;
    }
    if (osName === "Darwin") return `open ${shellQuote(target)}`;
    return `xdg-open ${shellQuote(target)}`;
  }

  function buildLaunchCommand(item, osName) {
    const path = String(item.path || "").trim();
    if (!path) throw new Error("Не указан путь к приложению");
    // Всё, что начинается с http(s), — ссылка: никогда не запускаем её как файл.
    if (/^https?:/i.test(path)) return buildUrlCommand(path, osName);
    const args = splitArguments(item.arguments);

    if (osName === "Windows") {
      const argumentList = args.length
        ? ` -ArgumentList @(${args.map(powerShellLiteral).join(",")})`
        : "";
      const workingDirectory = parentDirectory(path);
      const workingDirectoryOption = workingDirectory
        ? ` -WorkingDirectory ${powerShellLiteral(workingDirectory)}`
        : "";
      const script = `Start-Process -FilePath ${powerShellLiteral(path)}${argumentList}${workingDirectoryOption}`;
      return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
    }

    const quotedArguments = args.map(shellQuote).join(" ");
    const argumentSuffix = quotedArguments ? ` ${quotedArguments}` : "";
    const lowerPath = path.toLowerCase();

    if (osName === "Darwin") {
      if (lowerPath.endsWith(".app")) {
        return `open -a ${shellQuote(path)}${quotedArguments ? ` --args ${quotedArguments}` : ""}`;
      }
      return `${shellQuote(path)}${argumentSuffix}`;
    }

    if (lowerPath.endsWith(".desktop")) {
      return `gtk-launch ${shellQuote(path.split(/[\\/]/).pop().replace(/\.desktop$/i, ""))}`;
    }
    return `${shellQuote(path)}${argumentSuffix}`;
  }

  // Открыть файл программой, назначенной в системе (PDF — в просмотрщике, картинку — в галерее и т. д.).
  function buildOpenCommand(path, osName) {
    const target = String(path || "").trim();
    if (!target) throw new Error("Не указан путь к файлу");
    if (osName === "Windows") return buildLaunchCommand({ path: target }, osName);
    if (osName === "Darwin") return `open ${shellQuote(target)}`;
    return `xdg-open ${shellQuote(target)}`;
  }

  // Показать файл в системном файловом менеджере: Finder или Проводник Windows откроют папку и выделят файл.
  function buildRevealCommand(path, osName) {
    const target = String(path || "").trim().replace(/[\\/]+$/, "");
    if (!target) throw new Error("Не указан путь к файлу");
    if (osName === "Windows") {
      const script = `Start-Process -FilePath 'explorer.exe' -ArgumentList ${powerShellLiteral(`/select,"${target}"`)}`;
      return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
    }
    if (osName === "Darwin") return `open -R ${shellQuote(target)}`;
    // В Linux нет общего способа выделить файл, поэтому открываем его папку.
    return `xdg-open ${shellQuote(parentDirectory(target) || "/")}`;
  }

  function buildSystemCommand(action, osName) {
    const commands = {
      Windows: {
        sleep: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
        restart: "shutdown.exe /r /t 0",
        shutdown: "shutdown.exe /s /t 0"
      },
      Linux: {
        sleep: "systemctl suspend",
        restart: "systemctl reboot",
        shutdown: "systemctl poweroff"
      },
      Darwin: {
        sleep: "pmset sleepnow",
        restart: "osascript -e 'tell application \"System Events\" to restart'",
        shutdown: "osascript -e 'tell application \"System Events\" to shut down'"
      }
    };
    return commands[osName]?.[action] || "";
  }

  const api = {
    buildLaunchCommand,
    buildOpenCommand,
    buildRevealCommand,
    buildUrlCommand,
    buildSystemCommand,
    encodePowerShell,
    powerShellLiteral,
    shellQuote,
    splitArguments
  };

  globalScope.GamePadPlatform = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

