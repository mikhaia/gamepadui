const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../resources/js/model.js");

test("normalizes library items and derives a name from the path", () => {
  const item = model.normalizeItem({ path: "C:\\Games\\Hades.exe", favorite: 1 });
  assert.equal(item.name, "Hades");
  assert.equal(item.favorite, true);
  assert.equal(item.arguments, "");
  assert.equal(item.coverSource, "file");
});

test("infers and preserves the selected cover source", () => {
  assert.equal(model.normalizeItem({ coverPath: "https://example.com/cover.jpg" }).coverSource, "url");
  assert.equal(model.normalizeItem({ coverPath: "https://example.com/cover.jpg", coverSource: "gamestory" }).coverSource, "gamestory");
  assert.equal(model.normalizeItem({ coverPath: "C:\\Covers\\game.png", coverSource: "unknown" }).coverSource, "file");
});

test("normalizes GameStory cover results and drops invalid image links", () => {
  assert.deepEqual(model.normalizeCoverSearchResults([
    { id: 3830, title: "Hades", cover: "https://cdn.example/hades.jpg" },
    { id: 1, title: "No cover", cover: "" },
    { id: 2, title: "Unsafe", cover: "javascript:alert(1)" }
  ]), [
    { id: "3830", title: "Hades", cover: "https://cdn.example/hades.jpg" }
  ]);
});

test("recognizes platform-specific launchable files", () => {
  assert.equal(model.isLaunchable("Game.EXE", "Windows"), true);
  assert.equal(model.isLaunchable("Game.lnk", "Windows"), true);
  assert.equal(model.isLaunchable("readme.txt", "Windows"), false);
  assert.equal(model.isLaunchable("game.AppImage", "Linux"), true);
  assert.equal(model.isLaunchable("Arcade.app", "Darwin"), true);
});

test("treats macOS app bundles as launchable applications instead of folders", () => {
  assert.equal(model.isApplicationBundle("Arcade.app", "DIRECTORY", "Darwin"), true);
  assert.equal(model.isLaunchableEntry("Arcade.app", "DIRECTORY", "Darwin"), true);
  assert.equal(model.isLaunchableEntry("Arcade.app", "DIRECTORY", "Linux"), false);
  assert.equal(model.isLaunchableEntry("Games", "DIRECTORY", "Darwin"), false);
});

test("sorts macOS app bundles with files after real folders", () => {
  const entries = model.sortEntries([
    { entry: "Zeta.app", type: "DIRECTORY" },
    { entry: "Notes.txt", type: "FILE" },
    { entry: "Games", type: "DIRECTORY" }
  ], "Darwin");
  assert.deepEqual(entries.map((entry) => entry.entry), ["Games", "Notes.txt", "Zeta.app"]);
});

test("filters current explorer entries by name without case sensitivity", () => {
  assert.equal(model.matchesEntrySearch({ entry: "Hades.app" }, "hAd"), true);
  assert.equal(model.matchesEntrySearch({ entry: "Celeste.app" }, "hAd"), false);
  assert.equal(model.matchesEntrySearch({ entry: "Anything" }, "  "), true);
});

test("sorts folders before files and uses natural name ordering", () => {
  const entries = model.sortEntries([
    { entry: "Game 10.exe", type: "FILE" },
    { entry: "Zeta", type: "DIRECTORY" },
    { entry: "Game 2.exe", type: "FILE" },
    { entry: "Arcade", type: "DIRECTORY" }
  ]);
  assert.deepEqual(entries.map((entry) => entry.entry), ["Arcade", "Zeta", "Game 2.exe", "Game 10.exe"]);
});

test("joins and ascends Windows and Unix paths", () => {
  assert.equal(model.joinPath("C:\\Games", "Hades", "Windows"), "C:\\Games\\Hades");
  assert.equal(model.parentPath("C:\\Games\\Hades", "Windows"), "C:\\Games");
  assert.equal(model.parentPath("C:\\", "Windows"), "C:\\");
  assert.equal(model.joinPath("/home/player", "Games", "Linux"), "/home/player/Games");
  assert.equal(model.parentPath("/home/player/Games", "Linux"), "/home/player");
  assert.equal(model.parentPath("/", "Linux"), "/");
});
