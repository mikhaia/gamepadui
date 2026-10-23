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
  assert.equal(model.joinPath("/", "Applications", "Darwin"), "/Applications");
  assert.equal(model.joinPath("/", "usr", "Linux"), "/usr");
  assert.equal(model.parentPath("/home/player/Games", "Linux"), "/home/player");
  assert.equal(model.parentPath("/", "Linux"), "/");
});

const LIBRARY = [
  { id: "a", favorite: true },
  { id: "b", favorite: false },
  { id: "c", favorite: true },
  { id: "d", favorite: true },
  { id: "e", favorite: true }
];
const ids = (items) => items.map((item) => item.id);

test("orders favorites by the saved order and appends new favorites in library order", () => {
  assert.deepEqual(ids(model.orderFavorites(LIBRARY, [])), ["a", "c", "d", "e"]);
  assert.deepEqual(ids(model.orderFavorites(LIBRARY, ["d", "a"])), ["d", "a", "c", "e"]);
  assert.deepEqual(ids(model.orderFavorites(LIBRARY, ["b", "zzz", "e"])), ["e", "a", "c", "d"], "non-favorites and unknown ids are ignored");
});

test("moves a favorite first, previous, next and last", () => {
  const order = ["a", "c", "d", "e"];
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "d", "first"), ["d", "a", "c", "e"]);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "d", "previous"), ["a", "d", "c", "e"]);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "d", "next"), ["a", "c", "e", "d"]);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "c", "last"), ["a", "d", "e", "c"]);
});

test("keeps the order unchanged at the edges and for unknown items", () => {
  const order = ["a", "c", "d", "e"];
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "a", "previous"), order);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "a", "first"), order);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "e", "next"), order);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "b", "first"), order);
  assert.deepEqual(model.moveFavorite(LIBRARY, order, "c", "sideways"), order);
});

test("reports the position of a favorite", () => {
  assert.deepEqual(model.favoritePosition(LIBRARY, ["d"], "d"), { index: 0, total: 4 });
  assert.deepEqual(model.favoritePosition(LIBRARY, [], "b"), { index: -1, total: 4 });
});

const EXPLORER_ENTRIES = [
  { entry: "small.txt", type: "FILE" },
  { entry: "Games", type: "DIRECTORY" },
  { entry: "big.iso", type: "FILE" },
  { entry: "Archive", type: "DIRECTORY" },
  { entry: "unknown.bin", type: "FILE" },
  { entry: "Player.app", type: "DIRECTORY" },
  { entry: "medium.zip", type: "FILE" }
];
const EXPLORER_STATS = new Map([
  ["small.txt", { size: 12, modifiedAt: 3000 }],
  ["Games", { size: 4096, modifiedAt: 1000 }],
  ["big.iso", { size: 4_000_000_000, modifiedAt: 1000 }],
  ["Archive", { size: 4096, modifiedAt: 5000 }],
  ["Player.app", { size: 96, modifiedAt: 4000 }],
  ["medium.zip", { size: 50_000, modifiedAt: 2000 }]
]);
const names = (entries) => entries.map((entry) => entry.entry);

test("sorts explorer entries by size from largest, keeping folders first", () => {
  assert.deepEqual(names(model.sortEntries(EXPLORER_ENTRIES, "Darwin", { sort: "size", stats: EXPLORER_STATS })), [
    "Archive", "Games", "big.iso", "medium.zip", "small.txt", "Player.app", "unknown.bin"
  ]);
});

test("sorts explorer entries by modification date from newest, keeping folders first", () => {
  assert.deepEqual(names(model.sortEntries(EXPLORER_ENTRIES, "Darwin", { sort: "date", stats: EXPLORER_STATS })), [
    "Archive", "Games", "Player.app", "small.txt", "medium.zip", "big.iso", "unknown.bin"
  ]);
});

test("falls back to name order without stats or with an unknown sort", () => {
  const byName = ["Archive", "Games", "big.iso", "medium.zip", "Player.app", "small.txt", "unknown.bin"];
  assert.deepEqual(names(model.sortEntries(EXPLORER_ENTRIES, "Darwin", { sort: "size" })), byName);
  assert.deepEqual(names(model.sortEntries(EXPLORER_ENTRIES, "Darwin", { sort: "weird", stats: EXPLORER_STATS })), byName);
});

test("formats file sizes in Russian units", () => {
  assert.equal(model.formatFileSize(512), "512 Б");
  assert.equal(model.formatFileSize(1536), "1,5 КБ");
  assert.equal(model.formatFileSize(2.4 * 1024 * 1024), "2,4 МБ");
  assert.equal(model.formatFileSize(150 * 1024 * 1024), "150 МБ");
  assert.equal(model.formatFileSize(4_000_000_000), "3,7 ГБ");
  assert.equal(model.formatFileSize(undefined), "");
});

