// Connections that stop reading get dropped instead of piling up messages in server memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../src/index.js";
import { send } from "../src/session.js";

test("send drops a socket whose backlog is over its limit", () => {
	let terminated = 0, sent = 0;
	const socket = { readyState: 1, bufferedAmount: 0, maxBuffered: 100, send() { sent++; }, terminate() { terminated++; } };
	assert.equal(send(socket, { type: "x" }), true);
	socket.bufferedAmount = 101;
	assert.equal(send(socket, { type: "x" }), false);
	assert.equal(sent, 1);
	assert.equal(terminated, 1);
	assert.equal(socket.overflowed, true);
});

test("a socket without a limit is never dropped", () => {
	let sent = 0;
	const socket = { readyState: 1, bufferedAmount: 1e12, send() { sent++; }, terminate() { assert.fail(); } };
	assert.equal(send(socket, "hi"), true);
	assert.equal(sent, 1);
});

test("a phone that stops reading is disconnected, then rejoins with its screen", async () => {
	const warnings = [];
	const log = { debug() { }, info() { }, warn: (m) => warnings.push(m), error() { } };
	const app = createServer({ port: 0, host: "127.0.0.1", log, themesDir: "/nonexistent", hostGraceSeconds: 1, maxBufferedKb: 64 });
	const addr = await app.listen();
	const url = `ws://127.0.0.1:${addr.port}`;

	const host = new WebSocket(`${url}/ws/host`);
	const ready = await new Promise((r) => host.once("message", (m) => r(JSON.parse(m.toString()))));
	host.send(JSON.stringify({ type: "show", screen: { title: "Still here" } }));

	const phone = new WebSocket(`${url}/ws/play?code=${ready.code}&name=Slow`);
	const welcome = await new Promise((r) => phone.once("message", (m) => r(JSON.parse(m.toString()))));
	assert.equal(welcome.type, "welcome");
	// The paused phone won't notice the close, so watch for the game being told it dropped.
	const dropped = new Promise((r) => host.on("message", (m) => {
		const msg = JSON.parse(m.toString());
		if (msg.type === "status" && msg.connected === false) r(msg);
	}));

	// Stop reading, then have the game flood it with 40 x 512 KB.
	phone._socket.pause();
	const blob = "x".repeat(512 * 1024);
	for (let i = 0; i < 40; i++) host.send(JSON.stringify({ type: "send", data: blob }));
	const status = await dropped;
	assert.equal(status.id, welcome.id);
	phone.terminate();
	assert.ok(warnings.some((w) => /phone connection that fell more than 64 KB behind/.test(w)));

	const again = new WebSocket(`${url}/ws/play?code=${ready.code}&token=${welcome.token}`);
	const back = await new Promise((r) => again.once("message", (m) => r(JSON.parse(m.toString()))));
	assert.equal(back.type, "welcome");
	assert.equal(back.id, welcome.id);
	assert.equal(back.screen.title, "Still here");

	again.close();
	host.close();
	await app.close();
});
