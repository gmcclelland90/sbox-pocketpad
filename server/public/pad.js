// PocketPad phone client: core.
// Plain JS, no build step. Connection, theming, screen rendering, feedback and sensors live here;
// the built-in controls are in elements.js and register themselves with PocketPad.defineElement,
// the same way a theme's own script can add custom controls. See docs/protocol.md.
"use strict";

(function () {
	const $ = (id) => document.getElementById(id);
	const store = {
		get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
		set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { } },
	};

	const elementTypes = new Map();
	const state = {
		socket: null,
		code: null,
		name: null,
		me: null,          // {id, name, slot, color, badge}
		theme: null,
		screen: null,
		mounted: new Map(), // element id -> {def, api}
		want: false,        // keep reconnecting
		retry: 500,
		timer: null,
		sensors: { tilt: false, shake: false },
		loadedScripts: new Set(),
		customHandlers: new Set(),
	};

	// ------------------------------------------------------------------ public API

	const PocketPad = {
		version: "0.1.0",
		/**
		 * Register a control type. render(def, ctx) returns {node, update?(set), destroy?()}.
		 * Theme scripts call this to add custom controls.
		 */
		defineElement(type, render) { elementTypes.set(type, render); },
		/** Listen for data the game sends with session.Send(...). */
		onCustom(fn) { state.customHandlers.add(fn); return () => state.customHandlers.delete(fn); },
		send: (msg) => send(msg),
		feedback: (fb) => feedback(fb),
		get me() { return state.me; },
		get theme() { return state.theme; },
		start,
	};
	window.PocketPad = PocketPad;

	// ------------------------------------------------------------------ join

	function start() {
		const fromPath = location.pathname.match(/^\/([A-Za-z]{4})\/?$/);
		const params = new URLSearchParams(location.search);
		const code = (fromPath?.[1] || params.get("code") || "").toUpperCase();
		const codeInput = $("code"), nameInput = $("name");
		codeInput.value = code;
		nameInput.value = store.get("pocketpad:name") || "";
		codeInput.addEventListener("input", () => {
			codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "");
			if (codeInput.value.length === 4) previewTheme(codeInput.value);
		});

		$("join-form").addEventListener("submit", (e) => {
			e.preventDefault();
			unlockAudio();
			const c = codeInput.value.trim().toUpperCase();
			const n = nameInput.value.trim();
			if (c.length !== 4) return joinError(text("needCode", "Enter the 4-letter room code."));
			if (!n) return joinError(text("needName", "Enter your name."));
			store.set("pocketpad:name", n);
			connect(c, n, store.get("pocketpad:session:" + c)?.token);
		});

		applyTheme(null);
		fetch("/api/v1/info").then((r) => r.json()).then((info) => {
			if (!state.theme && info.defaultTheme) loadThemeByName(info.defaultTheme);
		}).catch(() => { });

		if (code) {
			previewTheme(code);
			// Refreshed mid-game? Rejoin as the same player.
			const saved = store.get("pocketpad:session:" + code);
			if (saved?.token) return connect(code, saved.name || nameInput.value, saved.token);
			setTimeout(() => (nameInput.value ? $("join-button") : nameInput).focus(), 50);
		}
	}

	function previewTheme(code) {
		fetch(`/api/v1/sessions/${code}`).then((r) => (r.ok ? r.json() : null)).then((info) => {
			if (info?.theme && !state.me) applyTheme(info.theme);
		}).catch(() => { });
	}

	function loadThemeByName(name) {
		fetch(`/api/v1/themes/${encodeURIComponent(name)}`).then((r) => r.json()).then((t) => { if (!state.theme) applyTheme(t); }).catch(() => { });
	}

	function joinError(message) {
		$("join-error").textContent = message || "";
		$("join-error").hidden = !message;
	}

	function showScreen(which) {
		$("join").hidden = which !== "join";
		$("game").hidden = which !== "game";
		document.body.dataset.screen = which;
	}

	// ------------------------------------------------------------------ connection

	function connect(code, name, token) {
		state.want = true;
		state.code = code;
		state.name = name;
		joinError("");
		$("join-button").disabled = true;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const q = new URLSearchParams({ code, name: name || "" });
		if (token) q.set("token", token);
		const ws = new WebSocket(`${proto}//${location.host}/ws/play?${q}`);
		state.socket = ws;
		let welcomed = false;

		ws.onmessage = (e) => {
			let msg;
			try { msg = JSON.parse(e.data); } catch { return; }
			if (msg.type === "welcome") welcomed = true;
			handle(msg);
		};
		ws.onclose = (e) => {
			if (state.socket !== ws) return;
			state.socket = null;
			$("join-button").disabled = false;
			if (!state.want) return;
			if (!welcomed && !state.me) {
				// Never got in. A stale token for an old session? Forget it and show the join form.
				store.set("pocketpad:session:" + code, null);
				return stop(e.code === 4004 || e.code === 4003 ? null : text("cantConnect", "Couldn't connect. Check the code and try again."));
			}
			setStatus(text("reconnecting", "Reconnecting..."));
			setTimeout(() => state.want && connect(state.code, state.name, store.get("pocketpad:session:" + state.code)?.token), state.retry);
			state.retry = Math.min(state.retry * 2, 4000);
		};
	}

	function stop(message) {
		state.want = false;
		state.me = null;
		try { state.socket?.close(); } catch { }
		state.socket = null;
		clearInterval(state.timer);
		unmountAll();
		releaseWakeLock();
		showScreen("join");
		joinError(message || "");
	}

	function send(msg) {
		const ws = state.socket;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	function sendInput(el, ev, data) {
		return send({ type: "input", el, ev, ...data });
	}

	function handle(msg) {
		switch (msg.type) {
			case "welcome":
				state.retry = 500;
				state.me = { id: msg.id, name: msg.name, slot: msg.slot, color: msg.color, badge: msg.badge, avatar: msg.avatar };
				store.set("pocketpad:session:" + msg.code, { token: msg.token, name: msg.name });
				if (msg.theme) applyTheme(msg.theme);
				applyPlayer();
				showScreen("game");
				requestWakeLock();
				renderScreen(msg.screen || defaultScreen());
				setStatus(msg.status || "");
				break;
			case "screen": renderScreen(msg.screen || {}); break;
			case "update": updateElement(msg.id, msg.set || {}); break;
			case "feedback": feedback(msg.feedback || {}); break;
			case "theme": applyTheme(msg.theme); renderScreen(state.screen || defaultScreen()); break;
			case "player": Object.assign(state.me ?? {}, msg); applyPlayer(); break;
			case "status": setStatus(msg.message || ""); break;
			case "custom": for (const fn of state.customHandlers) { try { fn(msg.data); } catch (e) { console.error(e); } } break;
			case "error":
				state.want = false;
				store.set("pocketpad:session:" + state.code, null);
				stop(msg.message);
				break;
			case "ended":
				state.want = false;
				if (msg.reason !== "replaced") store.set("pocketpad:session:" + state.code, null);
				stop(msg.message || text("ended", "The game has ended."));
				break;
		}
	}

	function defaultScreen() {
		return { title: text("joined", "You're in!"), subtitle: text("watch", "Watch the screen.") };
	}

	function setStatus(message) {
		$("status").textContent = message;
		$("status").hidden = !message;
	}

	// ------------------------------------------------------------------ theme

	const COLOR_VARS = {
		bg: "--bg", surface: "--surface", text: "--text", muted: "--muted", accent: "--accent", accentText: "--accent-text",
		button: "--button", buttonText: "--button-text", border: "--border", danger: "--danger", success: "--success",
	};

	function text(key, fallback) {
		return state.theme?.text?.[key] ?? fallback;
	}

	function applyTheme(theme) {
		state.theme = theme || state.theme || null;
		const t = state.theme || {};
		const root = document.documentElement;
		for (const v of Object.values(COLOR_VARS)) root.style.removeProperty(v);
		for (const [k, v] of Object.entries(t.colors || {})) if (COLOR_VARS[k] && typeof v === "string") root.style.setProperty(COLOR_VARS[k], v);
		if (t.radius != null) root.style.setProperty("--radius", typeof t.radius === "number" ? t.radius + "px" : t.radius);
		else root.style.removeProperty("--radius");
		if (t.font) root.style.setProperty("--font", t.fontUrl ? `"PocketPadThemeFont", ${t.font}` : t.font);
		else root.style.removeProperty("--font");
		root.style.setProperty("--bg-image", t.background ? `url("${t.background}")` : "none");
		document.body.dataset.theme = t.name || "default";

		let css = "";
		if (t.fontUrl) css += `@font-face { font-family: "PocketPadThemeFont"; src: url("${t.fontUrl}"); font-display: swap; }\n`;
		if (typeof t.css === "string") css += t.css;
		$("theme-css").textContent = css;
		$("theme-stylesheet").href = t.stylesheet || "data:text/css,";
		if (t.script && !state.loadedScripts.has(t.script)) {
			state.loadedScripts.add(t.script);
			const s = document.createElement("script");
			s.src = t.script;
			s.onload = () => state.screen && renderScreen(state.screen);
			document.head.append(s);
		}

		const meta = document.querySelector('meta[name="theme-color"]');
		meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || "#15131a";
		document.title = t.title || "PocketPad";
		$("join-title").textContent = t.title || "PocketPad";
		$("join-title").hidden = !!t.logo && t.hideTitle === true;
		$("join-subtitle").textContent = t.subtitle || "";
		$("logo").hidden = !t.logo;
		if (t.logo) $("logo").src = t.logo;
		$("powered").hidden = t.poweredBy === false;
		$("code-label").textContent = text("codeLabel", "Room code");
		$("name-label").textContent = text("nameLabel", "Your name");
		$("join-button").textContent = text("joinButton", "Join");
		applyPlayer();
	}

	function applyPlayer() {
		const me = state.me;
		if (!me) return;
		document.documentElement.style.setProperty("--player", me.color || "var(--accent)");
		$("me-name").textContent = me.name;
		$("me-badge").textContent = me.badge || "";
		$("me-badge").hidden = !me.badge;
	}

	// ------------------------------------------------------------------ rendering

	function renderScreen(screen) {
		state.screen = screen;
		unmountAll();
		$("title").textContent = screen.title || "";
		$("subtitle").textContent = screen.subtitle || "";
		$("heading").hidden = !screen.title && !screen.subtitle;
		$("round").textContent = screen.round || "";
		startTimer(screen.timer);
		const game = $("game");
		game.style.background = screen.background || "";
		game.dataset.layout = screen.layout || "stack";
		game.classList.toggle("scrolls", !!screen.scroll);
		const root = $("elements");
		root.replaceChildren();
		mountChildren(screen.elements || [], root);
		setSensors(screen.sensors || {});
	}

	function mountChildren(list, parent) {
		for (const def of list) {
			if (!def || typeof def !== "object") continue;
			const node = mountElement(def);
			if (node) parent.append(node);
		}
	}

	function mountElement(def) {
		const render = elementTypes.get(def.type);
		let api;
		if (!render) {
			const node = document.createElement("div");
			node.className = "el unknown";
			node.textContent = `(${def.type}?)`;
			api = { node };
		} else {
			try {
				api = render(def, makeContext(def)) || {};
			} catch (e) {
				console.error("PocketPad: element failed to render", def, e);
				return null;
			}
		}
		const node = api.node;
		if (!node) return null;
		node.classList.add("el", "el-" + def.type);
		if (def.id) node.dataset.id = def.id;
		if (def.class) node.classList.add(...String(def.class).split(/\s+/).filter(Boolean));
		styleNode(node, def);
		if (def.id) state.mounted.set(def.id, { def, api });
		else state.mounted.set(Symbol(), { def, api });
		return node;
	}

	function styleNode(node, def) {
		node.style.flex = def.flex != null ? String(def.flex) : "";
		if (def.color) node.style.setProperty("--el-color", resolveColor(def.color));
		if (def.textColor) node.style.setProperty("--el-text", resolveColor(def.textColor));
		node.hidden = !!def.hidden;
		node.classList.toggle("disabled", !!def.disabled);
	}

	function resolveColor(c) {
		if (c === "player") return "var(--player)";
		if (c === "accent") return "var(--accent)";
		if (c === "danger") return "var(--danger)";
		if (c === "success") return "var(--success)";
		return c;
	}

	function makeContext(def) {
		return {
			send: (ev, data) => {
				if (def.disabled) return false;
				return sendInput(def.id || def.type, ev, data);
			},
			haptic: (h) => haptic(h ?? def.haptic),
			sound: (s) => playSound(s),
			mount: (list, parent) => mountChildren(list, parent),
			resolveColor,
			get disabled() { return !!def.disabled; },
			get theme() { return state.theme; },
			get me() { return state.me; },
		};
	}

	function updateElement(id, set) {
		if (id === "$screen") {
			const s = state.screen || {};
			Object.assign(s, set);
			if ("title" in set) $("title").textContent = set.title || "";
			if ("subtitle" in set) $("subtitle").textContent = set.subtitle || "";
			if ("title" in set || "subtitle" in set) $("heading").hidden = !s.title && !s.subtitle;
			if ("timer" in set) startTimer(set.timer);
			if ("round" in set) $("round").textContent = set.round || "";
			if ("background" in set) $("game").style.background = set.background || "";
			if ("sensors" in set) setSensors(set.sensors || {});
			return;
		}
		const m = state.mounted.get(id);
		if (!m) return;
		Object.assign(m.def, set);
		styleNode(m.api.node, m.def);
		if (m.api.update) m.api.update(set, m.def);
	}

	function unmountAll() {
		for (const { api } of state.mounted.values()) { try { api.destroy?.(); } catch { } }
		state.mounted.clear();
	}

	function startTimer(seconds) {
		clearInterval(state.timer);
		const el = $("timer");
		if (seconds == null || seconds === false) { el.hidden = true; return; }
		el.hidden = false;
		const end = Date.now() + Number(seconds) * 1000;
		let last = null;
		const tick = () => {
			const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
			if (left !== last) {
				last = left;
				el.textContent = left;
				el.classList.toggle("low", left <= 3);
				if (left <= 3 && left > 0 && state.screen?.timerTicks !== false) playSound("tick");
			}
			if (left <= 0) clearInterval(state.timer);
		};
		tick();
		state.timer = setInterval(tick, 100);
	}

	// ------------------------------------------------------------------ feedback

	const HAPTICS = {
		tap: [8], press: [15], light: [6], medium: [20], heavy: [45],
		success: [15, 60, 25], error: [50, 40, 50, 40, 50], warning: [30, 50, 30], buzz: [220], long: [400],
	};

	function haptic(h) {
		if (!h || !navigator.vibrate) return;
		const pattern = Array.isArray(h) ? h.map(Number).filter(Number.isFinite) : HAPTICS[h] ?? (Number.isFinite(+h) ? [+h] : null);
		if (pattern) try { navigator.vibrate(pattern); } catch { }
	}

	let flashTimer = null;
	function feedback(fb) {
		if (fb.haptic) haptic(fb.haptic);
		if (fb.sound) playSound(fb.sound, fb.volume);
		if (fb.flash) {
			const el = $("flash");
			el.style.background = fb.flash === true ? "var(--player)" : resolveColor(fb.flash);
			el.classList.remove("on");
			void el.offsetWidth;
			el.classList.add("on");
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => el.classList.remove("on"), 450);
		}
		if (fb.shake) {
			document.body.classList.remove("shake");
			void document.body.offsetWidth;
			document.body.classList.add("shake");
			setTimeout(() => document.body.classList.remove("shake"), 500);
		}
		if (fb.toast) toast(fb.toast, fb.toastColor, fb.duration);
	}

	let toastTimer = null;
	function toast(message, color, duration) {
		const el = $("toast");
		el.textContent = message;
		el.style.background = color ? resolveColor(color) : "";
		el.hidden = false;
		el.classList.remove("show");
		void el.offsetWidth;
		el.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { el.classList.remove("show"); el.hidden = true; }, Math.max(500, (duration ?? 1.6) * 1000));
	}

	// Sounds are synthesised with WebAudio, so the client ships no audio files.
	// A theme can map any of these names (or new ones) to its own files in theme.json "sounds".
	let audio = null;
	const buffers = new Map();
	function unlockAudio() {
		if (!audio) {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) return;
			audio = new Ctx();
		}
		if (audio.state === "suspended") audio.resume().catch(() => { });
	}
	document.addEventListener("pointerdown", unlockAudio, { capture: true, passive: true });

	const SYNTHS = {
		tap: [["square", 660, 660, 0.04, 0.15]],
		click: [["triangle", 900, 700, 0.03, 0.2]],
		pop: [["sine", 400, 900, 0.08, 0.35]],
		tick: [["square", 1200, 1200, 0.03, 0.12]],
		coin: [["square", 988, 988, 0.07, 0.15], ["square", 1319, 1319, 0.25, 0.15, 0.07]],
		success: [["triangle", 523, 523, 0.1, 0.3], ["triangle", 659, 659, 0.1, 0.3, 0.1], ["triangle", 784, 784, 0.25, 0.3, 0.2]],
		fail: [["sawtooth", 300, 140, 0.45, 0.18]],
		buzz: [["sawtooth", 110, 100, 0.35, 0.25]],
		go: [["square", 880, 880, 0.35, 0.2]],
		whoosh: [["noise", 0, 0, 0.25, 0.25]],
		countdown: [["square", 440, 440, 0.12, 0.18]],
	};

	function playSound(name, volume = 1) {
		if (!name) return;
		unlockAudio();
		if (!audio) return;
		const url = state.theme?.sounds?.[name] ?? (/[/.]/.test(name) ? name : null);
		if (url) return playFile(url, volume);
		const parts = SYNTHS[name];
		if (!parts) return;
		const t0 = audio.currentTime + 0.005;
		for (const [wave, f0, f1, dur, vol, delay = 0] of parts) {
			const gain = audio.createGain();
			const start = t0 + delay;
			gain.gain.setValueAtTime(0.0001, start);
			gain.gain.exponentialRampToValueAtTime(vol * volume, start + 0.008);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
			gain.connect(audio.destination);
			let src;
			if (wave === "noise") {
				const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * dur), audio.sampleRate);
				const data = buf.getChannelData(0);
				for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
				src = audio.createBufferSource();
				src.buffer = buf;
			} else {
				src = audio.createOscillator();
				src.type = wave;
				src.frequency.setValueAtTime(f0, start);
				if (f1 !== f0) src.frequency.exponentialRampToValueAtTime(f1, start + dur);
			}
			src.connect(gain);
			src.start(start);
			src.stop(start + dur + 0.02);
		}
	}

	async function playFile(url, volume) {
		try {
			let buf = buffers.get(url);
			if (!buf) {
				const data = await (await fetch(url)).arrayBuffer();
				buf = await audio.decodeAudioData(data);
				buffers.set(url, buf);
			}
			const src = audio.createBufferSource();
			const gain = audio.createGain();
			gain.gain.value = volume;
			src.buffer = buf;
			src.connect(gain).connect(audio.destination);
			src.start();
		} catch (e) {
			console.warn("PocketPad: couldn't play", url, e);
		}
	}

	// ------------------------------------------------------------------ sensors

	let lastTilt = 0, lastTiltX = 0, lastTiltY = 0, lastShake = 0;
	function onOrientation(e) {
		if (!state.sensors.tilt || e.beta == null) return;
		const now = performance.now();
		if (now - lastTilt < (state.sensors.tiltInterval ?? 50)) return;
		// Map to the screen's current orientation: x = tilt right, y = tilt away (top edge down).
		const angle = (screen.orientation?.angle ?? window.orientation ?? 0) | 0;
		let x = e.gamma, y = -e.beta + (state.sensors.tiltRest ?? 30);
		if (angle === 90) { x = e.beta; y = e.gamma + (state.sensors.tiltRest ?? 30) * 0; }
		else if (angle === -90 || angle === 270) { x = -e.beta; y = -e.gamma; }
		const range = state.sensors.tiltRange ?? 35;
		x = Math.max(-1, Math.min(1, x / range));
		y = Math.max(-1, Math.min(1, y / range));
		if (Math.abs(x - lastTiltX) < 0.02 && Math.abs(y - lastTiltY) < 0.02) return;
		lastTilt = now; lastTiltX = x; lastTiltY = y;
		sendInput("$tilt", "tilt", { x: round(x), y: round(y) });
	}
	function onMotion(e) {
		if (!state.sensors.shake) return;
		const a = e.acceleration?.x != null ? e.acceleration : e.accelerationIncludingGravity;
		if (!a) return;
		const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
		const threshold = e.acceleration?.x != null ? 15 : 25;
		const now = performance.now();
		if (mag > threshold && now - lastShake > 300) {
			lastShake = now;
			sendInput("$shake", "shake", { value: round(mag) });
		}
	}
	window.addEventListener("deviceorientation", onOrientation);
	window.addEventListener("devicemotion", onMotion);

	function setSensors(s) {
		state.sensors = { ...s, tilt: !!s.tilt, shake: !!s.shake };
		if (typeof s.tilt === "object") Object.assign(state.sensors, { tiltRange: s.tilt.range, tiltInterval: s.tilt.interval, tiltRest: s.tilt.rest });
		const needs = (state.sensors.tilt || state.sensors.shake) && typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function" && !state.motionGranted;
		$("motion").hidden = !needs;
	}

	$("motion").addEventListener("click", async () => {
		try {
			const r1 = await DeviceOrientationEvent.requestPermission();
			if (typeof DeviceMotionEvent?.requestPermission === "function") await DeviceMotionEvent.requestPermission();
			state.motionGranted = r1 === "granted";
		} catch { state.motionGranted = false; }
		$("motion").hidden = !!state.motionGranted;
		if (!state.motionGranted) toast(text("motionDenied", "Motion access was blocked. Check your browser settings."));
	});

	// ------------------------------------------------------------------ wake lock

	let wakeLock = null;
	async function requestWakeLock() {
		try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch { }
	}
	function releaseWakeLock() { try { wakeLock?.release(); } catch { } wakeLock = null; }
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && state.me) requestWakeLock();
	});

	// Stop iOS double-tap zoom and long-press menus during play.
	document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
	document.addEventListener("contextmenu", (e) => { if (document.body.dataset.screen === "game") e.preventDefault(); });

	function round(n) { return Math.round(n * 1000) / 1000; }
	PocketPad.util = { round, haptic, playSound, resolveColor };
})();