test("recognizes only http and https links to a site", () => {
  for (const url of ["https://store.steampowered.com/", "http://localhost:8080/games", "  https://www.youtube.com/watch?v=x  ", "HTTPS://Example.com"]) {
    assert.equal(model.isWebUrl(url), true, url);
  }
  for (const url of ["www.youtube.com", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://", "https://exa mple.com", "C:\\Games\\Hades.exe", ""]) {
    assert.equal(model.isWebUrl(url), false, url);
  }
});

test("derives a readable name from a link", () => {
  assert.equal(model.nameFromPath("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube.com");
  assert.equal(model.nameFromPath("https://store.steampowered.com/"), "store.steampowered.com");
  assert.equal(model.normalizeItem({ path: "https://www.twitch.tv/" }).name, "twitch.tv");
});

test("normalizes and compares pinned folder paths", () => {
  assert.equal(model.normalizeFolderPath("C:/Games/", "Windows"), "C:\\Games");
  assert.equal(model.normalizeFolderPath("D:", "Windows"), "D:\\");
  assert.equal(model.normalizeFolderPath("/Users/player/", "Darwin"), "/Users/player");
  assert.equal(model.normalizeFolderPath("/", "Linux"), "/");
  assert.equal(model.sameFolder("C:\\GAMES\\", "c:\\games", "Windows"), true);
  assert.equal(model.sameFolder("/Users/Player", "/Users/player", "Darwin"), false);
});

test("pins, unpins and reorders folders", () => {
  let pins = model.pinFolder([], "/Users/player/", "Darwin");
  pins = model.pinFolder(pins, "/Users/player/Games", "Darwin");
  pins = model.pinFolder(pins, "/Users/player", "Darwin");
  assert.deepEqual(pins, ["/Users/player", "/Users/player/Games"], "no duplicates");
  pins = model.pinFolder(pins, "/Volumes/Data", "Darwin");
  assert.deepEqual(model.movePinnedFolder(pins, "/Volumes/Data", "up", "Darwin"), ["/Users/player", "/Volumes/Data", "/Users/player/Games"]);
  assert.deepEqual(model.movePinnedFolder(pins, "/Users/player", "down", "Darwin"), ["/Users/player/Games", "/Users/player", "/Volumes/Data"]);
  assert.deepEqual(model.movePinnedFolder(pins, "/Users/player", "up", "Darwin"), pins, "first stays first");
  assert.deepEqual(model.movePinnedFolder(pins, "/Volumes/Data", "down", "Darwin"), pins, "last stays last");
  assert.deepEqual(model.unpinFolder(pins, "/Users/player/Games/", "Darwin"), ["/Users/player", "/Volumes/Data"]);
  assert.deepEqual(model.unpinFolder(["C:\\Games"], "c:\\games\\", "Windows"), []);
});

test("shows a readable name for pinned folders", () => {
  assert.equal(model.folderDisplayName("C:\\Users\\Player\\Downloads\\", "Windows"), "Downloads");
  assert.equal(model.folderDisplayName("d:\\", "Windows"), "Диск D:");
  assert.equal(model.folderDisplayName("/", "Darwin"), "Корень диска");
  assert.equal(model.folderDisplayName("/Users/player/Games", "Darwin"), "Games");
});

test("validates new names for files and folders", () => {
  assert.equal(model.validateEntryName("Hades II.exe", "Windows"), "");
  assert.equal(model.validateEntryName("Отчёт (финал).pdf", "Darwin"), "");
  assert.equal(model.validateEntryName("back\\slash", "Darwin"), "", "backslash is a normal character on macOS");
  for (const [name, os] of [["", "Darwin"], ["   ", "Linux"], [".", "Darwin"], ["..", "Windows"], ["a/b", "Darwin"], ["a\\b", "Windows"], ["what?", "Windows"], ["CON", "Windows"], ["nul.txt", "Windows"], ["trailing.", "Windows"], ["x".repeat(256), "Darwin"]]) {
    assert.notEqual(model.validateEntryName(name, os), "", `${JSON.stringify(name)} on ${os}`);
  }
});

test("builds the path after a rename", () => {
  assert.equal(model.renamedPath("/Users/player/Games/Hades", "Hades II", "Darwin"), "/Users/player/Games/Hades II");
  assert.equal(model.renamedPath("C:\\Games\\old.exe", " new.exe ", "Windows"), "C:\\Games\\new.exe");
});

test("rewrites paths inside a renamed folder", () => {
  assert.equal(model.replacePathPrefix("/Users/player/Games/Hades/Hades.app", "/Users/player/Games", "/Users/player/Игры", "Darwin"), "/Users/player/Игры/Hades/Hades.app");
  assert.equal(model.replacePathPrefix("/Users/player/Games", "/Users/player/Games/", "/Users/player/Игры", "Darwin"), "/Users/player/Игры");
  assert.equal(model.replacePathPrefix("/Users/player/GamesOld/x", "/Users/player/Games", "/Users/player/Игры", "Darwin"), null, "not a child");
  assert.equal(model.replacePathPrefix("c:\\games\\hades\\hades.exe", "C:\\Games", "C:\\Игры", "Windows"), "C:\\Игры\\hades\\hades.exe");
  assert.equal(model.replacePathPrefix("D:\\Other", "C:\\Games", "C:\\Игры", "Windows"), null);
});
