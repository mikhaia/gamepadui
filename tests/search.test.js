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

test("finds any file in all-files mode and lists applications first", async () => {
  const tree = {
    "/Users/player/Downloads": [
      { entry: "Hades Manual.pdf", type: "FILE" },
      { entry: "Hades", type: "DIRECTORY" },
      { entry: "hades-cover.png", type: "FILE" }
    ],
    "/Users/player/Downloads/Hades": [
      { entry: "Hades.app", type: "DIRECTORY" },
      { entry: "run-hades.sh", type: "FILE" }
    ]
  };
  const options = {
    roots: ["/Users/player/Downloads"],
    query: "hades",
    osName: "Darwin",
    readDirectory: async (path) => tree[path] || [],
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  };
  const appsOnly = await search.find(options);
  assert.deepEqual(appsOnly.results.map((result) => result.name), ["Hades.app", "run-hades.sh"]);

  const allFiles = await search.find({ ...options, includeAllFiles: true });
  assert.deepEqual(allFiles.results.map((result) => [result.name, result.launchable]), [
    ["Hades.app", true],
    ["run-hades.sh", true],
    ["Hades Manual.pdf", false],
    ["hades-cover.png", false]
  ]);
});

test("skips hidden entries and never walks to the parent folder", async () => {
  const reads = [];
  const tree = {
    "C:\\Games": [
      { entry: ".", type: "DIRECTORY" },
      { entry: "..", type: "DIRECTORY" },
      { entry: ".git", type: "DIRECTORY" },
      { entry: ".hades-cache.exe", type: "FILE" },
      { entry: "Hades.exe", type: "FILE" }
    ]
  };
  const outcome = await search.find({
    roots: ["C:\\Games"],
    query: "hades",
    osName: "Windows",
    includeAllFiles: true,
    readDirectory: async (path) => { reads.push(path); return tree[path] || []; },
    joinPath: model.joinPath,
    isLaunchableEntry: model.isLaunchableEntry
  });
  assert.deepEqual(outcome.results.map((result) => result.path), ["C:\\Games\\Hades.exe"]);
  assert.deepEqual(reads, ["C:\\Games"]);
});
