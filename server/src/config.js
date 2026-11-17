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
		/** Theme used when a game doesn't pick one, and for the plain join page. */
		defaultTheme: process.env.DEFAULT_THEME || "default",
		/** Extra theme folders (each subfolder is a theme). Mount your branding here in Docker. */
		themesDir: process.env.THEMES_DIR || "/themes",
		/** Built-in themes shipped with the server. */
		builtinThemesDir: path.join(here, "..", "themes"),
		/** Phone web client. */
		publicDir: path.join(here, "..", "public"),
		maxSessions: int("MAX_SESSIONS", 500),
		maxPlayers: int("MAX_PLAYERS", 16),
		/** How long a session survives without its game connected. */
		hostGraceSeconds: int("HOST_GRACE_SECONDS", 120),
		/** Biggest single message, in KB. Drawings are sent as PNG data URLs, so keep this roomy. */
		maxMessageKb: int("MAX_MESSAGE_KB", 1024),
		/** Inputs per second a single phone may send before extras are dropped. */
		playerRateLimit: int("PLAYER_RATE_LIMIT", 120),
		/** Trust X-Forwarded-* headers (set when behind a reverse proxy). */
		trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ""),
		logLevel: process.env.LOG_LEVEL || "info",
		...overrides,
	};
	return config;
}
