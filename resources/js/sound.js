(function initSound(globalScope) {
  "use strict";

  const MASTER_VOLUME = 0.22;
  const REPEAT_GUARD_MS = 40;
  const STALE_REQUEST_MS = 150;
  const IDLE_SUSPEND_MS = 4000;

  // Короткие синтезированные сигналы: без аудиофайлов и сетевых зависимостей.
  const SOUNDS = {
    move: [
      { at: 0, from: 1568, to: 1397, duration: 0.045, gain: 0.32, wave: "sine" }
    ],
    select: [
      { at: 0, from: 880, to: 880, duration: 0.07, gain: 0.5, wave: "triangle" },
      { at: 0.045, from: 1318.5, to: 1318.5, duration: 0.11, gain: 0.42, wave: "triangle" }
    ],
    back: [
      { at: 0, from: 1046.5, to: 1046.5, duration: 0.07, gain: 0.45, wave: "triangle" },
      { at: 0.045, from: 698.5, to: 698.5, duration: 0.11, gain: 0.4, wave: "triangle" }
    ],
    section: [
      { at: 0, from: 523.3, to: 784, duration: 0.12, gain: 0.42, wave: "sine" },
      { at: 0, from: 1046.5, to: 1568, duration: 0.12, gain: 0.12, wave: "sine" }
    ]
  };

  function defaultContextFactory() {
    const AudioContextClass = globalScope.AudioContext || globalScope.webkitAudioContext;
    return AudioContextClass ? new AudioContextClass({ latencyHint: "interactive" }) : null;
  }

  function defaultNow() {
    return globalScope.performance?.now ? globalScope.performance.now() : Date.now();
  }

  function defaultSetTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer?.unref?.();
    return timer;
  }

  function createSoundPlayer(options = {}) {
    const {
      createContext = defaultContextFactory,
      now = defaultNow,
      setTimer = defaultSetTimer,
      clearTimer = clearTimeout,
      volume = MASTER_VOLUME
    } = options;

    let enabled = true;
    let context = null;
    let output = null;
    let idleTimer = null;
    let resumePromise = null;
    const lastPlayedAt = new Map();

    function ensureContext() {
      if (context) return context;
      try {
        context = createContext();
      } catch (error) {
        context = null;
      }
      if (!context) return null;
      output = context.createGain();
      output.gain.value = volume;
      output.connect(context.destination);
      return context;
    }

    function resumeContext() {
      if (!resumePromise) {
        resumePromise = Promise.resolve()
          .then(() => context.resume())
          .catch(() => {})
          .then(() => { resumePromise = null; });
      }
      return resumePromise;
    }

    function cancelIdleSuspend() {
      if (idleTimer === null) return;
      clearTimer(idleTimer);
      idleTimer = null;
    }

    function suspendContext() {
      if (context?.state === "running") Promise.resolve().then(() => context.suspend()).catch(() => {});
    }

    // Простаивающий AudioContext держит аудиоустройство открытым, пока лаунчер висит в фоне.
    function scheduleIdleSuspend() {
      cancelIdleSuspend();
      idleTimer = setTimer(() => {
        idleTimer = null;
        suspendContext();
      }, IDLE_SUSPEND_MS);
    }

    function scheduleTone(tone, startTime) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const begin = startTime + tone.at;
      const end = begin + tone.duration;
      oscillator.type = tone.wave;
      oscillator.frequency.setValueAtTime(tone.from, begin);
      if (tone.to !== tone.from) oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
      envelope.gain.setValueAtTime(0.0001, begin);
      envelope.gain.exponentialRampToValueAtTime(tone.gain, begin + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(envelope);
      envelope.connect(output);
      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(begin);
      oscillator.stop(end + 0.02);
    }

    function scheduleSound(tones) {
      const startTime = context.currentTime + 0.01;
      tones.forEach((tone) => scheduleTone(tone, startTime));
      scheduleIdleSuspend();
    }

    function play(name) {
      const tones = SOUNDS[name];
      if (!enabled || !tones) return false;
      const requestedAt = now();
      if (requestedAt - (lastPlayedAt.get(name) ?? Number.NEGATIVE_INFINITY) < REPEAT_GUARD_MS) return false;
      if (!ensureContext()) return false;
      lastPlayedAt.set(name, requestedAt);

      if (context.state === "running") {
        scheduleSound(tones);
        return true;
      }

      // Пока контекст не запущен (например, до первого действия пользователя), звуки не копятся:
      // после запуска проигрывается только свежий запрос.
      resumeContext().then(() => {
        if (enabled && context.state === "running" && now() - requestedAt < STALE_REQUEST_MS) scheduleSound(tones);
      });
      return true;
    }

    function setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        cancelIdleSuspend();
        suspendContext();
      }
    }

    function isEnabled() {
      return enabled;
    }

    return { isEnabled, play, setEnabled };
  }

  const defaultPlayer = createSoundPlayer();
  const api = {
    SOUND_NAMES: Object.keys(SOUNDS),
    createSoundPlayer,
    isEnabled: defaultPlayer.isEnabled,
    play: defaultPlayer.play,
    setEnabled: defaultPlayer.setEnabled
  };

  globalScope.GamePadSound = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
