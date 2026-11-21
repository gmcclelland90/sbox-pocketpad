// Games keep their own themes in their own folders: THEMES_DIR can list several, and inline overrides
// from the game (SetTheme) can point at their own stylesheet, font and assets.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/index.js";
import { ThemeStore, themeDirs } from "../src/themes.js";

const quiet = { debug() { }, info() { }, warn() { }, error() { } };
const builtin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "themes");
let tmp, gameA, gameB;

function theme(dir, name, json, files = {}) {
	const folder = path.join(dir, name);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "theme.json"), JSON.stringify(json));
	for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(folder, f), body);
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pocketpad-themes-"));
	gameA = path.join(tmp, "game-a");
	gameB = path.join(tmp, "game-b");
	theme(gameA, "mygame", { title: "My Game", stylesheet: "look.css", script: "look.js", fontUrl: "Font.ttf" }, { "look.css": "body{}", "look.js": "//", "Font.ttf": "x" });
	theme(gameB, "other", { title: "Other" });
	theme(gameB, "mygame", { title: "Overridden" });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("themeDirs splits a THEMES_DIR list on the platform separator and drops blanks", () => {
	assert.deepEqual(themeDirs(`a${path.delimiter}${path.delimiter} b `), ["a", "b"]);
	assert.deepEqual(themeDirs(["x", "", "y"]), ["x", "y"]);
	assert.deepEqual(themeDirs(undefined), []);
});

test("themes from a game's own folder sit beside the built-ins, and later folders win", () => {
	const store = new ThemeStore({ dirs: [builtin, gameA], defaultTheme: "default", log: quiet });
	assert.ok(store.list().includes("mygame"));
	assert.ok(store.list().includes("paper"), "built-in themes are still there");
	const t = store.get("mygame");
	assert.equal(t.title, "My Game");
	assert.equal(t.stylesheet, "/themes/mygame/look.css");
	assert.equal(t.script, "/themes/mygame/look.js");
	assert.equal(t.fontUrl, "/themes/mygame/Font.ttf");

	const both = new ThemeStore({ dirs: [builtin, gameA, gameB], defaultTheme: "default", log: quiet });
	assert.equal(both.get("mygame").title, "Overridden");
	assert.equal(both.get("other").title, "Other");
});

test("a server with several theme folders serves each game's theme files", async () => {
	const app = createServer({ port: 0, host: "127.0.0.1", log: quiet, themesDir: [gameA, gameB].join(path.delimiter) });
	const { port } = await app.listen();
	try {
		const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
		const list = await (await get("/api/v1/info")).json();
		assert.ok(list.themes.includes("other"));
		assert.equal((await (await get("/api/v1/themes/other")).json()).title, "Other");
		assert.equal((await get("/themes/paper/paper.css")).status, 200, "built-ins unchanged");
		assert.equal((await get("/themes/other/../mygame/look.css")).status, 404);
	} finally {
		await app.close();
	}
});

test("inline overrides can bring their own stylesheet and font, but never a script", () => {
	const store = new ThemeStore({ dirs: [builtin], defaultTheme: "default", log: quiet });
	const t = store.compose({ use: "default", stylesheet: "https://game.example/look.css", fontUrl: "data:font/ttf;base64,AA==", script: "https://evil.example/x.js" });
	assert.equal(t.stylesheet, "https://game.example/look.css");
	assert.equal(t.fontUrl, "data:font/ttf;base64,AA==");
	assert.ok(!t.script);
});
