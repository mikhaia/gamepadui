const test = require("node:test");
const assert = require("node:assert/strict");
const steamGrid = require("../resources/js/steamgrid.js");

test("builds SteamGridDB requests for portrait covers", () => {
  assert.equal(steamGrid.searchUrl(" Hades II "), "https://www.steamgriddb.com/api/v2/search/autocomplete/Hades%20II");
  assert.equal(steamGrid.searchUrl("Ори и блуждающие огоньки/2"), "https://www.steamgriddb.com/api/v2/search/autocomplete/%D0%9E%D1%80%D0%B8%20%D0%B8%20%D0%B1%D0%BB%D1%83%D0%B6%D0%B4%D0%B0%D1%8E%D1%89%D0%B8%D0%B5%20%D0%BE%D0%B3%D0%BE%D0%BD%D1%8C%D0%BA%D0%B8%2F2");
  const grids = new URL(steamGrid.gridsUrl({ type: "game", id: 5248 }, { page: 2 }));
  assert.equal(grids.pathname, "/api/v2/grids/game/5248");
  assert.equal(grids.searchParams.get("dimensions"), "600x900,342x482,660x930");
  assert.equal(grids.searchParams.get("types"), "static");
  assert.equal(grids.searchParams.get("nsfw"), "false");
  assert.equal(grids.searchParams.get("humor"), "false");
  assert.equal(grids.searchParams.get("page"), "2");
  assert.equal(new URL(steamGrid.gridsUrl({ type: "steam", id: "1245620" })).pathname, "/api/v2/grids/steam/1245620");
  assert.deepEqual(steamGrid.authHeaders("abc"), { Authorization: "Bearer abc" });
});

test("reads API answers and errors", () => {
  assert.deepEqual(steamGrid.parseResponse(200, '{"success":true,"data":[{"id":1}]}'), { ok: true, data: [{ id: 1 }] });
  assert.deepEqual(steamGrid.parseResponse(401, '{"success":false,"errors":["Invalid API key"]}'), { ok: false, kind: "key", message: "Invalid API key" });
  assert.deepEqual(steamGrid.parseResponse(404, '{"success":false,"errors":["Game not found"]}'), { ok: true, data: [] });
  assert.equal(steamGrid.parseResponse(500, "oops").kind, "http");
  assert.equal(steamGrid.parseResponse(200, "<html>").kind, "format");
  assert.equal(steamGrid.parseResponse(200, '{"success":false,"errors":["bad"]}').message, "bad");
});

test("keeps only usable games and covers", () => {
  assert.deepEqual(steamGrid.parseGames([
    { id: 5248, name: "Hades", release_date: 1600300800, types: ["steam"], verified: true },
    { id: 0, name: "Broken" },
    { id: 77, name: "" },
    { id: 99, name: "No date" }
  ]), [
    { id: 5248, name: "Hades", year: 2020, verified: true },
    { id: 99, name: "No date", year: null, verified: false }
  ]);
  assert.deepEqual(steamGrid.parseCovers([
    { id: 1, url: "https://cdn2.steamgriddb.com/grid/a.png", thumb: "https://cdn2.steamgriddb.com/thumb/a.jpg", width: 600, height: 900, style: "alternate", author: { name: "Artist" } },
    { id: 2, url: "https://cdn2.steamgriddb.com/grid/b.webp" },
    { id: 3, url: "javascript:alert(1)" },
    { id: 4, url: "http://insecure.example/c.png" }
  ]), [
    { id: "1", url: "https://cdn2.steamgriddb.com/grid/a.png", thumb: "https://cdn2.steamgriddb.com/thumb/a.jpg", width: 600, height: 900, style: "alternate", author: "Artist" },
    { id: "2", url: "https://cdn2.steamgriddb.com/grid/b.webp", thumb: "https://cdn2.steamgriddb.com/grid/b.webp", width: 0, height: 0, style: "", author: "" }
  ]);
});

test("finds the Steam AppID in steam:// links", () => {
  assert.equal(steamGrid.steamAppIdFromPath("steam://rungameid/1245620"), "1245620");
  assert.equal(steamGrid.steamAppIdFromPath("steam://run/570"), "570");
  assert.equal(steamGrid.steamAppIdFromPath("C:\\Games\\Hades.exe"), "");
  assert.match(steamGrid.errorText({ kind: "key" }), /API-ключ/);
  assert.match(steamGrid.errorText(new Error("native-api-required")), /Neutralino/);
});
