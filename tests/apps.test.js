const test = require("node:test");
const assert = require("node:assert/strict");
const apps = require("../resources/js/apps.js");
const model = require("../resources/js/model.js");

function fakeFileSystem(tree) {
  return async (path) => {
    if (!(path in tree)) throw Object.assign(new Error("not found"), { code: "NE_FS_NOPATHE" });
    return tree[path].map(([entry, type]) => ({ entry, type }));
  };
}

const USER_MENU = "C:\\Users\\Player\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
const COMMON_MENU = "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs";

test("uses the real Start Menu folders on Windows and application folders on macOS", () => {
  assert.deepEqual(apps.getAppSources("Windows", { appData: "C:\\Users\\Player\\AppData\\Roaming\\", programData: "C:\\ProgramData" }), [USER_MENU, COMMON_MENU]);
  assert.deepEqual(apps.getAppSources("Windows", { programData: "C:\\ProgramData" }), [COMMON_MENU]);
  assert.deepEqual(apps.getAppSources("Darwin", { home: "/Users/player" }), ["/Applications", "/System/Applications", "/Users/player/Applications"]);
  assert.deepEqual(apps.getAppSources("Linux", {}), []);
});

test("collects Start Menu shortcuts recursively without uninstallers, startup items or duplicates", async () => {
  const readDirectory = fakeFileSystem({
    [USER_MENU]: [["Steam", "DIRECTORY"], ["Discord.lnk", "FILE"], ["desktop.ini", "FILE"], ["Startup", "DIRECTORY"]],
    [`${USER_MENU}\\Steam`]: [["Hades II.url", "FILE"], ["Steam.lnk", "FILE"], ["Uninstall Steam.lnk", "FILE"]],
    [`${USER_MENU}\\Startup`]: [["Autorun.lnk", "FILE"]],
    [COMMON_MENU]: [["Accessories", "DIRECTORY"], ["7-Zip", "DIRECTORY"], ["Удалить Foo.lnk", "FILE"]],
    [`${COMMON_MENU}\\Accessories`]: [["Paint.lnk", "FILE"], ["System Tools", "DIRECTORY"]],
    [`${COMMON_MENU}\\Accessories\\System Tools`]: [["Character Map.lnk", "FILE"]],
    [`${COMMON_MENU}\\7-Zip`]: [["7-Zip File Manager.lnk", "FILE"], ["7-Zip Help.chm", "FILE"]]
  });
  const outcome = await apps.collectApps({ sources: [USER_MENU, COMMON_MENU], osName: "Windows", readDirectory, joinPath: model.joinPath });
  assert.equal(outcome.failedSources, 0);
  assert.deepEqual(outcome.apps.map((app) => [app.name, app.group]), [
    ["7-Zip File Manager", "7-Zip"],
    ["Character Map", "Accessories / System Tools"],
    ["Discord", ""],
    ["Hades II", "Steam"],
    ["Paint", "Accessories"],
    ["Steam", "Steam"]
  ]);
  assert.equal(outcome.apps.find((app) => app.name === "Hades II").path, `${USER_MENU}\\Steam\\Hades II.url`);
});

test("keeps the user's shortcut when both Start Menus contain the same entry", async () => {
  const readDirectory = fakeFileSystem({
    [USER_MENU]: [["Notepad.lnk", "FILE"]],
    [COMMON_MENU]: [["Notepad.lnk", "FILE"], ["Paint.lnk", "FILE"]]
  });
  const outcome = await apps.collectApps({ sources: [USER_MENU, COMMON_MENU], osName: "Windows", readDirectory, joinPath: model.joinPath });
  assert.deepEqual(outcome.apps.map((app) => app.path), [`${USER_MENU}\\Notepad.lnk`, `${COMMON_MENU}\\Paint.lnk`]);
});

test("lists macOS application bundles and one level of vendor folders", async () => {
  const readDirectory = fakeFileSystem({
    "/Applications": [["Safari.app", "DIRECTORY"], ["Utilities", "DIRECTORY"], [".DS_Store", "FILE"], ["Adobe", "DIRECTORY"]],
    "/Applications/Utilities": [["Terminal.app", "DIRECTORY"]],
    "/Applications/Adobe": [["Photoshop.app", "DIRECTORY"], ["Plugins", "DIRECTORY"]],
    "/Applications/Adobe/Plugins": [["Hidden.app", "DIRECTORY"]],
    "/System/Applications": [["Calculator.app", "DIRECTORY"], ["Utilities", "DIRECTORY"]],
    "/System/Applications/Utilities": [["Terminal.app", "DIRECTORY"]]
  });
  const sources = apps.getAppSources("Darwin", { home: "/Users/player" });
  const outcome = await apps.collectApps({ sources, osName: "Darwin", readDirectory, joinPath: model.joinPath });
  assert.deepEqual(outcome.apps.map((app) => app.name), ["Calculator", "Photoshop", "Safari", "Terminal"]);
  assert.equal(outcome.apps.find((app) => app.name === "Terminal").path, "/Applications/Utilities/Terminal.app");
  assert.equal(outcome.failedSources, 1, "~/Applications does not exist");
});

test("filters by name and folder", () => {
  const list = [{ name: "Hades II", group: "Steam" }, { name: "Paint", group: "Accessories" }];
  assert.deepEqual(apps.filterApps(list, "  steam "), [list[0]]);
  assert.deepEqual(apps.filterApps(list, "pai"), [list[1]]);
  assert.equal(apps.filterApps(list, ""), list);
});

test("recognizes uninstaller shortcuts", () => {
  for (const name of ["Uninstall Steam.lnk", "Steam Uninstaller.lnk", "unins000.lnk", "Удалить Foo.lnk", "Деинсталлировать Bar.lnk", "Foo (Uninstall).lnk"]) {
    assert.equal(apps.isUninstaller(name), true, name);
  }
  for (const name of ["Steam.lnk", "Install Shield Hero.lnk", "Mount & Blade.lnk"]) {
    assert.equal(apps.isUninstaller(name), false, name);
  }
});
