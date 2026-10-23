const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const autostart = require("../resources/js/autostart.js");

const decode = (command) => Buffer.from(command.split(" ").pop(), "base64").toString("utf16le");

test("finds how to start this copy of the app from argv", () => {
  const release = autostart.launchSpec({
    osName: "Windows",
    args: ["C:\\Games\\GamePad UI\\gamepad-ui-win_x64.exe"],
    cwd: "C:\\Windows\\System32",
    appPath: "C:\\Games\\GamePad UI"
  });
  assert.deepEqual(release, {
    executable: "C:\\Games\\GamePad UI\\gamepad-ui-win_x64.exe",
    arguments: [],
    workingDirectory: "C:\\Games\\GamePad UI",
    devMode: false
  });

  const relative = autostart.launchSpec({ osName: "Darwin", args: ["./gamepad-ui-mac_arm64"], cwd: "/Users/p/dist/gamepad-ui", appPath: "." });
  assert.equal(relative.executable, "/Users/p/dist/gamepad-ui/gamepad-ui-mac_arm64");
  assert.equal(relative.workingDirectory, "/Users/p/dist/gamepad-ui");
  assert.deepEqual(relative.arguments, []);

  // neu run: ресурсы из папки проекта, служебные флаги разработки не нужны
  const dev = autostart.launchSpec({
    osName: "Darwin",
    args: ["bin/neutralino-mac_arm64", "--load-dir-res", "--path=.", "--export-auth-info", "--neu-dev-extension", "--neu-dev-auto-reload", "--window-enable-inspector"],
    cwd: "/Users/chrono/dev/gamepadui",
    appPath: "."
  });
  assert.deepEqual(dev, {
    executable: "/Users/chrono/dev/gamepadui/bin/neutralino-mac_arm64",
    arguments: ["--load-dir-res", "--path=/Users/chrono/dev/gamepadui"],
    workingDirectory: "/Users/chrono/dev/gamepadui",
    devMode: true
  });
  assert.equal(autostart.launchSpec({ osName: "Linux", args: [] }), null);
  assert.equal(autostart.resolvePath("..\\GamePad\\.\\app.exe", "C:\\Games\\Tools", "Windows"), "C:\\Games\\GamePad\\app.exe");
});

test("quotes the Windows command line by CommandLineToArgvW rules", () => {
  assert.equal(autostart.windowsCommandLine({ executable: "C:\\GP\\gp.exe", arguments: [] }), "\"C:\\GP\\gp.exe\"");
  assert.equal(
    autostart.windowsCommandLine({ executable: "C:\\Program Files\\GP\\gp.exe", arguments: ["--load-dir-res", "--path=C:\\My Games\\"] }),
    "\"C:\\Program Files\\GP\\gp.exe\" --load-dir-res \"--path=C:\\My Games\\\\\""
  );
});

