// s&box auth tokens: a fake Facepunch endpoint and a server with SBOX_AUTH on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { createServer } from "../src/index.js";
import { verifySboxToken } from "../src/sboxauth.js";

const quiet = { debug() { }, info() { }, warn() { }, error() { } };
const STEAM_ID = "76561198012345679"; // bigger than Number.MAX_SAFE_INTEGER on purpose
let app, base, facepunch, facepunchUrl, facepunchDown = false;
const seen = [];

before(async () => {
	// Pretends to be public.facepunch.com/sbox/auth/token: "good-token" belongs to STEAM_ID.
	facepunch = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			seen.push(body);
			if (facepunchDown) { res.writeHead(503); return res.end(); }
			const ok = body.includes(`"steamid":${STEAM_ID}`) && body.includes(`"token":"good-token"`);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(ok ? `{"SteamId":${STEAM_ID},"Status":"ok"}` : `{"SteamId":0,"Status":"invalid"}`);
		});
	});
	await new Promise((r) => facepunch.listen(0, "127.0.0.1", r));
	facepunchUrl = `http://127.0.0.1:${facepunch.address().port}/sbox/auth/token`;

	app = createServer({
		port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", hostGraceSeconds: 1,
		publicUrl: "http://pad.test", sboxAuth: true, sboxAuthUrl: facepunchUrl,
	});
	const addr = await app.listen();
	base = `127.0.0.1:${addr.port}`;
});
after(async () => {
	await app.close();
	facepunch.close();
});

/** Open a host socket with optional headers; resolve with the first message and/or close code. */
function host(path, headers = {}) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://${base}${path}`, { headers });
		let first = null;
		ws.on("message", (raw) => {
			first ??= JSON.parse(raw.toString());
			if (first.type === "ready") resolve({ ws, first, code: null });
		});
		ws.on("close", (code) => resolve({ ws, first, code }));
	});
}

test("verifySboxToken sends the Steam ID as an exact number and checks the answer", async () => {
	assert.equal(await verifySboxToken({ token: "good-token", steamId: STEAM_ID }, { url: facepunchUrl }), "ok");
	assert.ok(seen.at(-1).includes(`"steamid":${STEAM_ID}`));
	assert.equal(await verifySboxToken({ token: "nope", steamId: STEAM_ID }, { url: facepunchUrl }), "invalid");
	assert.equal(await verifySboxToken({ token: "good-token", steamId: "123" }, { url: facepunchUrl }), "invalid");
	assert.equal(await verifySboxToken({ token: "", steamId: STEAM_ID }, { url: facepunchUrl }), "invalid");
	assert.equal(await verifySboxToken({ token: "x", steamId: "not-a-number" }, { url: facepunchUrl }), "invalid");
	assert.equal(await verifySboxToken({ token: "x", steamId: STEAM_ID }, { url: "http://127.0.0.1:1/nothing" }), "unavailable");
});

test("info says auth is required", async () => {
	const info = await (await fetch(`http://${base}/api/v1/info`)).json();
	assert.equal(info.sboxAuthRequired, true);
});

test("a game without a token is turned away", async () => {
	const r = await host("/ws/host");
	assert.equal(r.code, 4003);
	assert.equal(r.first.type, "error");
});

test("a game with a wrong token is turned away", async () => {
	const r = await host("/ws/host", { authorization: "stolen", "x-steam-id": STEAM_ID });
	assert.equal(r.code, 4003);
});

test("a signed-in game gets a session and can resume it without a token", async () => {
	const r = await host("/ws/host", { authorization: "Bearer good-token", "x-steam-id": STEAM_ID });
	assert.equal(r.first.type, "ready");
	assert.equal(app.sessions.get(r.first.code).hostSteamId, STEAM_ID);
	r.ws.close();
	await new Promise((res) => setTimeout(res, 50));
	const again = await host(`/ws/host?resume=${r.first.hostToken}`);
	assert.equal(again.first.resumed, true);
	again.ws.close();
});

test("if Facepunch is down the socket closes with 1013 so the game retries", async () => {
	facepunchDown = true;
	try {
		const r = await host("/ws/host", { authorization: "good-token", "x-steam-id": STEAM_ID });
		assert.equal(r.code, 1013);
		assert.equal(r.first, null);
	} finally {
		facepunchDown = false;
	}
});
