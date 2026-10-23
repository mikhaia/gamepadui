const test = require("node:test");
const assert = require("node:assert/strict");
const { createImageCache, isRemoteImage } = require("../resources/js/image-cache.js");

function setup({ fail = new Set() } = {}) {
  const reads = [];
  const revoked = [];
  const pending = [];
  let counter = 0;
  const cache = createImageCache({
    read: (path) => {
      reads.push(path);
      if (fail.has(path)) return Promise.reject(new Error(`missing ${path}`));
      return new Promise((resolve) => pending.push(() => resolve({ path })));
    },
    createUrl: (blob) => `blob:${blob.path}#${++counter}`,
    revokeUrl: (url) => revoked.push(url)
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const flush = async () => {
    await tick();
    while (pending.length) pending.shift()();
    await tick();
  };
  return { cache, reads, revoked, flush };
}

test("reads each file once and shares a read that is still in flight", async () => {
  const { cache, reads, flush } = setup();
  const first = cache.get("C:\\Covers\\hades.png");
  const second = cache.get("C:\\Covers\\hades.png");
  assert.equal(cache.peek("C:\\Covers\\hades.png"), "");
  await flush();
  assert.equal(await first, "blob:C:\\Covers\\hades.png#1");
  assert.equal(await second, "blob:C:\\Covers\\hades.png#1");
  assert.equal(await cache.get("C:\\Covers\\hades.png"), "blob:C:\\Covers\\hades.png#1");
  assert.equal(cache.peek("C:\\Covers\\hades.png"), "blob:C:\\Covers\\hades.png#1");
  assert.deepEqual(reads, ["C:\\Covers\\hades.png"]);
});

test("passes links through without reading or caching them", async () => {
  const { cache, reads } = setup();
  assert.equal(await cache.get("https://example.com/cover.jpg"), "https://example.com/cover.jpg");
  assert.equal(cache.peek("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(await cache.get(""), "");
  assert.equal(cache.size, 0);
  assert.deepEqual(reads, []);
  assert.equal(isRemoteImage("HTTP://x"), true);
  assert.equal(isRemoteImage("/Users/player/bg.png"), false);
});

test("fresh rereads the file and revokes the old URL only on the next retain", async () => {
  const { cache, reads, revoked, flush } = setup();
  cache.get("/bg.png");
  await flush();
  const refreshed = cache.get("/bg.png", { fresh: true });
  await flush();
  assert.equal(await refreshed, "blob:/bg.png#2");
  assert.deepEqual(reads, ["/bg.png", "/bg.png"]);
  assert.deepEqual(revoked, []);
  cache.retain(["/bg.png"]);
  assert.deepEqual(revoked, ["blob:/bg.png#1"]);
  assert.equal(cache.peek("/bg.png"), "blob:/bg.png#2");
});

test("retain revokes URLs of paths that are no longer used", async () => {
  const { cache, revoked, flush } = setup();
  cache.get("/a.png");
  cache.get("/b.png");
  await flush();
  cache.retain(["/a.png", "", null]);
  assert.deepEqual(revoked, ["blob:/b.png#2"]);
  assert.equal(cache.size, 1);
  assert.equal(cache.peek("/b.png"), "");
});

test("a read that finishes after its path was dropped is revoked on the next retain", async () => {
  const { cache, revoked, flush } = setup();
  const late = cache.get("/late.png");
  cache.retain([]);
  await flush();
  assert.equal(await late, "blob:/late.png#1");
  assert.equal(cache.peek("/late.png"), "");
  assert.deepEqual(revoked, []);
  cache.retain([]);
  assert.deepEqual(revoked, ["blob:/late.png#1"]);
});

test("failed reads are not cached", async () => {
  const { cache, reads } = setup({ fail: new Set(["/missing.png"]) });
  await assert.rejects(cache.get("/missing.png"), /missing/);
  await assert.rejects(cache.get("/missing.png"), /missing/);
  assert.equal(cache.size, 0);
  assert.deepEqual(reads, ["/missing.png", "/missing.png"]);
});
