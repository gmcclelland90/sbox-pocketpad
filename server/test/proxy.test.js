// Which X-Forwarded-* headers the server believes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProxyTrust, plainIp } from "../src/proxy.js";
import WebSocket from "ws";
import { createServer } from "../src/index.js";

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test("plainIp strips the IPv4-in-IPv6 prefix", () => {
	assert.equal(plainIp("::ffff:10.0.0.5"), "10.0.0.5");
	assert.equal(plainIp("::1"), "::1");
	assert.equal(plainIp(" 1.2.3.4 "), "1.2.3.4");
});

test("loopback is always trusted, other addresses only when listed", () => {
	const t = new ProxyTrust({ trusted: ["172.16.0.0/12", "10.1.2.3", "fd00::/8"] });
	assert.ok(t.trusts("127.0.0.1"));
	assert.ok(t.trusts("::1"));
	assert.ok(t.trusts("::ffff:127.0.0.1"));
	assert.ok(t.trusts("172.17.0.1"));
	assert.ok(t.trusts("10.1.2.3"));
	assert.ok(t.trusts("fd12::1"));
	assert.equal(t.trusts("10.1.2.4"), false);
	assert.equal(t.trusts("8.8.8.8"), false);
	assert.equal(t.trusts("not an ip"), false);
});

test("bad entries are reported", () => {
	assert.throws(() => new ProxyTrust({ trusted: ["proxy.local"] }), /TRUSTED_PROXIES/);
	assert.throws(() => new ProxyTrust({ trusted: ["10.0.0.0/33"] }), /prefix/);
});

test("clientIp ignores X-Forwarded-For from untrusted peers", () => {
	const t = new ProxyTrust();
	assert.equal(t.clientIp(req("203.0.113.9", { "x-forwarded-for": "1.1.1.1" })), "203.0.113.9");
});

test("clientIp walks past our proxies but not past what the client wrote", () => {
	const t = new ProxyTrust({ trusted: ["10.0.0.0/8"] });
	// Client 198.51.100.7 sent a fake header; Caddy (10.0.0.2) appended the real address, then a load balancer (127.0.0.1) did.
	const r = req("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.2" });
	assert.equal(t.clientIp(r), "198.51.100.7");
	assert.equal(t.clientIp(req("::ffff:127.0.0.1", { "x-forwarded-for": "198.51.100.7" })), "198.51.100.7");
	assert.equal(t.clientIp(req("127.0.0.1")), "127.0.0.1");
	assert.equal(t.clientIp(req("127.0.0.1", { "x-forwarded-for": "garbage" })), "127.0.0.1");
});

test("TRUST_PROXY=true keeps the old trust-anyone behaviour, using the last hop", () => {
	const t = new ProxyTrust({ trustAll: true });
	assert.ok(t.fromProxy(req("8.8.8.8")));
	assert.equal(t.clientIp(req("8.8.8.8", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" })), "198.51.100.7");
});

test("join links use X-Forwarded-Proto/Host from a proxy on loopback", async () => {
	const quiet = { debug() { }, info() { }, warn() { }, error() { } };
	const app = createServer({ port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", hostGraceSeconds: 1 });
	const addr = await app.listen();
	const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/host`, {
		headers: { "x-forwarded-proto": "https", "x-forwarded-host": "pad.example.com" },
	});
	const ready = await new Promise((resolve) => ws.on("message", (raw) => resolve(JSON.parse(raw.toString()))));
	assert.equal(ready.joinUrl, `https://pad.example.com/${ready.code}`);
	ws.close();
	await app.close();
});

test("rate limits count each forwarded client separately behind a proxy", async () => {
	const quiet = { debug() { }, info() { }, warn() { }, error() { } };
	const app = createServer({ port: 0, host: "127.0.0.1", log: quiet, themesDir: "/nonexistent", joinRateLimit: 1 });
	const addr = await app.listen();
	const look = (ip) => fetch(`http://127.0.0.1:${addr.port}/api/v1/sessions/ZZZZ`, { headers: { "x-forwarded-for": ip } }).then((r) => r.status);
	assert.equal(await look("198.51.100.1"), 404);
	assert.equal(await look("198.51.100.1"), 429);
	assert.equal(await look("198.51.100.2"), 404);
	// A client can't escape by putting a fake address in front: our proxy appends the real one last.
	assert.equal(await look("203.0.113.50, 198.51.100.1"), 429);
	await app.close();
});
