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
});
