const test = require("node:test");
const assert = require("node:assert/strict");
const images = require("../resources/js/remote-images.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let index = 0; index < 10; index += 1) await tick();
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode("<!doctype html><html><body>404</body></html>");
const bytes = (text) => new TextEncoder().encode(text);

function harness({ osName = "Darwin", existing = [], heads = {}, listError = false } = {}) {
  const directory = images.imagesDirectory(osName === "Windows" ? "C:\\Users\\P\\AppData\\Local" : "/Users/p/Library/Caches", osName);
  const separator = osName === "Windows" ? "\\" : "/";
  const log = [];
  const ready = [];
  const timers = [];
  const processes = [];
  const store = images.createRemoteImageStore({
    osName,
    directory,
    list: async (dir) => {
      log.push(["list", dir]);
      if (listError) throw new Error("NE_FS_NOPATHE");
      return existing.map((entry) => (typeof entry === "string" ? { entry, type: "FILE" } : entry));
    },
    readHead: async (file) => {
      log.push(["head", file]);
      const hash = file.slice(directory.length + 1, directory.length + 17);
      if (!(hash in heads)) throw new Error("NE_FS_FILRDER");
      return heads[hash];
    },
    move: async (from, to) => log.push(["move", from, to]),
    remove: async (file) => log.push(["remove", file]),
    spawn: async (command, onEvent) => {
      const process = { id: 70 + processes.length, command, onEvent, writes: [], ended: false, killed: false };
      processes.push(process);
      return process;
    },
    write: async (id, text) => processes.find((process) => process.id === id).writes.push(text),
    end: async (id) => {
      processes.find((process) => process.id === id).ended = true;
    },
    kill: async (id) => {
      processes.find((process) => process.id === id).killed = true;
    },
    onReady: (url, file) => ready.push([url, file]),
    setTimer: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length;
    },
    clearTimer: (id) => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    }
  });
  const fire = (ms) => timers.filter((timer) => timer.ms === ms && !timer.cleared).forEach((timer) => {
    timer.cleared = true;
    timer.callback();
  });
  const file = (name) => `${directory}${separator}${name}`;
  return { store, directory, file, log, ready, timers, processes, fire };
}

const A = "https://cdn.example.com/grid/a.png";
const B = "https://images.example.com/covers/b.jpg";
const C = "http://example.com/c.webp";
const hashA = images.cacheKey(A);
const hashB = images.cacheKey(B);
const hashC = images.cacheKey(C);

test("accepts only http(s) links and normalizes them for the downloader", () => {
  assert.equal(images.isDownloadable(A), true);
  assert.equal(images.isDownloadable("  http://example.com/x.jpg "), true);
  assert.equal(images.isDownloadable("/Users/p/cover.jpg"), false);
  assert.equal(images.isDownloadable("C:\\Covers\\a.png"), false);
  assert.equal(images.isDownloadable("data:image/png;base64,AAAA"), false);
  assert.equal(images.isDownloadable("https://"), false);
  assert.equal(images.isDownloadable("https://example.com/a\nb.png"), false);
  assert.equal(images.downloadUrl("https://example.com/my cover/обложка.jpg?a=1&b=2"),
    "https://example.com/my%20cover/%D0%BE%D0%B1%D0%BB%D0%BE%D0%B6%D0%BA%D0%B0.jpg?a=1&b=2");
  assert.match(images.encodeJob(hashA, A), /^[0-9a-f]{16} https:\/\/cdn\.example\.com\/grid\/a\.png\n$/);
  assert.equal(images.cacheKey(` ${A} `), hashA);
});

test("keeps the cache in the system cache folder", () => {
  assert.equal(images.imagesDirectory("C:\\Users\\P\\AppData\\Local\\", "Windows"), "C:\\Users\\P\\AppData\\Local\\GamePadUI\\images");
  assert.equal(images.imagesDirectory("/Users/p/Library/Caches", "Darwin"), "/Users/p/Library/Caches/GamePadUI/images");
});

test("recognizes images by their first bytes and rejects error pages", () => {
  assert.equal(images.sniffImageType(PNG), "png");
  assert.equal(images.sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), "jpg");
  assert.equal(images.sniffImageType(bytes("GIF89a......")), "gif");
  assert.equal(images.sniffImageType(bytes("RIFF\x24\x00\x00\x00WEBPVP8 ")), "webp");
  assert.equal(images.sniffImageType(bytes("\x00\x00\x00\x1cftypavif\x00\x00")), "avif");
  assert.equal(images.sniffImageType(bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "svg");
  assert.equal(images.sniffImageType(HTML), "");
  assert.equal(images.sniffImageType(bytes('{"error":"not found"}')), "");
  assert.equal(images.sniffImageType(new Uint8Array(0)), "");
  assert.equal(images.sniffImageType(null), "");
});

