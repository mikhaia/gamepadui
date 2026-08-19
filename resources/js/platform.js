(function initPlatform(globalScope) {
  "use strict";

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

  function buildLaunchCommand(item, osName) {
    const path = String(item.path || "").trim();
    if (!path) throw new Error("Не указан путь к приложению");
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
    buildSystemCommand,
    encodePowerShell,
    shellQuote,
    splitArguments
  };

  globalScope.GamePadPlatform = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

