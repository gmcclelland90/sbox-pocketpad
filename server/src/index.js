#!/usr/bin/env node
// PocketPad server: serves the phone controller page and relays messages between games and phones.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { loadConfig } from "./config.js";
import { SessionManager, normaliseCode } from "./session.js";
import { ThemeStore } from "./themes.js";
import { authFromRequest, verifySboxToken } from "./sboxauth.js";
import { RateLimiter } from "./ratelimit.js";
import { ProxyTrust } from "./proxy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
export const PROTOCOL = 1;

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".webmanifest": "application/manifest+json",
	".txt": "text/plain; charset=utf-8",
};

function makeLogger(level) {
	const order = { debug: 0, info: 1, warn: 2, error: 3 };
	const min = order[level] ?? 1;
	const out = (lvl) => (...args) => {
		if (order[lvl] >= min) console[lvl === "debug" ? "log" : lvl](new Date().toISOString(), lvl.toUpperCase(), ...args);
	};
	return { debug: out("debug"), info: out("info"), warn: out("warn"), error: out("error") };
}

function lanAddress() {
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
	}
	return null;
}

export function createServer(overrides = {}) {
	const config = loadConfig(overrides);
	const log = overrides.log ?? makeLogger(config.logLevel);
	const themes = new ThemeStore({ dirs: [config.builtinThemesDir, config.themesDir], defaultTheme: config.defaultTheme, log });
	const sessions = new SessionManager({ config, log, resolveTheme: (t) => themes.compose(t) });
	const inDocker = fs.existsSync("/.dockerenv");
	const proxies = new ProxyTrust({ trusted: config.trustedProxies, trustAll: config.trustProxy });
	const createLimiter = new RateLimiter({ limit: config.createRateLimit });
	const joinLimiter = new RateLimiter({ limit: config.joinRateLimit });
	const TOO_MANY_TRIES = "Too many wrong codes from your network. Wait a minute and try again.";

	const clientIp = (req) => proxies.clientIp(req);

	/**
	 * Look up a room by code, counting misses against the caller's address. Once an address has
	 * missed too often it gets nothing back, even for real codes, until its minute is up.
	 * Returns the session, null for no such room, or "limited".
	 */
	function lookupSession(req, code) {
		const ip = clientIp(req);
		if (joinLimiter.blocked(ip)) return "limited";
		const s = sessions.get(code);
		if (!s) joinLimiter.hit(ip);
		return s;
	}

	/** The base URL phones should open, as seen from this request. */
	function baseUrl(req) {
		if (config.publicUrl) return config.publicUrl;
		let proto = "http";
		let host = req.headers.host ?? `localhost:${config.port}`;
		if (proxies.fromProxy(req)) {
			proto = String(req.headers["x-forwarded-proto"] ?? proto).split(",")[0].trim();
			host = String(req.headers["x-forwarded-host"] ?? host).split(",")[0].trim();
		}
		// A game on the same machine talks to localhost, which phones can't reach. Use the LAN address.
		const m = host.match(/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/);
		if (m && !inDocker) {
			const lan = lanAddress();
			if (lan) host = lan + (m[2] ?? "");
		}
		return `${proto}://${host}`;
	}

	function json(res, status, body) {
		res.writeHead(status, { "content-type": MIME[".json"], "access-control-allow-origin": "*", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	function serveFile(res, file, { cache = "no-cache" } = {}) {
		fs.stat(file, (err, st) => {
			if (err || !st.isFile()) return json(res, 404, { error: "not found" });
			res.writeHead(200, {
				"content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
				"content-length": st.size,
				"cache-control": cache,
				"access-control-allow-origin": "*",
				"x-content-type-options": "nosniff",
			});
			fs.createReadStream(file).pipe(res);
		});
	}

	/** Resolve a request path inside root, refusing anything that escapes it. */
	function safeJoin(root, rel) {
		const full = path.resolve(root, "." + path.posix.normalize("/" + rel));
		return full.startsWith(path.resolve(root) + path.sep) ? full : null;
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const p = decodeURIComponent(url.pathname);
		if (req.method === "OPTIONS") {
			res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET" });
			return res.end();
		}
		if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });

		if (p === "/healthz" || p === "/api/v1/health") return json(res, 200, { ok: true, version: VERSION, sessions: sessions.size });

		if (p === "/api/v1/info") {
			return json(res, 200, {
				name: "pocketpad", version: VERSION, protocol: PROTOCOL,
				hostKeyRequired: config.hostKeys.length > 0,
				sboxAuthRequired: config.sboxAuth,
				defaultTheme: config.defaultTheme, themes: themes.list(), maxPlayers: config.maxPlayers,
			});
		}

		let m = p.match(/^\/api\/v1\/sessions\/([A-Za-z]{4})$/);
		if (m) {
			const s = lookupSession(req, m[1]);
			if (s === "limited") return json(res, 429, { error: TOO_MANY_TRIES });
			if (!s) return json(res, 404, { exists: false });
			return json(res, 200, { exists: true, code: s.code, lobbyOpen: s.lobbyOpen, players: s.players.size, maxPlayers: s.maxPlayers, theme: s.theme });
		}

		m = p.match(/^\/api\/v1\/themes\/([^/]+)$/);
		if (m) return json(res, 200, themes.get(m[1]));

		m = p.match(/^\/qr\/([A-Za-z]{4})\.svg$/);
		if (m) {
			const code = normaliseCode(m[1]);
			if (!code) return json(res, 404, { error: "bad code" });
			const svg = await QRCode.toString(`${baseUrl(req)}/${code}`, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
			res.writeHead(200, { "content-type": MIME[".svg"], "cache-control": "no-cache", "access-control-allow-origin": "*" });
			return res.end(svg);
		}
		m = p.match(/^\/qr\/([A-Za-z]{4})\.png$/);
		if (m) {
			const code = normaliseCode(m[1]);
			if (!code) return json(res, 404, { error: "bad code" });
			const size = Math.max(64, Math.min(1024, Number(url.searchParams.get("size")) || 512));
			const png = await QRCode.toBuffer(`${baseUrl(req)}/${code}`, { type: "png", margin: 1, width: size, errorCorrectionLevel: "M" });
			res.writeHead(200, { "content-type": MIME[".png"], "cache-control": "no-cache", "access-control-allow-origin": "*" });
			return res.end(png);
		}

		m = p.match(/^\/themes\/([^/]+)\/(.+)$/);
		if (m) {
			const folder = themes.folder(m[1]);
			const file = folder && safeJoin(folder, m[2]);
			if (!file) return json(res, 404, { error: "not found" });
			return serveFile(res, file);
		}

		// Join links: https://host/ABCD opens the controller with the code filled in.
		if (p === "/" || /^\/[A-Za-z]{4}\/?$/.test(p)) return serveFile(res, path.join(config.publicDir, "index.html"));

		const file = safeJoin(config.publicDir, p);
		if (!file) return json(res, 404, { error: "not found" });
		return serveFile(res, file);
	});

	const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageKb * 1024 });

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname !== "/ws/host" && url.pathname !== "/ws/play") return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.isAlive = true;
			ws.on("pong", () => (ws.isAlive = true));
			ws.maxBuffered = config.maxBufferedKb * 1024;
			ws.on("close", () => {
				if (ws.overflowed) log.warn(`dropped a ${url.pathname === "/ws/host" ? "game" : "phone"} connection that fell more than ${config.maxBufferedKb} KB behind`);
			});
			ws.on("error", () => { });
			if (url.pathname === "/ws/host") onHost(ws, url, req);
			else onPhone(ws, url, req);
		});
	});

	function reject(ws, message, code = 4004) {
		try {
			ws.send(JSON.stringify({ type: "error", message }));
			ws.close(code, "rejected");
		} catch { }
	}

	function parse(data) {
		try { return JSON.parse(data.toString()); } catch { return null; }
	}

	async function onHost(ws, url, req) {
		const key = url.searchParams.get("key") ?? "";
		if (config.hostKeys.length && !config.hostKeys.includes(key)) return reject(ws, "This server needs a host key.", 4003);

		const resume = url.searchParams.get("resume");
		let session = sessions.byHostToken(resume);
		let steamId = null;
		if (!session) {
			// Check the limit before asking Facepunch, so nobody can make us spam their auth endpoint.
			if (!createLimiter.hit(clientIp(req))) {
				return reject(ws, "Too many new sessions from this address. Wait a minute and try again.", 4029);
			}
			if (config.sboxAuth) {
				const auth = authFromRequest(req);
				const result = await verifySboxToken(auth, { url: config.sboxAuthUrl });
				if (ws.readyState !== ws.OPEN) return;
				if (result === "unavailable") {
					// Not the game's fault. Close without an error so the library retries with a fresh token.
					log.warn("s&box auth check failed: couldn't reach " + config.sboxAuthUrl);
					return ws.close(1013, "auth check unavailable");
				}
				if (result !== "ok") return reject(ws, "This server only accepts games signed in to s&box. Turn on Send Auth Token on the PocketPad Host.", 4003);
				steamId = auth.steamId;
				// Someone else may have resumed or created in the meantime; look again.
				session = sessions.byHostToken(resume);
			}
		}
		const resumed = !!session;
		if (!session) {
			session = sessions.create({
				theme: url.searchParams.get("theme") || null,
				maxPlayers: Number(url.searchParams.get("maxPlayers")) || 0,
				rejoinByName: /^(1|true|yes)$/i.test(url.searchParams.get("rejoinByName") || ""),
			});
			if (!session) return reject(ws, "The server is full. Try again later.", 4029);
			if (steamId) {
				session.hostSteamId = steamId;
				log.info(`session ${session.code} created by Steam ID ${steamId}`);
			}
		}
		const s = session;
		s.attachHost(ws, { resumed, joinUrl: `${baseUrl(req)}/${s.code}` });

		ws.on("message", (data) => {
			const msg = parse(data);
			const err = s.handleHost(msg);
			if (err) ws.send(JSON.stringify({ type: "error", message: err, about: msg?.type ?? null }));
		});
		ws.on("close", () => s.detachHost(ws));
		ws.on("error", () => { });
	}

	function onPhone(ws, url, req) {
		const s = lookupSession(req, url.searchParams.get("code"));
		if (s === "limited") return reject(ws, TOO_MANY_TRIES, 4029);
		if (!s) return reject(ws, "No game with that code. Check the code on the TV.");
		const result = s.joinPlayer(ws, { name: url.searchParams.get("name"), token: url.searchParams.get("token") });
		if (result.error) return reject(ws, result.error);
		const player = result.player;

		ws.on("message", (data) => s.handlePlayer(player, parse(data)));
		ws.on("close", () => s.detachPlayer(player, ws));
		ws.on("error", () => { });
	}

	// Drop sockets that stop answering pings (phones that went to sleep, dead Wi-Fi).
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (!ws.isAlive) { ws.terminate(); continue; }
			ws.isAlive = false;
			try { ws.ping(); } catch { }
		}
		createLimiter.sweep();
		joinLimiter.sweep();
	}, 20_000);

	function close() {
		clearInterval(heartbeat);
		sessions.endAll("The server is restarting.");
		wss.close();
		return new Promise((resolve) => server.close(() => resolve()));
	}

	function listen() {
		return new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address())));
	}

	return { server, wss, sessions, themes, config, log, proxies, listen, close };
}

// Run directly: start listening.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const app = createServer();
	const addr = await app.listen();
	app.log.info(`PocketPad server ${VERSION} listening on ${addr.address}:${addr.port}`);
	if (app.config.publicUrl) app.log.info(`Phones join at ${app.config.publicUrl}`);
	else {
		const lan = lanAddress();
		app.log.info(`Phones join at http://${lan ?? "<this machine's IP>"}:${addr.port} (set PUBLIC_URL to override)`);
	}
	if (app.config.trustProxy) app.log.warn("TRUST_PROXY=true believes X-Forwarded-* headers from anyone. Set TRUSTED_PROXIES to your proxy's address instead.");
	if (app.config.hostKeys.length) app.log.info(`Host keys required (${app.config.hostKeys.length} configured)`);
	if (app.config.sboxAuth) app.log.info("s&box auth tokens required to create sessions");
	app.log.info(`Themes: ${app.themes.list().join(", ")}`);
	const stop = async (sig) => {
		app.log.info(`${sig}: shutting down`);
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
