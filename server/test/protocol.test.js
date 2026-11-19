// End-to-end protocol tests: a fake game and fake phones talk to a real server on a random port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../src/index.js";

const quiet = { debug() { }, info() { }, warn() { }, error() { } };
let app, base;

before(async () => {
	app = createServer({ port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", hostGraceSeconds: 1, publicUrl: "http://pad.test", createRateLimit: 0, joinRateLimit: 0 });
	const addr = await app.listen();
	base = `127.0.0.1:${addr.port}`;
});
after(() => app.close());

/** A socket wrapper that queues messages so tests can await the next one of a type. */
function client(path) {
	const ws = new WebSocket(`ws://${base}${path}`);
	const queue = [];
	const waiters = [];
	ws.on("message", (raw) => {
		const msg = JSON.parse(raw.toString());
		const i = waiters.findIndex((w) => w.match(msg));
		if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
		else queue.push(msg);
	});
	const closed = new Promise((r) => ws.on("close", (code) => r(code)));
	return {
		ws, closed,
		send: (m) => ws.send(JSON.stringify(m)),
		next(type, pred = () => true) {
			const match = (m) => m.type === type && pred(m);
			const i = queue.findIndex(match);
			if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
			return new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
				waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
			});
		},
		close: () => ws.close(),
	};
}

async function newGame(query = "") {
	const host = client(`/ws/host${query}`);
	const ready = await host.next("ready");
	return { host, ready };
}

test("host gets a session with a join url", async () => {
	const { host, ready } = await newGame();
	assert.match(ready.code, /^[A-Z]{4}$/);
	assert.equal(ready.joinUrl, `http://pad.test/${ready.code}`);
	assert.ok(ready.hostToken.length > 10);
	assert.equal(ready.theme.name, "default");
	host.close();
});

test("phones join, get colours, unique names and the current screen", async () => {
	const { host, ready } = await newGame();
	host.send({ type: "show", screen: { title: "Lobby", elements: [{ type: "text", id: "t", text: "hi" }] } });
	await new Promise((r) => setTimeout(r, 30));

	const a = client(`/ws/play?code=${ready.code.toLowerCase()}&name=Sam`);
	const wa = await a.next("welcome");
	assert.equal(wa.name, "Sam");
	assert.equal(wa.id, "p1");
	assert.equal(wa.screen.title, "Lobby");
	assert.match(wa.color, /^#/);
	const j = await host.next("join");
	assert.equal(j.player.name, "Sam");

	const b = client(`/ws/play?code=${ready.code}&name=sam`);
	const wb = await b.next("welcome");
	assert.equal(wb.name, "sam 2");
	assert.notEqual(wb.color, wa.color);
	host.close(); a.close(); b.close();
});

test("bad code and empty name are rejected with a message", async () => {
	const x = client(`/ws/play?code=ZZZZ&name=Sam`);
	assert.match((await x.next("error")).message, /No game/);
	const { host, ready } = await newGame();
	const y = client(`/ws/play?code=${ready.code}&name=%20`);
	assert.match((await y.next("error")).message, /name/);
	host.close();
});

test("input is relayed to the host with player id and sequence", async () => {
	const { host, ready } = await newGame();
	const p = client(`/ws/play?code=${ready.code}&name=Ann`);
	const w = await p.next("welcome");
	p.send({ type: "input", el: "move", ev: "move", x: 0.5, y: -1, junk: "dropped" });
	p.send({ type: "input", el: "mash", ev: "down" });
	p.send({ type: "input", ev: "down" }); // no element: dropped
	const i1 = await host.next("input");
	assert.deepEqual([i1.from, i1.el, i1.ev, i1.x, i1.y, i1.seq], [w.id, "move", "move", 0.5, -1, 1]);
	assert.equal(i1.junk, undefined);
	const i2 = await host.next("input");
	assert.deepEqual([i2.el, i2.ev, i2.seq], ["mash", "down", 2]);
	host.close(); p.close();
});

test("targeted show, update and feedback reach only that player", async () => {
	const { host, ready } = await newGame();
	const a = client(`/ws/play?code=${ready.code}&name=A`);
	const b = client(`/ws/play?code=${ready.code}&name=B`);
	const wa = await a.next("welcome");
	await b.next("welcome");
	host.send({ type: "show", screen: { title: "All", elements: [{ type: "progress", id: "bar", value: 0 }] } });
	assert.equal((await a.next("screen")).screen.title, "All");
	assert.equal((await b.next("screen")).screen.title, "All");

	host.send({ type: "update", to: wa.id, id: "bar", set: { value: 0.5 } });
	host.send({ type: "feedback", to: [wa.id], feedback: { haptic: "tap" } });
	host.send({ type: "show", to: wa.id, screen: { title: "Just A" } });
	assert.equal((await a.next("update")).set.value, 0.5);
	assert.equal((await a.next("feedback")).feedback.haptic, "tap");
	assert.equal((await a.next("screen")).screen.title, "Just A");

	host.send({ type: "update", id: "bar", set: { value: 0.9 } });
	assert.equal((await b.next("update")).set.value, 0.9);
	host.close(); a.close(); b.close();
});

test("a refreshed phone rejoins as the same player with the patched screen", async () => {
	const { host, ready } = await newGame();
	host.send({ type: "show", screen: { title: "Race", elements: [{ type: "progress", id: "bar", value: 0 }] } });
	const a = client(`/ws/play?code=${ready.code}&name=Kim`);
	const w = await a.next("welcome");
	await host.next("join");
	host.send({ type: "update", to: w.id, id: "bar", set: { value: 0.7 } });
	await a.next("update");
	a.close();
	const st = await host.next("status");
	assert.deepEqual([st.id, st.connected], [w.id, false]);

	host.send({ type: "lobby", open: false });
	const again = client(`/ws/play?code=${ready.code}&name=whatever&token=${w.token}`);
	const w2 = await again.next("welcome");
	assert.equal(w2.id, w.id);
	assert.equal(w2.name, "Kim");
	assert.equal(w2.rejoin, true);
	assert.equal(w2.screen.elements[0].value, 0.7);
	const j = await host.next("join");
	assert.equal(j.rejoin, true);

	const late = client(`/ws/play?code=${ready.code}&name=Late`);
	assert.match((await late.next("error")).message, /new players/);
	host.close(); again.close();
});

test("the host can reconnect with its token and keeps its players", async () => {
	const { host, ready } = await newGame();
	const p = client(`/ws/play?code=${ready.code}&name=Lou`);
	await p.next("welcome");
	host.close();
	assert.match((await p.next("status")).message, /reconnect/);
	const back = client(`/ws/host?resume=${ready.hostToken}`);
	const r = await back.next("ready");
	assert.equal(r.code, ready.code);
	assert.equal(r.resumed, true);
	assert.equal(r.players.length, 1);
	assert.equal((await p.next("status")).message, null);
	back.send({ type: "end" });
	assert.equal((await p.next("ended")).reason, "ended");
});

test("a session ends when the host stays away past the grace period", async () => {
	const { host, ready } = await newGame();
	const p = client(`/ws/play?code=${ready.code}&name=Zed`);
	await p.next("welcome");
	host.close();
	const ended = await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("no end")), 3000);
		p.next("ended").then((m) => { clearTimeout(t); resolve(m); }).catch(() => { });
	}).catch(async () => p.next("ended"));
	assert.equal(ended.reason, "ended");
	assert.equal(app.sessions.get(ready.code), null);
});

