const test = require("node:test");
const assert = require("node:assert/strict");
const platform = require("../resources/js/platform.js");

test("splits quoted launch arguments without invoking a shell", () => {
  assert.deepEqual(platform.splitArguments('--profile "Player One" --fullscreen'), ["--profile", "Player One", "--fullscreen"]);
  assert.deepEqual(platform.splitArguments("'single value' plain\\ value"), ["single value", "plain value"]);
});

test("quotes POSIX arguments safely", () => {
  assert.equal(platform.shellQuote("player's game"), `'player'"'"'s game'`);
});

test("builds an encoded PowerShell launch command for Windows", () => {
  const command = platform.buildLaunchCommand({ path: "C:\\Games\\My Game.exe", arguments: "--fullscreen" }, "Windows");
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(command.includes("My Game.exe"), false);
});

test("builds a macOS app bundle launch command with arguments", () => {
  assert.equal(
    platform.buildLaunchCommand({ path: "/Applications/Arcade.app", arguments: "--fullscreen" }, "Darwin"),
    "open -a '/Applications/Arcade.app' --args '--fullscreen'"
  );
});

test("builds platform system commands", () => {
  assert.equal(platform.buildSystemCommand("shutdown", "Windows"), "shutdown.exe /s /t 0");
  assert.equal(platform.buildSystemCommand("sleep", "Linux"), "systemctl suspend");
  assert.equal(platform.buildSystemCommand("restart", "Unknown"), "");
  assert.equal(platform.buildSystemCommand("logout", "Windows"), "shutdown.exe /l");
  assert.equal(platform.buildSystemCommand("logout", "Darwin"), "osascript -e 'tell application \"loginwindow\" to «event aevtrlgo»'");
  assert.equal(platform.buildSystemCommand("logout", "Linux"), "loginctl terminate-session \"$XDG_SESSION_ID\"");
});

test("opens documents with the default application", () => {
  assert.equal(platform.buildOpenCommand("/Users/player/Downloads/Manual (1).pdf", "Darwin"), "open '/Users/player/Downloads/Manual (1).pdf'");
  assert.equal(platform.buildOpenCommand("/home/player/game.iso", "Linux"), "xdg-open '/home/player/game.iso'");
  const windows = platform.buildOpenCommand("C:\\Users\\Player\\Downloads\\Manual.pdf", "Windows");
  assert.match(windows, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  const script = Buffer.from(windows.split(" ").pop(), "base64").toString("utf16le");
  assert.match(script, /^Start-Process -FilePath 'C:\\Users\\Player\\Downloads\\Manual\.pdf'/);
});

test("reveals a found file in Finder, Windows Explorer or the Linux file manager", () => {
  assert.equal(platform.buildRevealCommand("/Users/player/Downloads/Manual (1).pdf", "Darwin"), "open -R '/Users/player/Downloads/Manual (1).pdf'");
  assert.equal(platform.buildRevealCommand("/Applications/Steam.app/", "Darwin"), "open -R '/Applications/Steam.app'");
  assert.equal(platform.buildRevealCommand("/home/player/Games/game.iso", "Linux"), "xdg-open '/home/player/Games'");
  const windows = platform.buildRevealCommand("C:\\Users\\Player\\Downloads\\Bob's Game.exe", "Windows");
  const script = Buffer.from(windows.split(" ").pop(), "base64").toString("utf16le");
  assert.equal(script, `Start-Process -FilePath 'explorer.exe' -ArgumentList '/select,"C:\\Users\\Player\\Downloads\\Bob''s Game.exe"'`);
});

test("opens links in the default browser without running anything from the address", () => {
  const tricky = "https://example.com/$(touch${IFS}/tmp/pwned)/`id`/it's";
  assert.equal(platform.buildLaunchCommand({ path: tricky, arguments: "--fullscreen" }, "Darwin"), `open 'https://example.com/$(touch\${IFS}/tmp/pwned)/\`id\`/it'"'"'s'`);
  assert.throws(() => platform.buildLaunchCommand({ path: "https://exa mple.com" }, "Darwin"), /Некорректная ссылка/);
  assert.equal(platform.buildLaunchCommand({ path: "https://store.steampowered.com/" }, "Linux"), "xdg-open 'https://store.steampowered.com/'");
  const windows = platform.buildLaunchCommand({ path: "https://www.youtube.com/watch?v=x&t=1", arguments: "--ignored" }, "Windows");
  const script = Buffer.from(windows.split(" ").pop(), "base64").toString("utf16le");
  assert.equal(script, "Start-Process -FilePath 'https://www.youtube.com/watch?v=x&t=1'");
  assert.throws(() => platform.buildUrlCommand("javascript:alert(1)", "Darwin"));
});

test("lists Windows drives with PowerShell DriveInfo", () => {
  const command = platform.buildDriveListCommand("Windows");
  assert.match(command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  const script = Buffer.from(command.split(" ").pop(), "base64").toString("utf16le");
  assert.match(script, /\[System\.IO\.DriveInfo\]::GetDrives\(\)/);
  assert.match(script, /ConvertTo-Json -InputObject @\(\$drives\) -Compress/);
  assert.equal(platform.buildDriveListCommand("Darwin"), "");
});
