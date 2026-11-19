// Server configuration, read from environment variables.
// Every option has a safe default so `node src/index.js` just works for local development.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function int(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) throw new Error(`${name} must be a whole number, got "${raw}"`);
	return n;
}

function list(name) {
	return (process.env[name] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function loadConfig(overrides = {}) {
	const config = {
		/** Port to listen on. */
		port: int("PORT", 8080),
		/** Interface to bind. */
		host: process.env.HOST || "0.0.0.0",
		/**
		 * Public base URL phones use, e.g. https://pad.example.com. When unset, the server builds it
		 * from each request's Host header (fine on a LAN, set it behind a reverse proxy).
		 */
		publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
		/** Optional comma-separated host keys. When set, games must pass one to create a session. */
		hostKeys: list("HOST_KEYS"),
		/**
		 * Require games to prove they're a real s&box player (s&box auth tokens) before creating a session.
		 * Off by default, so local testing works without Steam. Resuming a session never needs it.
		 */
		sboxAuth: /^(1|true|yes)$/i.test(process.env.SBOX_AUTH || ""),
		/** Facepunch's token check endpoint. Only change it for testing. */
		sboxAuthUrl: process.env.SBOX_AUTH_URL || "https://public.facepunch.com/sbox/auth/token",
		/** Theme used when a game doesn't pick one, and for the plain join page. */
		defaultTheme: process.env.DEFAULT_THEME || "default",
		/** Extra theme folders (each subfolder is a theme). Mount your branding here in Docker. */
		themesDir: process.env.THEMES_DIR || "/themes",
		/** Built-in themes shipped with the server. */
		builtinThemesDir: path.join(here, "..", "themes"),
		/** Phone web client. */
		publicDir: path.join(here, "..", "public"),
		maxSessions: int("MAX_SESSIONS", 500),
		/**
		 * Most phones in one session (games can ask for fewer). Roomy by default so games with an audience or
		 * spectators work without configuration; each phone is one small WebSocket.
		 */
		maxPlayers: int("MAX_PLAYERS", 100),
		/** How long a session survives without its game connected. */
		hostGraceSeconds: int("HOST_GRACE_SECONDS", 120),
		/** Biggest single message, in KB. Drawings are sent as PNG data URLs, so keep this roomy. */
		maxMessageKb: int("MAX_MESSAGE_KB", 1024),
		/**
		 * Most unsent data, in KB, the server holds for one connection before dropping it. Stops a phone on
		 * bad Wi-Fi (or a frozen game) from piling up messages in memory. It reconnects and catches up.
		 */
		maxBufferedKb: int("MAX_BUFFERED_KB", 4096),
		/** Inputs per second a single phone may send before extras are dropped. */
		playerRateLimit: int("PLAYER_RATE_LIMIT", 120),
		/** New sessions per minute from one IP address (0 = no limit). */
		createRateLimit: int("CREATE_RATE_LIMIT", 10),
		/**
		 * Wrong room codes per minute from one IP address before that address is refused for the rest of
		 * the minute (0 = no limit). Stops anyone scanning for live rooms. Players on the same Wi-Fi share
		 * an address, but only mistyped codes count, so normal joins and reconnects never use it up.
		 */
		joinRateLimit: int("JOIN_RATE_LIMIT", 30),
		/**
		 * Reverse proxies (IP addresses or CIDR ranges) whose X-Forwarded-* headers we believe. Loopback is
		 * always trusted. Example for Caddy on the Docker host: 172.16.0.0/12.
		 */
		trustedProxies: list("TRUSTED_PROXIES"),
		/** Old switch: believe X-Forwarded-* from anyone. Prefer TRUSTED_PROXIES. */
		trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ""),
		logLevel: process.env.LOG_LEVEL || "info",
		...overrides,
	};
	return config;
}
