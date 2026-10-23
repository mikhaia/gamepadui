const test = require("node:test");
const assert = require("node:assert/strict");
const icons = require("../resources/js/app-icons.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 0);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ osName = "Windows", files = {} } = {}) {
  const log = [];
  const delivered = [];
  const timers = [];
  const processes = [];
  const cacheDir = icons.cacheDirectory(osName === "Windows" ? "C:\\Users\\P\\AppData\\Local" : "/Users/p/Library/Caches", osName);
  const loader = icons.createIconLoader({
    osName,
    cacheDir,
    now: () => NOW,
    stat: async (file) => {
      log.push(["stat", file]);
      if (!files[file]) throw new Error("NE_FS_NOPATHE");
      return files[file];
    },
    readUrl: async (file, fresh) => {
      log.push(["read", file, fresh]);
      return `blob:${file}#${fresh ? "new" : "cached"}`;
    },
    spawn: async (command, onEvent) => {
      const process = { id: 40 + processes.length, command, onEvent, writes: [], ended: false };
      processes.push(process);
      log.push(["spawn", process.id]);
      return { id: process.id };
    },
    write: async (id, text) => { processes.find((p) => p.id === id).writes.push(text); },
    end: async (id) => { processes.find((p) => p.id === id).ended = true; },
    onIcon: (path, url) => delivered.push([path, url]),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    warn: (...args) => log.push(["warn", args.join(" ")])
  });
  const fileFor = (path) => icons.cacheFileFor(cacheDir, path, osName);
  const requestsOf = (process) => process.writes.join("").split("\n").filter((line) => /^\d+ /.test(line)).map((line) => {
    const [id, path] = line.split(" ");
    return [Number(id), Buffer.from(path, "base64").toString("utf8")];
  });
  const reply = (process, messages) => process.onEvent({ action: "stdOut", data: messages.map((m) => JSON.stringify(m)).join("\n") + "\n" });
  return { loader, log, delivered, timers, processes, fileFor, requestsOf, reply };
}

test("picks which entries get real icons and where they are cached", () => {
  assert.equal(icons.wantsIcon("/Applications/Safari.app", "Darwin"), true);
  assert.equal(icons.wantsIcon("/Applications/Safari.app/", "Darwin"), true);
  assert.equal(icons.wantsIcon("C:\\Games\\Hades.EXE", "Windows"), true);
  assert.equal(icons.wantsIcon("C:\\Start Menu\\Steam\\Hades II.url", "Windows"), true);
  assert.equal(icons.wantsIcon("C:\\run.bat", "Windows"), false);
  assert.equal(icons.wantsIcon("/usr/bin/game", "Linux"), false);
  assert.equal(icons.wantsIcon("https://example.com/setup.exe", "Windows"), false);
  assert.equal(icons.wantsIcon("https://example.com/Some.app", "Darwin"), false);
  const dir = icons.cacheDirectory("C:\\Users\\P\\AppData\\Local\\", "Windows");
  assert.equal(dir, "C:\\Users\\P\\AppData\\Local\\GamePadUI\\icons-v2");
  assert.equal(icons.cacheFileFor(dir, "C:\\Games\\HADES.exe", "Windows"), icons.cacheFileFor(dir, "c:\\games\\hades.exe", "Windows"));
  assert.match(icons.cacheFileFor("/c", "/Applications/Café.app", "Darwin"), /^\/c\/[0-9a-f]{16}\.png$/);
  assert.notEqual(icons.hashText("/Applications/A.app"), icons.hashText("/Applications/B.app"));
});

test("chooses a default icon by the kind of path", () => {
  assert.equal(icons.defaultIconKind("https://store.steampowered.com"), "web");
  assert.equal(icons.defaultIconKind("http://localhost:8080/app"), "web");
  assert.equal(icons.defaultIconKind("steam://rungameid/1145360"), "link");
  assert.equal(icons.defaultIconKind("C:\\Start Menu\\Steam\\Hades II.url"), "link");
  assert.equal(icons.defaultIconKind("C:\\Games\\server.BAT"), "script");
  assert.equal(icons.defaultIconKind("/Users/player/run.command"), "script");
  assert.equal(icons.defaultIconKind("C:\\Games\\Hades.exe"), "app");
  assert.equal(icons.defaultIconKind("/Applications/Safari.app"), "app");
  assert.equal(icons.defaultIconKind("/usr/bin/game"), "app");
});

