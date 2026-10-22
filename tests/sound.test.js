const test = require("node:test");
const assert = require("node:assert/strict");
const sound = require("../resources/js/sound.js");

function fakeParam() {
  return {
    value: 0,
    events: [],
    setValueAtTime(value, time) { this.events.push(["set", value, time]); },
    exponentialRampToValueAtTime(value, time) { this.events.push(["ramp", value, time]); }
  };
}

function fakeContext(state = "running") {
  const context = {
    state,
    currentTime: 2,
    destination: {},
    oscillators: [],
    resumeCalls: 0,
    suspendCalls: 0,
    createGain() {
      return { gain: fakeParam(), connect() {}, disconnect() {} };
    },
    createOscillator() {
      const oscillator = {
        type: "",
        frequency: fakeParam(),
        connect() {},
        disconnect() {},
        start(time) { oscillator.startedAt = time; },
        stop(time) { oscillator.stoppedAt = time; }
      };
      context.oscillators.push(oscillator);
      return oscillator;
    },
    resume() {
      context.resumeCalls += 1;
      context.state = "running";
      return Promise.resolve();
    },
    suspend() {
      context.suspendCalls += 1;
      context.state = "suspended";
      return Promise.resolve();
    }
  };
  return context;
}

function createPlayer(context, overrides = {}) {
  let clock = 1000;
  const timers = [];
  let created = 0;
  const player = sound.createSoundPlayer({
    createContext: () => { created += 1; return context; },
    now: () => clock,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
    ...overrides
  });
  return {
    player,
    timers,
    advance(ms) { clock += ms; },
    get created() { return created; }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("exposes the navigation and click sounds", () => {
  assert.deepEqual(sound.SOUND_NAMES, ["move", "select", "back", "section"]);
});

test("schedules short synthesized tones for each sound", () => {
  const context = fakeContext();
  const { player } = createPlayer(context);
  assert.equal(player.play("move"), true);
  assert.equal(context.oscillators.length, 1);
  assert.equal(player.play("select"), true);
  assert.equal(context.oscillators.length, 3);
  for (const oscillator of context.oscillators) {
    assert.ok(oscillator.startedAt >= context.currentTime);
    assert.ok(oscillator.stoppedAt - oscillator.startedAt < 0.3);
  }
});

test("does nothing while disabled and never creates an audio context", () => {
  const context = fakeContext();
  const harness = createPlayer(context);
  harness.player.setEnabled(false);
  assert.equal(harness.player.isEnabled(), false);
  assert.equal(harness.player.play("select"), false);
  assert.equal(harness.created, 0);
  harness.player.setEnabled(true);
  assert.equal(harness.player.play("select"), true);
});

test("ignores unknown sounds and missing Web Audio support", () => {
  const context = fakeContext();
  assert.equal(createPlayer(context).player.play("explosion"), false);
  const { player } = createPlayer(null, { createContext: () => null });
  assert.equal(player.play("move"), false);
});

test("drops duplicate triggers of the same sound within one interaction", () => {
  const context = fakeContext();
  const harness = createPlayer(context);
  assert.equal(harness.player.play("select"), true);
  assert.equal(harness.player.play("select"), false);
  assert.equal(harness.player.play("move"), true);
  harness.advance(60);
  assert.equal(harness.player.play("select"), true);
});

test("resumes a suspended context and plays only fresh requests", async () => {
  const context = fakeContext("suspended");
  const harness = createPlayer(context);
  harness.player.play("move");
  await flush();
  assert.equal(context.resumeCalls, 1);
  assert.equal(context.oscillators.length, 1);

  context.state = "suspended";
  context.resume = () => new Promise(() => {});
  harness.advance(100);
  harness.player.play("move");
  harness.advance(500);
  await flush();
  assert.equal(context.oscillators.length, 1);
});

test("suspends the audio context when idle or when sounds are turned off", async () => {
  const context = fakeContext();
  const harness = createPlayer(context);
  harness.player.play("move");
  assert.equal(harness.timers.length, 1);
  harness.timers[0]();
  await flush();
  assert.equal(context.suspendCalls, 1);

  context.state = "running";
  harness.player.setEnabled(false);
  await flush();
  assert.equal(context.suspendCalls, 2);
});
