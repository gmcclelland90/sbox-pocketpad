// PocketPad built-in controls. Each one is registered with PocketPad.defineElement(type, render),
// exactly like a theme's custom controls. render(def, ctx) returns {node, update?(set, def), destroy?()}.
// ctx.send(ev, data) sends an input event to the game, tagged with this element's id.
"use strict";

(function () {
	const P = window.PocketPad;
	const { round } = P.util;
	const h = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
	const now = () => performance.now();

	/** Pointer helper: tracks one pointer on a node with capture. */
	function track(node, { down, move, up }) {
		let id = null;
		node.addEventListener("pointerdown", (e) => {
			if (id !== null) return;
			e.preventDefault();
			id = e.pointerId;
			try { node.setPointerCapture(id); } catch { }
			down?.(e);
		});
		node.addEventListener("pointermove", (e) => { if (e.pointerId === id) move?.(e); });
		const end = (e) => {
			if (e.pointerId !== id) return;
			id = null;
			up?.(e);
		};
		node.addEventListener("pointerup", end);
		node.addEventListener("pointercancel", end);
		node.addEventListener("lostpointercapture", end);
		return { get active() { return id !== null; } };
	}

	/** Throttle continuous values: at most one send per interval, always sends the latest. */
	function throttled(fn, interval = 33) {
		let last = 0, pending = null, timer = null;
		const flush = () => { timer = null; last = now(); if (pending) { const a = pending; pending = null; fn(...a); } };
		return (...args) => {
			pending = args;
			const wait = interval - (now() - last);
			if (wait <= 0) flush();
			else if (!timer) timer = setTimeout(flush, wait);
		};
	}

	const iconText = (def) => def.icon ? def.icon + (def.label ? " " + def.label : "") : (def.label ?? "");

	// ---------------------------------------------------------------- display

	P.defineElement("text", (def) => {
		const node = h("div", `size-${def.size || "m"} align-${def.align || "center"}`, def.text ?? "");
		return { node, update: (s) => { if ("text" in s) node.textContent = s.text ?? ""; } };
	});

	P.defineElement("image", (def) => {
		const node = h("div");
		const img = h("img");
		img.alt = def.alt || "";
		img.src = def.src || "";
		img.style.objectFit = def.fit || "contain";
		img.draggable = false;
		node.append(img);
		return { node, update: (s) => { if ("src" in s) img.src = s.src || ""; } };
	});

	P.defineElement("progress", (def) => {
		const node = h("div");
		const label = h("span", "progress-label", def.label ?? "");
		const bar = h("div", "progress-bar");
		const fill = h("div", "progress-fill");
		bar.append(fill);
		node.append(label, bar);
		const set = (d) => {
			fill.style.width = clamp(Number(d.value) || 0, 0, 1) * 100 + "%";
			label.textContent = d.label ?? "";
			label.hidden = !d.label;
		};
		set(def);
		return { node, update: (_, d) => set(d) };
	});

	P.defineElement("spacer", () => ({ node: h("div") }));

	P.defineElement("row", (def, ctx) => {
		const node = h("div");
		if (def.gap != null) node.style.gap = def.gap + "px";
		ctx.mount(def.children || [], node);
		return { node };
	});

	P.defineElement("column", (def, ctx) => {
		const node = h("div");
		if (def.gap != null) node.style.gap = def.gap + "px";
		ctx.mount(def.children || [], node);
		return { node };
	});

	// ---------------------------------------------------------------- button
	// ev "down" on touch, "up" on release with held = milliseconds. Use either, or both for hold games.

	P.defineElement("button", (def, ctx) => {
		const node = h("button", `shape-${def.shape || "rect"}`);
		node.type = "button";
		const label = h("span", "label", iconText(def));
		node.append(label);
		if (def.sublabel) node.append(h("small", null, def.sublabel));
		let downAt = 0;
		track(node, {
			down: () => {
				if (ctx.disabled) return;
				downAt = now();
				node.classList.add("pressed");
				ctx.send("down", def.key ? { key: def.key } : {});
				ctx.haptic(def.haptic ?? "tap");
				if (def.sound) ctx.sound(def.sound);
			},
			up: () => {
				if (!node.classList.contains("pressed")) return;
				node.classList.remove("pressed");
				ctx.send("up", { ...(def.key ? { key: def.key } : {}), held: Math.round(now() - downAt) });
			},
		});
		return {
			node,
			update: (s, d) => {
				if ("label" in s || "icon" in s) label.textContent = iconText(d);
			},
		};
	});

	// ---------------------------------------------------------------- dpad
	// One touch area: slide your thumb between directions. ev "down"/"up" with key = up/down/left/right
	// (diagonals send two keys when diagonals: true).

	P.defineElement("dpad", (def, ctx) => {
		const node = h("div");
		const pad = h("div", "dpad-pad");
		const dirs = ["up", "left", "right", "down"];
		const arrows = { up: "▲", down: "▼", left: "◀", right: "▶" };
		const parts = {};
		for (const d of dirs) {
			const b = h("div", `dpad-dir dpad-${d}`, (def.labels && def.labels[d]) || arrows[d]);
			parts[d] = b;
			pad.append(b);
		}
		pad.append(h("div", "dpad-center"));
		node.append(pad);
		const held = new Set();
		const setHeld = (next) => {
			for (const k of [...held]) if (!next.has(k)) { held.delete(k); parts[k].classList.remove("pressed"); ctx.send("up", { key: k }); }
			for (const k of next) if (!held.has(k)) { held.add(k); parts[k].classList.add("pressed"); ctx.send("down", { key: k }); ctx.haptic(def.haptic ?? "tap"); }
		};
		const fromPoint = (e) => {
			const r = pad.getBoundingClientRect();
			const x = (e.clientX - r.left) / r.width * 2 - 1;
			const y = (e.clientY - r.top) / r.height * 2 - 1;
			const next = new Set();
			if (Math.hypot(x, y) < 0.22) return next; // dead zone in the middle
			if (def.diagonals) {
				if (x < -0.38) next.add("left"); else if (x > 0.38) next.add("right");
				if (y < -0.38) next.add("up"); else if (y > 0.38) next.add("down");
				if (next.size === 0) next.add(Math.abs(x) > Math.abs(y) ? (x < 0 ? "left" : "right") : (y < 0 ? "up" : "down"));
			} else {
				next.add(Math.abs(x) > Math.abs(y) ? (x < 0 ? "left" : "right") : (y < 0 ? "up" : "down"));
			}
			return next;
		};
		track(pad, {
			down: (e) => !ctx.disabled && setHeld(fromPoint(e)),
			move: (e) => !ctx.disabled && setHeld(fromPoint(e)),
			up: () => setHeld(new Set()),
		});
		return { node, destroy: () => setHeld(new Set()) };
	});

	// ---------------------------------------------------------------- joystick
	// ev "move" with x, y in -1..1 (x right, y UP), throttled; ev "up" with x = y = 0 on release.

	P.defineElement("joystick", (def, ctx) => {
		const node = h("div");
		const base = h("div", "stick-base");
		const knob = h("div", "stick-knob");
		if (def.label) base.append(h("span", "stick-label", def.label));
		base.append(knob);
		node.append(base);
		const deadzone = def.deadzone ?? 0.12;
		let lx = 0, ly = 0;
		const sendMove = throttled((x, y) => ctx.send("move", { x, y }), def.interval ?? 33);
		let origin = null;
		const place = (e) => {
			const r = base.getBoundingClientRect();
			const cx = origin ? origin.x : r.left + r.width / 2;
			const cy = origin ? origin.y : r.top + r.height / 2;
			const radius = r.width / 2 * 0.75;
			let dx = (e.clientX - cx) / radius, dy = (e.clientY - cy) / radius;
			const len = Math.hypot(dx, dy);
			if (len > 1) { dx /= len; dy /= len; }
			knob.style.transform = `translate(${dx * radius}px, ${dy * radius}px)`;
			let x = dx, y = -dy;
			if (Math.hypot(x, y) < deadzone) { x = 0; y = 0; }
			if (def.axis === "x") y = 0;
			if (def.axis === "y") x = 0;
			x = round(x); y = round(y);
			if (Math.abs(x - lx) < 0.015 && Math.abs(y - ly) < 0.015) return;
			lx = x; ly = y;
			sendMove(x, y);
		};
		track(base, {
			down: (e) => {
				if (ctx.disabled) return;
				// "floating" sticks centre on where the thumb lands.
				origin = def.floating ? { x: e.clientX, y: e.clientY } : null;
				base.classList.add("pressed");
				ctx.haptic(def.haptic ?? "light");
				ctx.send("down", {});
				place(e);
			},
			move: (e) => base.classList.contains("pressed") && place(e),
			up: () => {
				base.classList.remove("pressed");
				knob.style.transform = "";
				lx = 0; ly = 0;
				setTimeout(() => ctx.send("up", { x: 0, y: 0 }), 0);
			},
		});
		return { node };
	});

	// ---------------------------------------------------------------- touchpad
	// ev "down"/"move"/"up" with x, y in 0..1 from the top-left.

	P.defineElement("touchpad", (def, ctx) => {
		const node = h("div");
		const dot = h("div", "touch-dot");
		if (def.label) node.append(h("span", "touch-label", def.label));
		node.append(dot);
		const pos = (e) => {
			const r = node.getBoundingClientRect();
			const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
			dot.style.left = x * 100 + "%";
			dot.style.top = y * 100 + "%";
			return { x: round(x), y: round(y) };
		};
		const sendMove = throttled((p) => ctx.send("move", p), def.interval ?? 33);
		let last = null;
		track(node, {
			down: (e) => { if (ctx.disabled) return; node.classList.add("pressed"); last = pos(e); ctx.send("down", last); ctx.haptic(def.haptic ?? "light"); },
			move: (e) => { if (!node.classList.contains("pressed")) return; last = pos(e); sendMove(last); },
			up: (e) => { if (!node.classList.contains("pressed")) return; node.classList.remove("pressed"); setTimeout(() => ctx.send("up", pos(e)), 0); },
		});
		return { node };
	});

	// ---------------------------------------------------------------- swipe
	// ev "swipe" with key = up/down/left/right and x, y = direction * speed (screen widths per second,
	// y UP). A quick touch without movement sends ev "tap".

	P.defineElement("swipe", (def, ctx) => {
		const node = h("div");
		node.append(h("span", "swipe-label", def.label ?? "Swipe!"));
		let start = null;
		track(node, {
			down: (e) => { if (!ctx.disabled) start = { x: e.clientX, y: e.clientY, t: now() }; },
			up: (e) => {
				if (!start) return;
				const dx = e.clientX - start.x, dy = e.clientY - start.y;
				const dt = Math.max(16, now() - start.t) / 1000;
				const w = Math.max(window.innerWidth, 1);
				start = null;
				const dist = Math.hypot(dx, dy);
				if (dist < (def.minDistance ?? 30)) { ctx.send("tap", {}); ctx.haptic("light"); return; }
				const key = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
				if (def.directions && !def.directions.includes(key)) return;
				ctx.send("swipe", { key, x: round(dx / w / dt), y: round(-dy / w / dt) });
				ctx.haptic(def.haptic ?? "tap");
				node.dataset.last = key;
				node.classList.remove("swiped");
				void node.offsetWidth;
				node.classList.add("swiped");
			},
		});
		return { node };
	});

	// ---------------------------------------------------------------- slider
	// ev "change" with value while dragging (throttled), ev "set" with the final value on release.

	P.defineElement("slider", (def, ctx) => {
		const node = h("div", def.vertical ? "vertical" : "");
		const label = h("span", "slider-label", def.label ?? "");
		label.hidden = !def.label;
		const input = h("input");
		input.type = "range";
		input.min = def.min ?? 0;
		input.max = def.max ?? 1;
		input.step = def.step ?? "any";
		input.value = def.value ?? input.min;
		const out = h("output", null, def.showValue ? input.value : "");
		node.append(label, input, out);
		const sendChange = throttled((v) => ctx.send("change", { value: v }), def.interval ?? 50);
		input.addEventListener("input", () => {
			if (def.showValue) out.textContent = input.value;
			sendChange(Number(input.value));
		});
		input.addEventListener("change", () => ctx.send("set", { value: Number(input.value) }));
		input.disabled = !!def.disabled;
		return { node, update: (s) => { if ("value" in s) input.value = s.value; if ("disabled" in s) input.disabled = !!s.disabled; if ("label" in s) { label.textContent = s.label ?? ""; label.hidden = !s.label; } } };
	});

	// ---------------------------------------------------------------- text / number entry
	// ev "submit" with value. The control locks after sending unless keepOpen: true.

	function entry(kind) {
		return (def, ctx) => {
			const node = h("form");
			node.noValidate = true;
			const label = h("label", null, def.label ?? "");
			const field = def.multiline ? h("textarea") : h("input");
			if (!def.multiline) field.type = kind === "number" ? "text" : "text";
			if (kind === "number") field.inputMode = def.decimals ? "decimal" : "numeric";
			if (def.placeholder) field.placeholder = def.placeholder;
			if (def.maxLength) field.maxLength = def.maxLength;
			if (def.rows) field.rows = def.rows;
			if (def.value != null) field.value = def.value;
			field.autocomplete = "off";
			field.setAttribute("autocorrect", "off");
			label.append(field);
			const submit = h("button", "primary", def.submitLabel ?? "Send");
			submit.type = "submit";
			node.append(label, submit);
			const lock = (on) => { field.disabled = on; submit.disabled = on; node.classList.toggle("sent", on); };
			node.addEventListener("submit", (e) => {
				e.preventDefault();
				let value = field.value.trim();
				if (kind === "number") {
					const n = Number(value.replace(",", "."));
					if (value === "" || !Number.isFinite(n)) { field.focus(); P.feedback({ shake: true, haptic: "error" }); return; }
					if (def.min != null && n < def.min || def.max != null && n > def.max) { P.feedback({ shake: true, haptic: "error", toast: `${def.min ?? ""}–${def.max ?? ""}` }); return; }
					value = n;
				} else if (!value && !def.allowEmpty) { field.focus(); return; }
				if (ctx.send("submit", { value })) {
					ctx.haptic("success");
					field.blur();
					if (def.keepOpen) field.value = "";
					else lock(true);
				}
			});
			if (def.autofocus !== false) setTimeout(() => field.focus({ preventScroll: true }), 60);
			if (def.disabled) lock(true);
			return { node, update: (s) => { if ("value" in s) field.value = s.value ?? ""; if ("disabled" in s || "locked" in s) lock(!!(s.disabled ?? s.locked)); if ("label" in s) label.firstChild.textContent = s.label ?? ""; } };
		};
	}
	P.defineElement("textinput", entry("text"));
	P.defineElement("number", entry("number"));

	// ---------------------------------------------------------------- choice
	// Single choice: tapping an option sends ev "submit" with value straight away.
	// multi: true lets players toggle options, then ev "submit" with values: [...].

	P.defineElement("choice", (def, ctx) => {
		const node = h("div");
		const grid = h("div", "choice-grid");
		grid.style.setProperty("--cols", def.columns || (def.options?.length > 4 ? 2 : 1));
		const picked = new Set(def.selected ?? []);
		let locked = false;
		const buttons = [];
		for (const opt of def.options || []) {
			const b = h("button", "choice-option");
			b.type = "button";
			b.dataset.value = opt.value;
			if (opt.icon) b.append(h("span", "choice-icon", opt.icon));
			b.append(h("span", "choice-label", opt.label ?? opt.value));
			if (opt.color) b.style.setProperty("--el-color", ctx.resolveColor(opt.color));
			if (opt.image) { const i = h("img"); i.src = opt.image; i.alt = ""; b.prepend(i); }
			b.classList.toggle("picked", picked.has(opt.value));
			b.addEventListener("click", () => {
				if (locked || ctx.disabled) return;
				if (def.multi) {
					picked.has(opt.value) ? picked.delete(opt.value) : picked.add(opt.value);
					b.classList.toggle("picked", picked.has(opt.value));
					ctx.haptic("light");
					if (def.live) ctx.send("change", { values: [...picked] });
					return;
				}
				if (ctx.send("submit", { value: opt.value })) {
					ctx.haptic(def.haptic ?? "press");
					buttons.forEach((x) => x.classList.toggle("picked", x === b));
					if (!def.keepOpen) { locked = true; node.classList.add("sent"); }
				}
			});
			buttons.push(b);
			grid.append(b);
		}
		node.append(grid);
		if (def.multi) {
			const submit = h("button", "primary", def.submitLabel ?? "Done");
			submit.type = "button";
			submit.addEventListener("click", () => {
				if (locked) return;
				if (ctx.send("submit", { values: [...picked] })) { ctx.haptic("success"); if (!def.keepOpen) { locked = true; node.classList.add("sent"); submit.disabled = true; } }
			});
			node.append(submit);
		}
		return { node, update: (s) => { if ("locked" in s) { locked = !!s.locked; node.classList.toggle("sent", locked); } } };
	});

	// ---------------------------------------------------------------- drawing
	// ev "submit" with value = PNG data URL. Optional ev "stroke" live (live: true) with points.

	P.defineElement("drawing", (def, ctx) => {
		const node = h("div");
		const width = def.width || 320, height = def.height || 240;
		const canvas = h("canvas");
		canvas.width = width;
		canvas.height = height;
		canvas.style.aspectRatio = `${width} / ${height}`;
		const g = canvas.getContext("2d");
		const bg = def.background || "#ffffff";
		const clear = () => { g.fillStyle = bg; g.fillRect(0, 0, width, height); };
		clear();
		g.lineCap = "round";
		g.lineJoin = "round";
		const colors = def.colors || ["#1f1a17", "#e8574f", "#4a8ce8", "#f5c33b", "#5bbf72", bg];
		let color = colors[0];
		const thin = Math.max(3, Math.round(width / 80)), thick = Math.max(12, Math.round(width / 22));
		let size = def.brush || thin;
		let last = null, locked = false;
		const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (width / r.width), y: (e.clientY - r.top) * (height / r.height) }; };
		track(canvas, {
			down: (e) => { if (locked) return; last = pt(e); g.fillStyle = color; g.beginPath(); g.arc(last.x, last.y, size / 2, 0, Math.PI * 2); g.fill(); },
			move: (e) => { if (!last) return; const p = pt(e); g.strokeStyle = color; g.lineWidth = size; g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(p.x, p.y); g.stroke(); last = p; },
			up: () => { last = null; },
		});
		const tools = h("div", "draw-tools");
		for (const c of colors) {
			const sw = h("button", "swatch" + (c === color ? " selected" : ""));
			sw.type = "button";
			sw.style.background = c;
			sw.setAttribute("aria-label", c === bg ? "eraser" : "colour " + c);
			sw.addEventListener("click", () => {
				color = c;
				size = c === bg ? thick : (def.brush || thin);
				tools.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("selected", x === sw));
			});
			tools.append(sw);
		}
		const wipe = h("button", "ghost", def.clearLabel ?? "Clear");
		wipe.type = "button";
		wipe.addEventListener("click", () => !locked && clear());
		tools.append(wipe);
		const submit = h("button", "primary", def.submitLabel ?? "Done");
		submit.type = "button";
		submit.addEventListener("click", () => {
			if (locked) return;
			if (ctx.send("submit", { value: canvas.toDataURL("image/png") })) {
				ctx.haptic("success");
				locked = true; submit.disabled = true; node.classList.add("sent");
			}
		});
		node.append(canvas, tools, submit);
		return { node };
	});
})();
