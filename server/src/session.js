// Sessions: one game (the host) plus the phones that joined it.
//
// The server is deliberately dumb about gameplay. It relays the host's screens, updates and
// feedback to phones, relays phone input to the host, and remembers just enough state (each
// player's current screen, theme and colour) for a refreshed phone or a reconnecting game to
// pick up where it left off. See docs/protocol.md for the message reference.

import crypto from "node:crypto";

// No vowels, so codes don't spell words. 20^4 = 160,000 codes.
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** Friendly default player colours, assigned by join slot. Games can override them. */
export const PLAYER_COLORS = [
	"#e8574f", "#4a8ce8", "#f5c33b", "#5bbf72",
	"#b36be0", "#f08a3c", "#3cc6c0", "#e86fae",
	"#8a9a5b", "#6b7be0", "#d9a066", "#4fae8f",
	"#c04f6b", "#7fb8e8", "#a3a3a3", "#2f4f8f",
];

const MAX_NAME = 20;
const MAX_ID = 64;

export function randomToken(bytes = 18) {
	return crypto.randomBytes(bytes).toString("base64url");
}

export function normaliseCode(code) {
	if (typeof code !== "string") return null;
	const c = code.trim().toUpperCase();
	return /^[A-Z]{4}$/.test(c) && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

export function cleanName(name) {
	if (typeof name !== "string") return "";
	// Strip control characters and collapse whitespace.
	return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

/**
 * Send to a socket. A socket whose unsent backlog is over its `maxBuffered` bytes (a phone on bad
 * Wi-Fi, a frozen game) is dropped instead of letting the backlog grow in memory. Phones reconnect
 * and get their current screen; a game resumes its session.
 */
export function send(socket, message) {
	if (!socket || socket.readyState !== 1) return false;
	if (socket.bufferedAmount > (socket.maxBuffered ?? Infinity)) {
		socket.overflowed = true;
		try { socket.terminate(); } catch { }
		return false;
	}
	try {
		socket.send(typeof message === "string" ? message : JSON.stringify(message));
		return true;
	} catch {
		return false;
	}
}

/** Walk a screen's element tree and call fn for each element. */
function eachElement(elements, fn) {
	if (!Array.isArray(elements)) return;
	for (const el of elements) {
		if (!el || typeof el !== "object") continue;
		fn(el);
		if (Array.isArray(el.children)) eachElement(el.children, fn);
	}
}

/** Apply an element update to a cached screen (so reconnecting phones see the current state). */
function patchScreen(screen, id, set) {
	if (!screen) return;
	if (id === "$screen") {
		for (const [k, v] of Object.entries(set)) if (k !== "elements") screen[k] = v;
		return;
	}
	eachElement(screen.elements, (el) => {
		if (el.id === id) Object.assign(el, set);
	});
}

const clone = (v) => (v == null ? v : structuredClone(v));

export class Session {
	/**
	 * @param {object} opts
	 * @param {string} opts.code
	 * @param {object} opts.theme resolved theme
	 * @param {number} opts.maxPlayers
	 * @param {import("./index.js").Logger} opts.log
	 */
	constructor({ code, theme, maxPlayers, hostGraceMs, playerRateLimit, log, onEnd, rejoinByName = false }) {
		this.code = code;
		this.hostToken = randomToken();
		this.created = Date.now();
		this.theme = theme;
		this.maxPlayers = maxPlayers;
		/** A phone without its token can take back a disconnected player with the same name. */
		this.rejoinByName = rejoinByName;
		this.hostGraceMs = hostGraceMs;
		this.playerRateLimit = playerRateLimit;
		this.log = log;
		this.onEnd = onEnd;
		this.lobbyOpen = true;
		this.host = null;
		this.hostGoneTimer = null;
		this.ended = false;
		/** @type {Map<string, any>} */
		this.players = new Map();
		this.defaultScreen = null;
		this.nextSlot = 1;
		this.seq = 0;
	}

	get now() {
		return Date.now() - this.created;
	}

	// ------------------------------------------------------------------ host

	attachHost(socket, { resumed, joinUrl }) {
		if (this.host && this.host !== socket) {
			try { this.host.close(4000, "replaced"); } catch { }
		}
		clearTimeout(this.hostGoneTimer);
		this.hostGoneTimer = null;
		this.host = socket;
		send(socket, {
			type: "ready",
			code: this.code,
			hostToken: this.hostToken,
			joinUrl,
			resumed: !!resumed,
			maxPlayers: this.maxPlayers,
			lobbyOpen: this.lobbyOpen,
			theme: this.theme,
			players: [...this.players.values()].map((p) => this.describe(p)),
		});
		if (resumed) this.broadcastPhones({ type: "status", message: null });
	}

	detachHost(socket) {
		if (this.host !== socket) return;
		this.host = null;
		if (this.ended) return;
		this.broadcastPhones({ type: "status", message: "Waiting for the game to reconnect..." });
		this.hostGoneTimer = setTimeout(() => this.end("The game has closed."), this.hostGraceMs);
	}

	toHost(message) {
		send(this.host, message);
	}

	/** Handle one parsed message from the host. Returns an error string or null. */
	handleHost(msg) {
		if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return "bad message";
		const targets = this.targets(msg.to);

		switch (msg.type) {
			case "show": {
				const screen = msg.screen && typeof msg.screen === "object" ? msg.screen : {};
				if (msg.to == null) {
					this.defaultScreen = screen;
					for (const p of this.players.values()) p.screen = null;
				} else {
					for (const p of targets) p.screen = clone(screen);
				}
				for (const p of targets) send(p.socket, { type: "screen", screen });
				return null;
			}
			case "update": {
				if (typeof msg.id !== "string" || !msg.set || typeof msg.set !== "object") return "update needs id and set";
				if (msg.to == null) {
					patchScreen(this.defaultScreen, msg.id, msg.set);
					for (const p of this.players.values()) patchScreen(p.screen, msg.id, msg.set);
				} else {
					for (const p of targets) {
						if (!p.screen) p.screen = clone(this.defaultScreen);
						patchScreen(p.screen, msg.id, msg.set);
					}
				}
				for (const p of targets) send(p.socket, { type: "update", id: msg.id, set: msg.set });
				return null;
			}
			case "feedback": {
				const fb = msg.feedback && typeof msg.feedback === "object" ? msg.feedback : {};
				for (const p of targets) send(p.socket, { type: "feedback", feedback: fb });
				return null;
			}
			case "send": {
				// Free-form data for custom elements in a theme script.
				for (const p of targets) send(p.socket, { type: "custom", data: msg.data ?? null });
				return null;
			}
			case "player": {
				const p = this.players.get(msg.id);
				if (!p) return "unknown player";
				if (typeof msg.color === "string") p.color = msg.color.slice(0, 64);
				if (typeof msg.badge === "string" || msg.badge === null) p.badge = msg.badge ? String(msg.badge).slice(0, 32) : null;
				if (typeof msg.avatar === "string" || msg.avatar === null) p.avatar = msg.avatar;
				send(p.socket, { type: "player", ...this.describe(p) });
				return null;
			}
			case "theme": {
				if (!msg.theme || typeof msg.theme !== "object") return "theme needs an object";
				this.theme = this.composeTheme ? this.composeTheme(msg.theme) : msg.theme;
				this.broadcastPhones({ type: "theme", theme: this.theme });
				return null;
			}
			case "lobby": {
				if (typeof msg.open === "boolean") this.lobbyOpen = msg.open;
				if (Number.isInteger(msg.maxPlayers) && msg.maxPlayers > 0) this.maxPlayers = Math.min(msg.maxPlayers, this.maxPlayersCap ?? msg.maxPlayers);
				return null;
			}
			case "kick": {
				const p = this.players.get(msg.id);
				if (!p) return "unknown player";
				this.removePlayer(p, typeof msg.reason === "string" ? msg.reason : "You were removed from the game.");
				return null;
			}
			case "end":
				this.end(typeof msg.reason === "string" ? msg.reason : "The game has ended.");
				return null;
			case "ping":
				send(this.host, { type: "pong", t: msg.t ?? null });
				return null;
			default:
				return `unknown message type "${msg.type}"`;
		}
	}

	targets(to) {
		if (to == null) return [...this.players.values()];
		const ids = Array.isArray(to) ? to : [to];
		return ids.map((id) => this.players.get(id)).filter(Boolean);
	}

	// ---------------------------------------------------------------- phones

	describe(p) {
		return { id: p.id, name: p.name, slot: p.slot, color: p.color, badge: p.badge, avatar: p.avatar ?? null, connected: !!p.socket };
	}

	/**
	 * A phone wants in. Returns {player} or {error}.
	 * A phone with a valid token rejoins as the same player even when the lobby is closed.
	 */
	joinPlayer(socket, { name, token }) {
		if (this.ended) return { error: "That game has ended." };

		let existing = token ? [...this.players.values()].find((p) => p.token === token) : null;
		// Same person back without their token (cleared storage, another browser): give them their player back,
		// but only a disconnected one, so nobody can take over someone who's still playing.
		if (!existing && this.rejoinByName) {
			const wanted = cleanName(name)?.toLowerCase();
			if (wanted) existing = [...this.players.values()].find((p) => !p.socket && p.name.toLowerCase() === wanted) ?? null;
		}
		if (existing) {
			if (existing.socket && existing.socket !== socket) {
				existing.replacedSocket = existing.socket;
				send(existing.socket, { type: "ended", message: "You joined from another tab or device.", reason: "replaced" });
				try { existing.socket.close(4000, "replaced"); } catch { }
			}
			existing.socket = socket;
			this.welcome(existing, true);
			return { player: existing };
		}

		const clean = cleanName(name);
		if (!clean) return { error: "Please enter a name." };
		if (!this.lobbyOpen) return { error: "This game isn't taking new players right now." };
		if (this.players.size >= this.maxPlayers) return { error: "This game is full." };

		// Keep names unique so the TV never shows two "Sam"s.
		let unique = clean;
		const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
		for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${clean.slice(0, MAX_NAME - 3)} ${n}`;

		const slot = this.nextSlot++;
		const player = {
			id: "p" + slot,
			name: unique,
			slot,
			token: randomToken(),
			socket,
			color: PLAYER_COLORS[(slot - 1) % PLAYER_COLORS.length],
			badge: null,
			avatar: null,
			screen: null,
			bucket: this.playerRateLimit,
			bucketAt: Date.now(),
			seq: 0,
		};
		this.players.set(player.id, player);
		this.welcome(player, false);
		return { player };
	}

	welcome(p, rejoin) {
		send(p.socket, {
			type: "welcome",
			code: this.code,
			token: p.token,
			rejoin,
			...this.describe(p),
			theme: this.theme,
			screen: p.screen ?? this.defaultScreen,
			status: this.host ? null : "Waiting for the game to reconnect...",
		});
		this.toHost({ type: "join", player: this.describe(p), rejoin });
	}

	detachPlayer(p, socket) {
		if (p.socket !== socket) return; // an old, replaced socket
		p.socket = null;
		if (this.players.get(p.id) === p) this.toHost({ type: "status", id: p.id, connected: false });
	}

	removePlayer(p, reason) {
		this.players.delete(p.id);
		send(p.socket, { type: "ended", message: reason, reason: "kicked" });
		try { p.socket?.close(4001, "kicked"); } catch { }
		p.socket = null;
		this.toHost({ type: "leave", id: p.id, reason: "kicked" });
	}

	/** Handle one parsed message from a phone. */
	handlePlayer(p, msg) {
		if (!msg || typeof msg !== "object") return;
		if (msg.type === "ping") return send(p.socket, { type: "pong", t: msg.t ?? null });
		if (msg.type === "leave") {
			this.players.delete(p.id);
			try { p.socket?.close(1000, "left"); } catch { }
			p.socket = null;
			return this.toHost({ type: "leave", id: p.id, reason: "left" });
		}
		if (msg.type !== "input") return;

		// Token bucket: refill to playerRateLimit per second.
		const now = Date.now();
		p.bucket = Math.min(this.playerRateLimit, p.bucket + ((now - p.bucketAt) / 1000) * this.playerRateLimit);
		p.bucketAt = now;
		if (p.bucket < 1) return;
		p.bucket -= 1;

		const input = sanitiseInput(msg);
		if (!input) return;
		this.toHost({ type: "input", from: p.id, ...input, seq: ++p.seq, t: this.now });
	}

	broadcastPhones(message) {
		const text = JSON.stringify(message);
		for (const p of this.players.values()) send(p.socket, text);
	}

	end(reason) {
		if (this.ended) return;
		this.ended = true;
		clearTimeout(this.hostGoneTimer);
		for (const p of this.players.values()) {
			send(p.socket, { type: "ended", message: reason, reason: "ended" });
			try { p.socket?.close(4001, "ended"); } catch { }
		}
		send(this.host, { type: "ended", message: reason });
		try { this.host?.close(4001, "ended"); } catch { }
		this.players.clear();
		this.host = null;
		this.onEnd?.(this);
	}
}

function finite(n) {
	return typeof n === "number" && Number.isFinite(n);
}

/** Keep only well-formed input fields, so the host never sees garbage. */
export function sanitiseInput(msg) {
	if (typeof msg.el !== "string" || !msg.el || msg.el.length > MAX_ID) return null;
	if (typeof msg.ev !== "string" || !msg.ev || msg.ev.length > 32) return null;
	const out = { el: msg.el, ev: msg.ev };
	if (typeof msg.key === "string" && msg.key.length <= MAX_ID) out.key = msg.key;
	if (finite(msg.x)) out.x = Math.max(-1e6, Math.min(1e6, msg.x));
	if (finite(msg.y)) out.y = Math.max(-1e6, Math.min(1e6, msg.y));
	if (finite(msg.held)) out.held = Math.max(0, msg.held);
	if (typeof msg.value === "string" || finite(msg.value) || typeof msg.value === "boolean") out.value = msg.value;
	if (Array.isArray(msg.values)) out.values = msg.values.filter((v) => typeof v === "string").slice(0, 64);
	return out;
}

export class SessionManager {
	constructor({ config, log, resolveTheme }) {
		this.config = config;
		this.log = log;
		this.resolveTheme = resolveTheme;
		/** @type {Map<string, Session>} */
		this.sessions = new Map();
	}

	get size() {
		return this.sessions.size;
	}

	create({ theme, maxPlayers, rejoinByName = false }) {
		if (this.sessions.size >= this.config.maxSessions) return null;
		let code = null;
		for (let i = 0; i < 50 && !code; i++) {
			const c = Array.from(crypto.randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
			if (!this.sessions.has(c)) code = c;
		}
		if (!code) return null;
		const session = new Session({
			code,
			theme: this.resolveTheme(theme),
			maxPlayers: Math.min(maxPlayers || this.config.maxPlayers, this.config.maxPlayers),
			rejoinByName,
			hostGraceMs: this.config.hostGraceSeconds * 1000,
			playerRateLimit: this.config.playerRateLimit,
			log: this.log,
			onEnd: (s) => {
				this.sessions.delete(s.code);
				this.log.info(`session ${s.code} ended (${this.sessions.size} active)`);
			},
		});
		session.maxPlayersCap = this.config.maxPlayers;
		session.composeTheme = this.resolveTheme;
		this.sessions.set(code, session);
		this.log.info(`session ${code} created (${this.sessions.size} active)`);
		return session;
	}

	get(code) {
		const c = normaliseCode(code);
		return c ? this.sessions.get(c) ?? null : null;
	}

	byHostToken(token) {
		if (!token) return null;
		for (const s of this.sessions.values()) if (s.hostToken === token) return s;
		return null;
	}

	endAll(reason) {
		for (const s of [...this.sessions.values()]) s.end(reason);
	}
}