test("reads the cache folder: ready files by hash, leftovers to clean up", () => {
  const listing = images.readListing([
    { entry: `${hashA}.png`, type: "FILE" },
    { entry: `${hashA}.jpg`, type: "FILE" },
    { entry: `${hashB}.part`, type: "FILE" },
    { entry: "notes.txt", type: "FILE" },
    { entry: "0123456789abcdef.png", type: "DIRECTORY" }
  ]);
  assert.deepEqual([...listing.files], [[hashA, `${hashA}.png`]]);
  assert.deepEqual(listing.leftovers, [`${hashA}.jpg`, `${hashB}.part`]);
});

test("builds downloaders: curl/wget on macOS and Linux, PowerShell on Windows within cmd.exe limits", () => {
  const unix = images.buildDownloader("Darwin", "/Users/p/Library/Caches/GamePadUI/images").command;
  assert.match(unix, /^dir='\/Users\/p\/Library\/Caches\/GamePadUI\/images'; /);
  assert.match(unix, /curl -fsSL/);
  assert.match(unix, /wget -q/);
  assert.match(unix, /echo "ok \$hash"/);
  const odd = images.buildDownloader("Linux", "/home/o'neil/.cache/GamePadUI/images").command;
  assert.match(odd, /^dir='\/home\/o'"'"'neil\/\.cache\/GamePadUI\/images'; /);

  const directory = "C:\\Users\\Алекс O'Neil\\AppData\\Local\\GamePadUI\\images";
  const windows = images.buildDownloader("Windows", directory).command;
  assert.match(windows, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.ok(windows.length < 7000, `command is ${windows.length} characters`);
  const script = Buffer.from(windows.split(" ").pop(), "base64").toString("utf16le");
  assert.ok(script.includes("$dir = 'C:\\Users\\Алекс O''Neil\\AppData\\Local\\GamePadUI\\images'"));
  assert.ok(script.includes("[Console]::In.ReadLine()"));
  assert.equal(images.buildDownloader("Haiku", "/tmp"), null);
  assert.equal(images.buildDownloader("Darwin", ""), null);
});

test("serves a cached copy and does not download it again", async () => {
  const { store, file, processes, log } = harness({ existing: [`${hashA}.jpg`] });
  assert.equal(store.localPath(A), "");
  await store.load();
  assert.equal(store.localPath(A), file(`${hashA}.jpg`));
  assert.equal(store.localPath(`  ${A}`), file(`${hashA}.jpg`));
  assert.equal(store.localPath("/Users/p/cover.png"), "");
  store.sync([A, "/Users/p/cover.png", ""]);
  await settle();
  assert.equal(processes.length, 0);
  assert.equal(store.status(A), "ready");
  assert.deepEqual(log[0], ["list", store.directory]);
});

test("downloads missing images in one batch, checks the content and renames the file", async () => {
  const { store, file, processes, log, ready } = harness({ heads: { [hashA]: PNG, [hashB]: Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]) } });
  store.sync([A, B, A]);
  await settle();
  assert.equal(processes.length, 0, "waits for the cache folder listing");
  await store.load();
  await settle();
  assert.equal(processes.length, 1);
  const [process] = processes;
  assert.deepEqual(process.writes, [images.encodeJob(hashA, A) + images.encodeJob(hashB, B)]);
  assert.equal(process.ended, true);
  assert.equal(store.status(A), "downloading");

  process.onEvent({ action: "stdOut", data: `ok ${hashA}\nok ${hashB.slice(0, 2)}` });
  process.onEvent({ action: "stdOut", data: "" });
  await settle();
  assert.deepEqual(ready, [[A, file(`${hashA}.png`)]]);
  assert.equal(store.localPath(A), file(`${hashA}.png`));
  assert.ok(log.some((entry) => entry[0] === "move" && entry[1] === file(`${hashA}.part`) && entry[2] === file(`${hashA}.png`)));

  process.onEvent({ action: "stdOut", data: `${hashB.slice(2)}\r\n` });
  await settle();
  assert.deepEqual(ready[1], [B, file(`${hashB}.jpg`)]);
  process.onEvent({ action: "exit", data: 0 });
  await settle();
  assert.equal(store.pending, 0);
});

