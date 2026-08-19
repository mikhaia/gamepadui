const test = require("node:test");
const assert = require("node:assert/strict");
const search = require("../resources/js/search.js");
const model = require("../resources/js/model.js");

test("requires at least three trimmed characters before reading directories", async () => {
  let reads = 0;
  const outcome = await search.find({
    roots: ["C:\\Games"],
    query: "ha",
    osName: "Windows",
    readDirectory: async () => { reads += 1; return []; },
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  });
  assert.equal(reads, 0);
  assert.deepEqual(outcome.results, []);
  assert.equal(search.isQueryReady("  had  "), true);
});

test("recursively finds launchable entries and ignores unsupported files", async () => {
  const tree = {
    "C:\\Games": [
      { entry: "Hades", type: "DIRECTORY" },
      { entry: "Hades Manual.pdf", type: "FILE" },
      { entry: "Celeste.exe", type: "FILE" }
    ],
    "C:\\Games\\Hades": [
      { entry: "Hades.exe", type: "FILE" },
      { entry: "Hades.url", type: "FILE" }
    ]
  };
  const outcome = await search.find({
    roots: ["C:\\Games"],
    query: "hades",
    osName: "Windows",
    readDirectory: async (path) => tree[path] || [],
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  });
  assert.deepEqual(outcome.results.map((result) => result.path), [
    "C:\\Games\\Hades\\Hades.exe",
    "C:\\Games\\Hades\\Hades.url"
  ]);
  assert.equal(outcome.directoriesScanned, 2);
});

test("returns a macOS app bundle as a result without traversing inside it", async () => {
  const reads = [];
  const outcome = await search.find({
    roots: ["/Applications"],
    query: "arc",
    osName: "Darwin",
    readDirectory: async (path) => {
      reads.push(path);
      return path === "/Applications" ? [{ entry: "Arcade.app", type: "DIRECTORY" }] : [];
    },
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  });
  assert.deepEqual(outcome.results.map((result) => result.path), ["/Applications/Arcade.app"]);
  assert.deepEqual(reads, ["/Applications"]);
});

test("does not match every file merely because the root folder contains the query", async () => {
  const outcome = await search.find({
    roots: ["C:\\Games"],
    query: "games",
    osName: "Windows",
    readDirectory: async () => [{ entry: "Unrelated.exe", type: "FILE" }],
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  });
  assert.deepEqual(outcome.results, []);
});