test("classifies cached files by age; an empty file marks a recent failure", () => {
  assert.equal(icons.cacheState(null, NOW), "missing");
  assert.equal(icons.cacheState({ size: 5000, modifiedAt: NOW - DAY }, NOW), "fresh");
  assert.equal(icons.cacheState({ size: 5000, modifiedAt: NOW - 8 * DAY }, NOW), "stale");
  assert.equal(icons.cacheState({ size: 0, modifiedAt: NOW - 3600_000 }, NOW), "failed");
  assert.equal(icons.cacheState({ size: 0, modifiedAt: NOW - 2 * DAY }, NOW), "missing");
});

test("Windows sends the extractor through stdin; the command line stays short for cmd.exe", () => {
  const spec = icons.buildProcess("Windows");
  assert.match(spec.command, /^powershell\.exe -NoProfile -NonInteractive -STA -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(spec.command.length < 1000);
  const script = Buffer.from(spec.preamble.trim(), "base64").toString("utf8");
  assert.match(script, /^\$extractorSource = @'\r?\n/);
  assert.match(script, /IShellItemImageFactory/);
  assert.match(script, /ExtractAssociatedIcon/);
  assert.match(script, /\$size = 128/);
  const mac = icons.buildProcess("Darwin");
  assert.match(mac.command, /^osascript -l JavaScript -e '/);
  assert.match(mac.command, /iconForFile/);
  assert.equal(mac.preamble, "");
  assert.equal(icons.buildProcess("Linux"), null);
});

test("encodes requests as ASCII lines and parses streamed answers", () => {
  const line = icons.encodeRequest(7, "C:\\Игры\\Hades II.url", "C:\\cache\\x.png");
  assert.match(line, /^7 [A-Za-z0-9+/=]+ [A-Za-z0-9+/=]+\n$/);
  assert.equal(Buffer.from(line.split(" ")[1], "base64").toString("utf8"), "C:\\Игры\\Hades II.url");
  const parser = icons.createLineParser();
  assert.deepEqual(parser.feed('{"id":1,"ok":tr'), []);
  assert.deepEqual(parser.feed('ue}\r\nundefined\n{"id":2,"ok":false}'), [{ id: 1, ok: true }]);
  assert.deepEqual(parser.flush(), [{ id: 2, ok: false }]);
});

test("uses a fresh cached icon without starting the extractor", async () => {
  const h = harness();
  const path = "C:\\Games\\Hades.exe";
  const file = icons.cacheFileFor(icons.cacheDirectory("C:\\Users\\P\\AppData\\Local", "Windows"), path, "Windows");
  const hh = harness({ files: { [file]: { size: 9000, modifiedAt: NOW - DAY } } });
  hh.loader.request(path);
  hh.loader.request("c:\\games\\HADES.exe");
  await tick();
  assert.deepEqual(hh.delivered, [[path, `blob:${file}#cached`]]);
  assert.equal(hh.loader.status(path), "ready");
  assert.equal(hh.loader.status("C:\\Other.exe"), "unknown");
  assert.equal(hh.loader.peek("C:\\GAMES\\hades.exe"), `blob:${file}#cached`);
  assert.equal(hh.processes.length, 0);
  assert.equal(hh.log.filter(([kind]) => kind === "stat").length, 1);
  assert.equal(h.processes.length, 0);
});

test("extracts missing icons in one batch, sending the script first", async () => {
  const h = harness();
  h.loader.request("C:\\Games\\Hades.exe");
  h.loader.request("C:\\Start Menu\\Steam.lnk");
  await tick();
  assert.equal(h.processes.length, 1);
  const process = h.processes[0];
  await tick();
  assert.equal(process.writes.length, 2);
  assert.match(Buffer.from(process.writes[0].trim(), "base64").toString("utf8"), /^\$extractorSource/);
  assert.deepEqual(h.requestsOf(process), [[1, "C:\\Games\\Hades.exe"], [2, "C:\\Start Menu\\Steam.lnk"]]);
  assert.equal(h.loader.status("C:\\Games\\Hades.exe"), "pending");
  h.reply(process, [{ id: 2, ok: true }, { id: 1, ok: false, error: "Access denied" }]);
  await tick();
  assert.deepEqual([...h.delivered].sort(), [
    ["C:\\Games\\Hades.exe", ""],
    ["C:\\Start Menu\\Steam.lnk", `blob:${h.fileFor("C:\\Start Menu\\Steam.lnk")}#new`]
  ]);
  assert.ok(h.log.some(([kind, text]) => kind === "warn" && /Access denied/.test(text)));
  assert.equal(h.loader.status("C:\\Games\\Hades.exe"), "none");
  assert.equal(h.loader.pending, 0);
});

test("shows a stale icon right away and replaces it after a refresh", async () => {
  const path = "/Applications/Safari.app";
  const file = icons.cacheFileFor(icons.cacheDirectory("/Users/p/Library/Caches", "Darwin"), path, "Darwin");
  const h = harness({ osName: "Darwin", files: { [file]: { size: 9000, modifiedAt: NOW - 30 * DAY } } });
  h.loader.request(path);
  await tick();
  await tick();
  assert.deepEqual(h.delivered, [[path, `blob:${file}#cached`]]);
  const process = h.processes[0];
  assert.match(process.command, /^osascript/);
  assert.deepEqual(h.requestsOf(process), [[1, path]]);
  h.reply(process, [{ id: 1, ok: true }]);
  await tick();
  assert.deepEqual(h.delivered.at(-1), [path, `blob:${file}#new`]);
});

test("does not retry an icon that failed recently", async () => {
  const path = "C:\\Broken.exe";
  const file = icons.cacheFileFor(icons.cacheDirectory("C:\\Users\\P\\AppData\\Local", "Windows"), path, "Windows");
  const h = harness({ files: { [file]: { size: 0, modifiedAt: NOW - 60_000 } } });
  h.loader.request(path);
  await tick();
  assert.deepEqual(h.delivered, [[path, ""]]);
  assert.equal(h.processes.length, 0);
});

test("ends the idle extractor and starts a new one for later requests", async () => {
  const h = harness();
  h.loader.request("C:\\A.exe");
  await tick();
  await tick();
  h.reply(h.processes[0], [{ id: 1, ok: true }]);
  await tick();
  h.timers.at(-1)();
  assert.equal(h.processes[0].ended, true);
  h.loader.request("C:\\B.exe");
  await tick();
  await tick();
  assert.equal(h.processes.length, 2);
  h.processes[0].onEvent({ action: "exit", data: 0 });
  assert.deepEqual(h.requestsOf(h.processes[1]), [[2, "C:\\B.exe"]]);
  h.reply(h.processes[1], [{ id: 2, ok: true }]);
  await tick();
  assert.equal(h.delivered.length, 2);
});

test("stops trying when the extractor exits without answering", async () => {
  const h = harness();
  h.loader.request("C:\\A.exe");
  await tick();
  await tick();
  h.processes[0].onEvent({ action: "stdErr", data: "powershell is blocked" });
  h.processes[0].onEvent({ action: "exit", data: 1 });
  h.loader.request("C:\\B.exe");
  await tick();
  assert.deepEqual(h.delivered, [["C:\\A.exe", ""], ["C:\\B.exe", ""]]);
  assert.equal(h.processes.length, 1);
});

test("does nothing on unsupported systems", async () => {
  const h = harness({ osName: "Linux" });
  h.loader.request("/usr/bin/game");
  await tick();
  assert.deepEqual(h.delivered, []);
  assert.equal(h.log.length, 0);
});