test("kick removes a player and tells the host", async () => {
	const { host, ready } = await newGame();
	const p = client(`/ws/play?code=${ready.code}&name=Bob`);
	const w = await p.next("welcome");
	host.send({ type: "kick", id: w.id, reason: "Bye" });
	assert.equal((await p.next("ended")).message, "Bye");
	assert.equal((await host.next("leave")).id, w.id);
	host.close();
});

test("joinScreen: newcomers see it first, nobody else's screen changes", async () => {
	const { host, ready } = await newGame();
	const a = client(`/ws/play?code=${ready.code}&name=Ann`);
	await a.next("welcome");
	host.send({ type: "show", screen: { title: "Lobby" } });
	assert.equal((await a.next("screen")).screen.title, "Lobby");
	host.send({ type: "joinScreen", screen: { title: "You're watching" } });
	const b = client(`/ws/play?code=${ready.code}&name=Ben`);
	assert.equal((await b.next("welcome")).screen.title, "You're watching");
	// Ann didn't get a new screen.
	const none = await Promise.race([a.next("screen").then(() => "screen", () => "none"), new Promise((r) => setTimeout(() => r("none"), 100))]);
	assert.equal(none, "none");
	// Clearing it goes back to the default screen for the next newcomer.
	host.send({ type: "joinScreen", screen: null });
	const c = client(`/ws/play?code=${ready.code}&name=Cat`);
	assert.equal((await c.next("welcome")).screen.title, "Lobby");
	host.close();
});

test("theme can be picked by name and overridden inline", async () => {
	const { host, ready } = await newGame("?theme=paper");
	assert.equal(ready.theme.name, "paper");
	assert.equal(ready.theme.logo, "/themes/paper/logo.svg");
	const p = client(`/ws/play?code=${ready.code}&name=T`);
	await p.next("welcome");
	host.send({ type: "theme", theme: { use: "neon", colors: { accent: "#123456" }, script: "evil.js" } });
	const t = (await p.next("theme")).theme;
	assert.equal(t.name, "neon");
	assert.equal(t.colors.accent, "#123456");
	assert.equal(t.colors.bg, "#07060d");
	assert.ok(!t.script);
	host.close();
});

test("host keys are enforced when configured", async () => {
	const keyed = createServer({ port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", hostKeys: ["secret"] });
	const addr = await keyed.listen();
	const bad = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/host`);
	const code = await new Promise((r) => bad.on("close", (c) => r(c)));
	assert.equal(code, 4003);
	const good = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/host?key=secret`);
	const msg = await new Promise((r) => good.on("message", (m) => r(JSON.parse(m.toString()))));
	assert.equal(msg.type, "ready");
	good.close();
	await keyed.close();
});

test("http endpoints: health, session info, qr, static files, no path traversal", async () => {
	const { host, ready } = await newGame();
	const get = (p) => fetch(`http://${base}${p}`);
	assert.equal((await (await get("/healthz")).json()).ok, true);
	const info = await (await get(`/api/v1/sessions/${ready.code}`)).json();
	assert.equal(info.exists, true);
	assert.equal((await get("/api/v1/sessions/QQQQ")).status, 404);
	const qr = await get(`/qr/${ready.code}.svg`);
	assert.match(await qr.text(), /<svg/);
	assert.equal((await get(`/qr/${ready.code}.png`)).headers.get("content-type"), "image/png");
	assert.match(await (await get(`/${ready.code}`)).text(), /PocketPad/);
	assert.equal((await get("/pad.js")).status, 200);
	assert.equal((await get("/themes/paper/logo.svg")).status, 200);
	assert.equal((await get("/themes/paper/..%2F..%2Fpackage.json")).status, 404);
	assert.equal((await get("/..%2Fpackage.json")).status, 404);
	host.close();
});