test("Windows uses the Run key and clears a Task Manager block when enabling", () => {
  const spec = { executable: "C:\\Игры\\Bob's GamePad\\gp.exe", arguments: [], workingDirectory: "C:\\Игры\\Bob's GamePad" };
  const enable = decode(autostart.buildEnableCommand("Windows", spec, "ui.gamepad.launcher"));
  assert.match(enable, /Set-ItemProperty -Path \$key -Name \$name -Value '"C:\\Игры\\Bob''s GamePad\\gp\.exe"'/);
  assert.match(enable, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'/);
  assert.match(enable, /StartupApproved\\Run' -Name \$name/);
  const disable = decode(autostart.buildDisableCommand("Windows"));
  assert.match(disable, /Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name \$name/);
  assert.match(decode(autostart.buildStatusCommand("Windows")), /ConvertTo-Json -Compress/);

  const status = autostart.parseStatus("Windows", "{\"command\":\"\\\"C:\\\\Игры\\\\Bob's GamePad\\\\gp.exe\\\"\",\"disabled\":true}\r\n");
  assert.equal(status.enabled, true);
  assert.equal(status.disabled, true);
  assert.equal(status.executable, "C:\\Игры\\Bob's GamePad\\gp.exe");
  assert.equal(autostart.matchesSpec(status, spec, "Windows"), true);
  assert.equal(autostart.matchesSpec(status, { ...spec, executable: "D:\\Other\\gp.exe" }, "Windows"), false);
  assert.equal(autostart.parseStatus("Windows", "{\"command\":\"\",\"disabled\":false}").enabled, false);
  assert.equal(autostart.parseStatus("Windows", "").enabled, false);
});

test("macOS writes a LaunchAgent that round-trips through the status parser", () => {
  const spec = { executable: "/Users/p/Games & Apps/<GP>/gp", arguments: ["--load-dir-res", "--path=/Users/p/Bob's"], workingDirectory: "/Users/p/Games & Apps/<GP>" };
  const plist = autostart.macPlist(spec, "ui.gamepad.launcher");
  assert.match(plist, /<key>Label<\/key>\n {2}<string>ui\.gamepad\.launcher<\/string>/);
  assert.match(plist, /<string>\/Users\/p\/Games &amp; Apps\/&lt;GP&gt;\/gp<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  const status = autostart.parseStatus("Darwin", plist);
  assert.equal(status.enabled, true);
  assert.equal(status.executable, spec.executable);
  assert.deepEqual(status.arguments, spec.arguments);
  assert.equal(autostart.matchesSpec(status, spec, "Darwin"), true);
  assert.equal(autostart.parseStatus("Darwin", "").enabled, false);
  assert.match(autostart.buildEnableCommand("Darwin", spec, "../evil"), /> "\$HOME\/Library\/LaunchAgents\/ui\.gamepad\.launcher\.plist"$/);
  assert.equal(autostart.buildDisableCommand("Darwin", "ui.gamepad.launcher"), "rm -f \"$HOME/Library/LaunchAgents/ui.gamepad.launcher.plist\"");
});

test("Linux writes an XDG autostart entry with Exec quoting", () => {
  const spec = { executable: "/home/p/My $Games/gp", arguments: ["--path=/home/p/100% \"fun\""], workingDirectory: "/home/p/My $Games" };
  const entry = autostart.linuxDesktopEntry(spec);
  assert.match(entry, /^Exec="\/home\/p\/My \\\\\$Games\/gp" "--path=\/home\/p\/100%% \\\\"fun\\\\""$/m);
  const status = autostart.parseStatus("Linux", entry);
  assert.equal(status.executable, spec.executable);
  assert.deepEqual(status.arguments, spec.arguments);
  assert.equal(autostart.matchesSpec(status, spec, "Linux"), true);
  assert.equal(autostart.parseStatus("Linux", entry.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false")).disabled, true);
});

test("the macOS and Linux shell commands really write, read and remove the entry", { skip: process.platform === "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gamepadui-autostart-"));
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  const run = (command) => execSync(command, { env, shell: "/bin/sh", encoding: "utf8" });
  try {
    for (const osName of ["Darwin", "Linux"]) {
      const spec = { executable: `${home}/Bob's Games/gp`, arguments: ["--load-dir-res", `--path=${home}/Bob's Games`], workingDirectory: `${home}/Bob's Games` };
      assert.equal(autostart.parseStatus(osName, run(autostart.buildStatusCommand(osName, "ui.gamepad.launcher"))).enabled, false);
      run(autostart.buildEnableCommand(osName, spec, "ui.gamepad.launcher"));
      const status = autostart.parseStatus(osName, run(autostart.buildStatusCommand(osName, "ui.gamepad.launcher")));
      assert.equal(autostart.matchesSpec(status, spec, osName), true, osName);
      run(autostart.buildDisableCommand(osName, "ui.gamepad.launcher"));
      assert.equal(autostart.parseStatus(osName, run(autostart.buildStatusCommand(osName, "ui.gamepad.launcher"))).enabled, false);
    }
    assert.ok(fs.existsSync(path.join(home, "Library", "LaunchAgents")));
    assert.ok(fs.existsSync(path.join(home, ".config", "autostart")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
