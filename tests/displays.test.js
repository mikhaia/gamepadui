const test = require("node:test");
const assert = require("node:assert/strict");
const displays = require("../resources/js/displays.js");

const decode = (command) => Buffer.from(command.split(" ").pop(), "base64").toString("utf16le");

test("builds a monitor query for each platform", () => {
  const windows = displays.buildQueryCommand("Windows");
  assert.match(windows, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /);
  assert.match(decode(windows), /System\.Windows\.Forms\.Screen\]::AllScreens/);
  assert.match(decode(windows), /SetProcessDpiAwarenessContext/);
  const mac = displays.buildQueryCommand("Darwin");
  assert.match(mac, /^osascript -l JavaScript -e '/);
  assert.match(mac, /NSScreen\.screens/);
  assert.equal(displays.buildQueryCommand("Linux"), "xrandr --listmonitors");
  assert.equal(displays.buildQueryCommand("Browser"), "");
});

test("parses Windows screens, including a single screen object", () => {
  const list = displays.parseDisplays('[{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":2560,"height":1440},{"name":"\\\\\\\\.\\\\DISPLAY2","primary":false,"x":2560,"y":-200,"width":1920,"height":1080}]', "Windows");
  assert.deepEqual(list.map((display) => [display.label, display.primary, display.x, display.y, display.width]), [
    ["Монитор 1", true, 0, 0, 2560],
    ["Монитор 2", false, 2560, -200, 1920]
  ]);
  const single = displays.parseDisplays('{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":1920,"height":1080}', "Windows");
  assert.equal(single.length, 1);
});

test("converts macOS screen frames to top-left window coordinates and pixel resolution", () => {
  const output = JSON.stringify([
    { name: "Built-in Retina Display", x: 0, y: 0, width: 1470, height: 956, scale: 2 },
    { name: "DELL U2720Q", x: 1470, y: -124, width: 1920, height: 1080, scale: 1 },
    { name: "", x: 0, y: 956, width: 1280, height: 720, scale: 1 }
  ]);
  const list = displays.parseDisplays(output, "Darwin");
  assert.deepEqual(list.map((display) => [display.label, display.primary, display.x, display.y, display.pixelWidth, display.pixelHeight]), [
    ["Built-in Retina Display", true, 0, 0, 2940, 1912],
    ["DELL U2720Q", false, 1470, 0, 1920, 1080],
    ["Монитор 3", false, 0, -720, 1280, 720]
  ]);
  assert.deepEqual(list.map((display) => displays.relativePosition(display, list)), ["основной", "справа", "сверху"]);
});

test("parses xrandr monitors on Linux", () => {
  const output = "Monitors: 2\n 0: +*eDP-1 1280/170x800/106+0+0  eDP-1\n 1: +HDMI-A-1 1920/531x1080/299+1280+0  HDMI-A-1\n";
  const list = displays.parseDisplays(output, "Linux");
  assert.deepEqual(list.map((display) => [display.label, display.primary, display.x, display.width]), [["eDP-1", true, 0, 1280], ["HDMI-A-1", false, 1280, 1920]]);
  assert.equal(displays.relativePosition(list[1], list), "справа");
});

test("finds the saved monitor by position, then name, then number", () => {
  const list = displays.parseDisplays(JSON.stringify([
    { name: "\\\\.\\DISPLAY1", primary: true, x: 0, y: 0, width: 2560, height: 1440 },
    { name: "\\\\.\\DISPLAY2", primary: false, x: 2560, y: 0, width: 1920, height: 1080 }
  ]), "Windows");
  const saved = displays.displayPreference(list[1]);
  assert.equal(displays.findDisplay(list, saved), list[1]);
  assert.equal(displays.findDisplay(list, { ...saved, x: -1920 }), list[1], "moved monitor is found by name");
  assert.equal(displays.findDisplay(list, { index: 1, name: "", x: 1, y: 1, width: 1, height: 1 }), list[1]);
  assert.equal(displays.findDisplay([list[0]], { index: 1, name: "\\\\.\\DISPLAY2", x: 2560, y: 0, width: 1920, height: 1080 }), null, "disconnected monitor");
  assert.equal(displays.findDisplay(list, null), null);
});

test("places the window fully inside the chosen monitor", () => {
  const display = { x: 2560, y: -200, width: 1920, height: 1080 };
  assert.deepEqual(displays.targetWindowBounds(display), { x: 2600, y: -160, width: 1840, height: 1000 });
  assert.equal(displays.containsPoint(display, 3000, 300), true);
  assert.equal(displays.containsPoint(display, 2000, 300), false);
});
