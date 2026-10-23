(function initNavigation(globalScope) {
  "use strict";

  const BUTTONS = {
    0: "accept",
    1: "back",
    2: "options",
    3: "search",
    4: "previous-section",
    5: "next-section",
    8: "apps",
    9: "menu",
    12: "up",
    13: "down",
    14: "left",
    15: "right"
  };
  const DIRECTION_VECTORS = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0]
  };

  let activeElement = null;
  let previousButtons = [];
  let axisState = { horizontal: 0, vertical: 0, changedAt: 0 };
  let rafId = 0;
  let pollTimer = 0;
  let running = false;
  let lastGamepadName = "";
  // Окно лаунчера активно (его сообщают события windowFocus/windowBlur от Neutralino).
  // Пока оно в фоне — например, во время игры, — нажатия на геймпаде не должны ничего делать в лаунчере.
  let windowActive = true;
  // После возврата в лаунчер стик, отклонённый ещё в игре, не должен листать меню, пока его не отпустят.
  let stickLatched = false;
  const BACKGROUND_POLL_MS = 250;

  function visibleFocusableElements() {
    const modal = document.getElementById("modal-layer");
    // Открытая боковая панель или выпадающее меню (data-focus-root) удерживает фокус внутри себя.
    const panel = document.querySelector("[data-focus-root].is-open");
    let root = document;
    if (modal && !modal.hidden) root = document.getElementById("modal");
    else if (panel) root = panel;

    return [...root.querySelectorAll("[data-focusable]")].filter((element) => {
      const style = globalScope.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hiddenByParent = element.closest('[aria-hidden="true"], [hidden]');
      const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < globalScope.innerWidth && rect.top < globalScope.innerHeight;
      const canScrollIntoView = root !== document;
      return !element.disabled && !element.hidden && !hiddenByParent && (onScreen || canScrollIntoView) && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function setFocus(element, options = {}) {
    if (!element) return;
    if (activeElement && activeElement !== element) activeElement.classList.remove("is-focused");
    activeElement = element;
    element.classList.add("is-focused");
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
    if (options.scroll !== false) element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    element.dispatchEvent(new CustomEvent("gamepad-focus", { bubbles: true, detail: { source: options.source || "program" } }));
  }

  function ensureFocus() {
    const elements = visibleFocusableElements();
    if (elements.includes(activeElement)) return;
    // Элементы с data-autofocus-skip (например, кнопка сайдбара) не получают фокус автоматически.
    setFocus(elements.find((element) => !element.hasAttribute("data-autofocus-skip")) || elements[0], { scroll: false });
  }

  function move(direction) {
    const elements = visibleFocusableElements();
    if (!elements.length) return;
    if (!elements.includes(activeElement)) {
      setFocus(elements[0], { source: "move" });
      return;
    }

    const [directionX, directionY] = DIRECTION_VECTORS[direction];
    const currentRect = activeElement.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of elements) {
      if (candidate === activeElement) continue;
      const rect = candidate.getBoundingClientRect();
      const deltaX = rect.left + rect.width / 2 - currentX;
      const deltaY = rect.top + rect.height / 2 - currentY;
      const forward = deltaX * directionX + deltaY * directionY;
      if (forward <= 6) continue;
      const perpendicular = Math.abs(deltaX * directionY - deltaY * directionX);
      // Элементы «на одной линии» с текущим (пересекаются с ним по высоте при движении влево/вправо
      // или по ширине при движении вверх/вниз) получают преимущество — так фокус не «съезжает» в соседний ряд.
      const inBeam = directionX !== 0
        ? rect.top < currentRect.bottom && rect.bottom > currentRect.top
        : rect.left < currentRect.right && rect.right > currentRect.left;
      const score = (forward + perpendicular * 2.4) * (inBeam ? 0.6 : 1);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best) setFocus(best, { source: "move" });
  }

  function dispatch(action) {
    document.dispatchEvent(new CustomEvent("gamepad-action", { detail: { action } }));
  }

  function accept() {
    ensureFocus();
    if (activeElement) activeElement.click();
  }

  function handleAction(action) {
    if (DIRECTION_VECTORS[action]) move(action);
    else if (action === "accept") accept();
    else dispatch(action);
  }

  function isTypingTarget(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  }

  function onKeyDown(event) {
    if (event.code === "Space" && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      if (event.repeat) return;
      handleAction("apps");
      document.dispatchEvent(new CustomEvent("input-mode", { detail: { type: "keyboard" } }));
      return;
    }

    if (isTypingTarget(event.target)) {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch("back");
      }
      return;
    }

    const mapping = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Enter: "accept",
      Escape: "back",
      Backspace: "back",
      x: "options",
      X: "options",
      y: "search",
      Y: "search",
      q: "previous-section",
      Q: "previous-section",
      e: "next-section",
      E: "next-section",
      m: "menu",
      M: "menu"
    };
    const action = mapping[event.key];
    if (!action) return;
    event.preventDefault();
    handleAction(action);
    document.dispatchEvent(new CustomEvent("input-mode", { detail: { type: "keyboard" } }));
  }

  function onPointerDown(event) {
    const focusable = event.target.closest("[data-focusable]");
    if (focusable) setFocus(focusable, { scroll: false });
  }

  function onPointerClick() {
    document.dispatchEvent(new CustomEvent("input-mode", { detail: { type: "mouse" } }));
  }

  function readGamepad() {
    const gamepads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return gamepads[0] || null;
  }

  function stickDirection(gamepad) {
    return {
      horizontal: Math.abs(gamepad.axes[0] || 0) > 0.62 ? Math.sign(gamepad.axes[0]) : 0,
      vertical: Math.abs(gamepad.axes[1] || 0) > 0.62 ? Math.sign(gamepad.axes[1]) : 0
    };
  }

  function inputAllowed() {
    return windowActive && document.visibilityState !== "hidden";
  }

  // Запоминаем, что зажато прямо сейчас: кнопка, которую держат с момента игры, не сработает как новое нажатие.
  function absorbGamepadState(now, gamepad = readGamepad()) {
    previousButtons = gamepad ? gamepad.buttons.map((button) => button.pressed) : [];
    const { horizontal, vertical } = gamepad ? stickDirection(gamepad) : { horizontal: 0, vertical: 0 };
    axisState = { horizontal, vertical, changedAt: now };
    stickLatched = Boolean(horizontal || vertical);
  }

  // Пока окно активно — опрос каждый кадр, в фоне — 4 раза в секунду, только чтобы знать текущее состояние.
  function schedulePoll() {
    if (!running) return;
    if (inputAllowed()) rafId = globalScope.requestAnimationFrame(pollGamepads);
    else pollTimer = globalScope.setTimeout(() => pollGamepads(globalScope.performance.now()), BACKGROUND_POLL_MS);
  }

  function restartPolling() {
    globalScope.cancelAnimationFrame(rafId);
    globalScope.clearTimeout(pollTimer);
    schedulePoll();
  }

  function setWindowActive(active) {
    const next = Boolean(active);
    if (next === windowActive) return;
    windowActive = next;
    absorbGamepadState(globalScope.performance.now());
    restartPolling();
  }

  function onVisibilityChange() {
    absorbGamepadState(globalScope.performance.now());
    restartPolling();
  }

  function pollGamepads(now) {
    const gamepad = readGamepad();
    if (gamepad) {
      if (lastGamepadName !== gamepad.id) {
        lastGamepadName = gamepad.id;
        document.dispatchEvent(new CustomEvent("gamepad-connected", { detail: { id: gamepad.id } }));
      }

      if (!inputAllowed()) {
        absorbGamepadState(now, gamepad);
      } else {
        gamepad.buttons.forEach((button, index) => {
          if (button.pressed && !previousButtons[index] && BUTTONS[index]) {
            handleAction(BUTTONS[index]);
            document.dispatchEvent(new CustomEvent("input-mode", { detail: { type: "gamepad", id: gamepad.id } }));
          }
        });
        previousButtons = gamepad.buttons.map((button) => button.pressed);

        const { horizontal, vertical } = stickDirection(gamepad);
        if (stickLatched) {
          if (!horizontal && !vertical) stickLatched = false;
          axisState = { horizontal, vertical, changedAt: now };
        } else {
          const directionChanged = horizontal !== axisState.horizontal || vertical !== axisState.vertical;
          const repeatReady = now - axisState.changedAt > 230;
          if ((directionChanged || repeatReady) && (horizontal || vertical)) {
            const direction = Math.abs(horizontal) >= Math.abs(vertical)
              ? (horizontal > 0 ? "right" : "left")
              : (vertical > 0 ? "down" : "up");
            move(direction);
            axisState = { horizontal, vertical, changedAt: now };
            document.dispatchEvent(new CustomEvent("input-mode", { detail: { type: "gamepad", id: gamepad.id } }));
          } else if (!horizontal && !vertical) {
            axisState = { horizontal: 0, vertical: 0, changedAt: now };
          }
        }
      }
    } else {
      previousButtons = [];
      if (lastGamepadName) {
        lastGamepadName = "";
        document.dispatchEvent(new CustomEvent("gamepad-disconnected"));
      }
    }

    schedulePoll();
  }

  function init() {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onPointerClick);
    document.addEventListener("focusin", (event) => {
      const focusable = event.target.closest?.("[data-focusable]");
      if (focusable) setFocus(focusable, { scroll: false });
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    ensureFocus();
    running = true;
    absorbGamepadState(globalScope.performance.now());
    schedulePoll();
  }

  function destroy() {
    running = false;
    globalScope.cancelAnimationFrame(rafId);
    globalScope.clearTimeout(pollTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("click", onPointerClick);
  }

  globalScope.GamePadNavigation = { destroy, ensureFocus, init, isWindowActive: () => windowActive, move, setFocus, setWindowActive };
})(window);
