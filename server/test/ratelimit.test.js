// Per-address limits on creating sessions and guessing room codes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../src/index.js";
import { RateLimiter } from "../src/ratelimit.js";

const quiet = { debug() { }, info() { }, warn() { }, error() { } };
let app, base;

before(async () => {
	app = createServer({
		port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", hostGraceSeconds: 1,
		publicUrl: "http://pad.test", createRateLimit: 2, joinRateLimit: 3,
	});
	const addr = await app.listen();
	base = `127.0.0.1:${addr.port}`;
});
after(() => app.close());

/** Open a socket and resolve with its first message and close code. */
function connect(path) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://${base}${path}`);
		let first = null;
		ws.on("message", (raw) => {
			first ??= JSON.parse(raw.toString());
			if (first.type === "ready" || first.type === "welcome") resolve({ ws, first, code: null });
		});
		ws.on("close", (code) => resolve({ ws, first, code }));
	});
}

test("RateLimiter counts per key and resets each window", () => {
	let now = 0;
	const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
	assert.ok(rl.hit("a"));
	assert.ok(rl.hit("a"));
	assert.ok(rl.blocked("a"));
	assert.equal(rl.hit("a"), false);
	assert.ok(rl.hit("b"));
	now = 1000;
	assert.equal(rl.blocked("a"), false);
	assert.ok(rl.hit("a"));
	now = 5000;
	rl.sweep();
	assert.equal(rl.entries.size, 0);
});

test("a limit of 0 turns the limiter off", () => {
	const rl = new RateLimiter({ limit: 0 });
	for (let i = 0; i < 100; i++) assert.ok(rl.hit("a"));
	assert.equal(rl.blocked("a"), false);
});

test("wrong codes are limited per address, and then even real codes are refused", async () => {
	const game = await connect("/ws/host");
	assert.equal(game.first.type, "ready");

	// Correct codes don't count.
	for (let i = 0; i < 5; i++) {
		const r = await fetch(`http://${base}/api/v1/sessions/${game.first.code}`);
		assert.equal(r.status, 200);
	}

	const wrong = game.first.code === "ZZZZ" ? "ZZZY" : "ZZZZ";
	for (let i = 0; i < 2; i++) assert.equal((await fetch(`http://${base}/api/v1/sessions/${wrong}`)).status, 404);
	const miss = await connect(`/ws/play?code=${wrong}&name=Sam`);
	assert.equal(miss.first.type, "error");

	const limited = await connect(`/ws/play?code=${game.first.code}&name=Sam`);
	assert.equal(limited.code, 4029);
	assert.match(limited.first.message, /Too many/);
	assert.equal((await fetch(`http://${base}/api/v1/sessions/${game.first.code}`)).status, 429);
	game.ws.close();
});

test("new sessions are limited per address, but resuming one isn't", async () => {
	// The test above already created one session from this address.
	const second = await connect("/ws/host");
	assert.equal(second.first.type, "ready");
	const third = await connect("/ws/host");
	assert.equal(third.code, 4029);
	assert.match(third.first.message, /Too many new sessions/);

	second.ws.close();
	await new Promise((r) => setTimeout(r, 50));
	const resumed = await connect(`/ws/host?resume=${second.first.hostToken}`);
	assert.equal(resumed.first.type, "ready");
	assert.equal(resumed.first.resumed, true);
	resumed.ws.close();
});
