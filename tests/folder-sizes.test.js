const test = require("node:test");
const assert = require("node:assert/strict");
const folderSizes = require("../resources/js/folder-sizes.js");
const model = require("../resources/js/model.js");

const decode = (command) => Buffer.from(command.split(" ").pop(), "base64").toString("utf16le");

test("builds a du command on macOS and Linux and a PowerShell scan on Windows", () => {
  assert.equal(folderSizes.buildCommand("/Users/player/Bob's Games/", "Darwin"), "du -k -x -d 1 '/Users/player/Bob'\"'\"'s Games'");
  assert.equal(folderSizes.buildCommand("/", "Linux"), "du -k -x -d 1 '/'");
  const windows = folderSizes.buildCommand("C:\\Users\\Player\\", "Windows");
  assert.match(windows, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  const script = decode(windows);
  assert.match(script, /DirectoryInfo\]::new\('C:\\Users\\Player'\)/);
  assert.match(script, /ReparsePoint/);
  assert.match(script, /ElapsedMilliseconds -gt 8000/);
  assert.equal(folderSizes.buildCommand("", "Darwin"), "");
  assert.equal(folderSizes.buildCommand("/tmp", "Browser"), "");
});

test("parses du output split into arbitrary chunks and skips the parent total", () => {
  const parser = folderSizes.createParser("Darwin", "/Users/player/Downloads/");
  const output = "1024\t/Users/player/Downloads/Games\n8\t/Users/player/Downloads/Empty Folder\n2048\t/Users/player/Downloads/Steam.app\n4000\t/Users/player/Downloads\n";
  const results = [];
  for (let index = 0; index < output.length; index += 7) results.push(...parser.feed(output.slice(index, index + 7)));
  results.push(...parser.flush());
  assert.deepEqual(results, [
    { name: "Games", size: 1048576, partial: false },
    { name: "Empty Folder", size: 8192, partial: false },
    { name: "Steam.app", size: 2097152, partial: false }
  ]);
});

test("parses du output for the filesystem root", () => {
  const parser = folderSizes.createParser("Linux", "/");
  assert.deepEqual(parser.feed("12\t/usr\n99\t/\n"), [{ name: "usr", size: 12288, partial: false }]);
});

test("parses streamed PowerShell results, including escaped Cyrillic names and partial sizes", () => {
  const parser = folderSizes.createParser("Windows", "C:\\Users\\Player");
  const first = parser.feed('{"name":"Games","size":5368709120,"partial":false}\r\n{"name":"\\u0418\\u0433\\u0440\\u044b","si');
  const second = parser.feed('ze":1000,"partial":true}\r\nnoise\r\n');
  assert.deepEqual([...first, ...second], [
    { name: "Games", size: 5368709120, partial: false },
    { name: "Игры", size: 1000, partial: true }
  ]);
});

test("sorts folders by their computed size when it is known", () => {
  const entries = [
    { entry: "Small", type: "DIRECTORY" },
    { entry: "Big", type: "DIRECTORY" },
    { entry: "Pending", type: "DIRECTORY" },
    { entry: "Huge.app", type: "DIRECTORY" },
    { entry: "file.iso", type: "FILE" }
  ];
  const stats = new Map([
    ["Small", { size: 4096, folderSize: 10 }],
    ["Big", { size: 4096, folderSize: 9000 }],
    ["Huge.app", { size: 96, folderSize: 5_000_000 }],
    ["file.iso", { size: 1_000_000 }]
  ]);
  assert.deepEqual(model.sortEntries(entries, "Darwin", { sort: "size", stats }).map((entry) => entry.entry), ["Big", "Small", "Pending", "Huge.app", "file.iso"]);
});