test("drops a download that is not an image and does not retry it in this session", async () => {
  const { store, file, processes, log, ready } = harness({ heads: { [hashA]: HTML } });
  await store.load();
  store.sync([A, C]);
  await settle();
  processes[0].onEvent({ action: "stdOut", data: `ok ${hashA}\nfail ${hashC} exit 22\n` });
  processes[0].onEvent({ action: "exit", data: 0 });
  await settle();
  assert.deepEqual(ready, []);
  assert.ok(log.some((entry) => entry[0] === "remove" && entry[1] === file(`${hashA}.part`)));
  assert.equal(store.status(A), "failed");
  assert.equal(store.status(C), "failed");
  store.sync([A, C]);
  await settle();
  assert.equal(processes.length, 1);
});

test("marks unanswered links as failed and stops when the downloader cannot run", async () => {
  const { store, processes } = harness();
  await store.load();
  store.sync([A]);
  await settle();
  processes[0].onEvent({ action: "stdErr", data: "mkdir: Permission denied" });
  processes[0].onEvent({ action: "exit", data: 1 });
  await settle();
  assert.equal(store.status(A), "failed");
  store.sync([A, B]);
  await settle();
  assert.equal(processes.length, 1, "no new process after a broken one");
  assert.equal(store.status(B), "none");
});

test("starts the next batch after the current one finishes", async () => {
  const many = Array.from({ length: images.BATCH_SIZE + 3 }, (_, index) => `https://example.com/${index}.png`);
  const heads = Object.fromEntries(many.map((url) => [images.cacheKey(url), PNG]));
  const { store, processes, ready } = harness({ heads });
  await store.load();
  store.sync(many);
  await settle();
  assert.equal(processes.length, 1);
  assert.equal(processes[0].writes[0].trim().split("\n").length, images.BATCH_SIZE);
  store.sync([...many, A]);
  await settle();
  assert.equal(processes.length, 1, "one downloader at a time");
  processes[0].onEvent({ action: "stdOut", data: many.slice(0, images.BATCH_SIZE).map((url) => `ok ${images.cacheKey(url)}\n`).join("") });
  processes[0].onEvent({ action: "exit", data: 0 });
  await settle();
  assert.equal(ready.length, images.BATCH_SIZE);
  assert.equal(processes.length, 2);
  assert.equal(processes[1].writes[0].trim().split("\n").length, 4);
});

test("skips links that stopped being used before their batch started", async () => {
  const { store, processes } = harness({ heads: { [hashA]: PNG } });
  await store.load();
  store.sync([A]);
  await settle();
  store.sync([B]);
  store.sync([C]);
  processes[0].onEvent({ action: "exit", data: 0 });
  await settle();
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[1].writes, [images.encodeJob(hashC, C)]);
});

test("stops a stalled downloader", async () => {
  const { store, processes, fire } = harness();
  await store.load();
  store.sync([A]);
  await settle();
  fire(images.STALL_MS);
  await settle();
  assert.equal(processes[0].killed, true);
  assert.equal(store.status(A), "failed");
});

test("cleans up files of links that are no longer used, but keeps the cache if nothing is used", async () => {
  const { store, file, log, fire } = harness({ existing: [`${hashA}.png`, `${hashB}.jpg`, `${hashC}.part`, "readme.txt"] });
  await store.load();
  fire(images.PRUNE_DELAY_MS);
  await settle();
  assert.equal(log.filter((entry) => entry[0] === "remove").length, 0, "nothing in use yet");

  store.sync([A]);
  fire(images.PRUNE_DELAY_MS);
  await settle();
  const removed = log.filter((entry) => entry[0] === "remove").map((entry) => entry[1]).sort();
  assert.deepEqual(removed, [file(`${hashB}.jpg`), file(`${hashC}.part`)].sort());
  assert.equal(store.localPath(B), "");
  assert.equal(store.localPath(A), file(`${hashA}.png`));
});

test("forgets a cached file that could not be read and downloads it again", async () => {
  const { store, processes } = harness({ existing: [`${hashA}.png`] });
  await store.load();
  store.sync([A]);
  await settle();
  assert.equal(processes.length, 0);
  store.forget(A);
  await settle();
  assert.equal(store.localPath(A), "");
  assert.equal(processes.length, 1);
});

test("works without a cache folder yet and on Windows paths", async () => {
  const { store, file, processes, ready } = harness({ osName: "Windows", listError: true, heads: { [hashA]: PNG } });
  await store.load();
  store.sync([A]);
  await settle();
  assert.match(processes[0].command, /^powershell\.exe /);
  processes[0].onEvent({ action: "stdOut", data: `ok ${hashA}\r\n` });
  await settle();
  assert.deepEqual(ready, [[A, file(`${hashA}.png`)]]);
  assert.match(file(`${hashA}.png`), /^C:\\Users\\P\\AppData\\Local\\GamePadUI\\images\\[0-9a-f]{16}\.png$/);
});
