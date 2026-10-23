const test = require("node:test");
const assert = require("node:assert/strict");
const idle = require("../resources/js/idle-screen.js");

test("understands the usual YouTube links", () => {
  const id = "dQw4w9WgXcQ";
  const video = (videoId, playlistId = "", start = 0) => ({ videoId, playlistId, start });
  assert.deepEqual(idle.parseYouTubeUrl(`https://www.youtube.com/watch?v=${id}`), video(id));
  assert.deepEqual(idle.parseYouTubeUrl(`youtube.com/watch?v=${id}&t=1m30s`), video(id, "", 90));
  assert.deepEqual(idle.parseYouTubeUrl(`https://youtu.be/${id}?t=42`), video(id, "", 42));
  assert.deepEqual(idle.parseYouTubeUrl(`https://m.youtube.com/shorts/${id}`), video(id));
  assert.deepEqual(idle.parseYouTubeUrl(`https://www.youtube.com/live/${id}?si=abc`), video(id));
  assert.deepEqual(idle.parseYouTubeUrl(`https://www.youtube-nocookie.com/embed/${id}?start=10`), video(id, "", 10));
  assert.deepEqual(idle.parseYouTubeUrl(`https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`), video(id, `RDAMVM${id}`));
  assert.deepEqual(idle.parseYouTubeUrl("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"), video("", "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"));
  assert.deepEqual(idle.parseYouTubeUrl(id), video(id));
  assert.equal(idle.parseYouTubeUrl("https://vimeo.com/123456"), null);
  assert.equal(idle.parseYouTubeUrl("https://www.youtube.com/watch?v=short"), null);
  assert.equal(idle.parseYouTubeUrl("https://evil.example/youtube.com/watch?v=" + id), null);
  assert.equal(idle.parseYouTubeUrl(""), null);
  assert.equal(idle.parseStart("1h2m3s"), 3723);
  assert.equal(idle.parseStart("abc"), 0);
});

test("builds a muted looping embed that accepts commands", () => {
  const single = new URL(idle.youtubeEmbedUrl({ videoId: "dQw4w9WgXcQ", playlistId: "", start: 90 }, { origin: "http://127.0.0.1:52011" }));
  assert.equal(single.origin, "https://www.youtube-nocookie.com");
  assert.equal(single.pathname, "/embed/dQw4w9WgXcQ");
  assert.equal(single.searchParams.get("mute"), "1");
  assert.equal(single.searchParams.get("autoplay"), "1");
  assert.equal(single.searchParams.get("loop"), "1");
  assert.equal(single.searchParams.get("playlist"), "dQw4w9WgXcQ");
  assert.equal(single.searchParams.get("enablejsapi"), "1");
  assert.equal(single.searchParams.get("controls"), "0");
  assert.equal(single.searchParams.get("start"), "90");
  assert.equal(single.searchParams.get("origin"), "http://127.0.0.1:52011");
  const list = new URL(idle.youtubeEmbedUrl({ videoId: "", playlistId: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", start: 0 }, { origin: "null" }));
  assert.equal(list.pathname, "/embed/videoseries");
  assert.equal(list.searchParams.get("list"), "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
  assert.equal(list.searchParams.has("origin"), false);
  assert.equal(idle.youtubeEmbedUrl(null), "");
});

test("reads the player messages", () => {
  assert.deepEqual(idle.readPlayerMessage('{"event":"onReady","id":1,"channel":"widget"}'), { ready: true, state: null, error: null, autoplayBlocked: false });
  assert.equal(idle.readPlayerMessage('{"event":"infoDelivery","info":{"playerState":1,"currentTime":3}}').state, 1);
  assert.equal(idle.readPlayerMessage({ event: "onStateChange", info: 2 }).state, 2);
  assert.equal(idle.readPlayerMessage('{"event":"onError","info":150}').error, 150);
  assert.equal(idle.readPlayerMessage('{"event":"onAutoplayBlocked"}').autoplayBlocked, true);
  assert.equal(idle.readPlayerMessage("not json"), null);
  assert.equal(idle.readPlayerMessage({ type: "other" }), null);
  assert.deepEqual(JSON.parse(idle.playerCommand("setVolume", [100])), { event: "command", func: "setVolume", args: [100], id: 1, channel: "widget" });
  assert.match(idle.youtubeErrorText(150), /запретил/);
  assert.match(idle.youtubeErrorText(5), /ошибка 5/);
});

test("normalizes the screensaver settings", () => {
  assert.deepEqual(idle.normalizeIdleSettings({}), { timeout: 0, source: "launcher", imagePath: "", youtubeUrl: "", sound: false, clockPosition: "center" });
  assert.deepEqual(idle.normalizeIdleSettings({ idleTimeout: "5", idleSource: "youtube", idleYoutubeUrl: " https://youtu.be/dQw4w9WgXcQ ", idleSound: true, idleClockPosition: "bottom-right" }),
    { timeout: 5, source: "youtube", imagePath: "", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", sound: true, clockPosition: "bottom-right" });
  assert.equal(idle.normalizeIdleSettings({ idleTimeout: 7 }).timeout, 0);
  assert.equal(idle.normalizeIdleSettings({ idleSource: "vimeo", idleClockPosition: "middle" }).source, "launcher");
});
