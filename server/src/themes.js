// Themes: branding for the phone client.
//
// A theme is a folder with a theme.json and any assets it references (logo, fonts, sounds,
// background, an extra stylesheet, a script with custom elements). Built-in themes live in
// server/themes; operators add their own by mounting a folder at THEMES_DIR (/themes in Docker).
// Assets are served at /themes/<name>/<file>, and relative paths in theme.json are rewritten to
// those URLs, so a theme folder is self-contained.

import fs from "node:fs";
import path from "node:path";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
// theme.json keys whose values are paths to files inside the theme folder.
const ASSET_KEYS = ["logo", "background", "stylesheet", "script", "fontUrl", "icon"];

export class ThemeStore {
	constructor({ dirs, defaultTheme, log }) {
		this.dirs = dirs; // searched in order; later dirs override earlier ones
		this.defaultName = defaultTheme;
		this.log = log;
		this.cache = new Map();
	}

	/** Absolute folder for a theme name, or null. */
	folder(name) {
		if (!NAME.test(name ?? "")) return null;
		for (const dir of [...this.dirs].reverse()) {
			const f = path.join(dir, name);
			if (fs.existsSync(path.join(f, "theme.json"))) return f;
		}
		return null;
	}

	list() {
		const names = new Set();
		for (const dir of this.dirs) {
			let entries = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
			for (const e of entries) if (e.isDirectory() && this.folder(e.name)) names.add(e.name);
		}
		return [...names].sort();
	}

	/** Load a theme by name, falling back to the default theme. Always returns an object. */
	get(name) {
		const wanted = name && this.folder(name) ? name : this.defaultName;
		const resolved = this.folder(wanted) ? wanted : "default";
		const folder = this.folder(resolved);
		if (!folder) return { name: "default", base: "/themes/default/" };

		const file = path.join(folder, "theme.json");
		let mtime = 0;
		try { mtime = fs.statSync(file).mtimeMs; } catch { }
		const cached = this.cache.get(resolved);
		if (cached && cached.mtime === mtime) return structuredClone(cached.theme);

		let json = {};
		try {
			json = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (e) {
			this.log.warn(`theme ${resolved}: couldn't read theme.json (${e.message})`);
		}
		const base = `/themes/${resolved}/`;
		const theme = { ...json, name: resolved, base };
		for (const key of ASSET_KEYS) theme[key] = resolveAsset(theme[key], base);
		if (theme.sounds && typeof theme.sounds === "object") {
			for (const [k, v] of Object.entries(theme.sounds)) theme.sounds[k] = resolveAsset(v, base);
		}
		this.cache.set(resolved, { mtime, theme });
		return structuredClone(theme);
	}

	/**
	 * Build the theme a game asked for: a named base theme plus inline overrides.
	 * Inline overrides can't add scripts (only operators can, through theme folders).
	 */
	compose(request) {
		if (typeof request === "string") return this.get(request);
		if (!request || typeof request !== "object") return this.get(null);
		const base = this.get(request.use ?? request.name ?? null);
		const out = { ...base };
		for (const [k, v] of Object.entries(request)) {
			if (k === "use" || k === "name" || k === "base" || k === "script") continue;
			if (k === "colors" && v && typeof v === "object") out.colors = { ...(base.colors ?? {}), ...v };
			else if (k === "sounds" && v && typeof v === "object") out.sounds = { ...(base.sounds ?? {}), ...v };
			else if (k === "text" && v && typeof v === "object") out.text = { ...(base.text ?? {}), ...v };
			else out[k] = v;
		}
		if (typeof out.css === "string") out.css = out.css.slice(0, 20000);
		return out;
	}
}

function resolveAsset(value, base) {
	if (typeof value !== "string" || !value) return value ?? null;
	if (/^(https?:|data:|\/)/i.test(value)) return value;
	return base + value.replace(/^\.\//, "");
}
