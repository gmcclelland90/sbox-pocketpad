// Example of adding your own control type from a theme folder.
// Show it from s&box with:  new PadCustom( "dial", new() { ["id"] = "volume", ["steps"] = 12 } )
// It sends ev "change" with value = step number (0..steps-1) as the player turns it.
PocketPad.defineElement("dial", (def, ctx) => {
	const steps = def.steps || 12;
	const node = document.createElement("div");
	node.style.cssText = "display:grid;place-items:center;flex:1 1 0;touch-action:none";
	const knob = document.createElement("div");
	knob.style.cssText = "width:min(70vw,40vh);aspect-ratio:1;border-radius:50%;background:var(--surface);box-shadow:0 0 0 6px var(--border) inset;position:relative";
	const mark = document.createElement("div");
	mark.style.cssText = "position:absolute;left:50%;top:6%;width:14px;height:28%;margin-left:-7px;border-radius:7px;background:var(--el-color, var(--player))";
	const label = document.createElement("div");
	label.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;font-size:3rem;font-weight:800";
	knob.append(mark, label);
	node.append(knob);

	let step = def.value ?? 0;
	const draw = () => { knob.style.transform = `rotate(${(step / steps) * 360}deg)`; label.style.transform = `rotate(${-(step / steps) * 360}deg)`; label.textContent = step; };
	draw();

	knob.addEventListener("pointerdown", (e) => knob.setPointerCapture(e.pointerId));
	knob.addEventListener("pointermove", (e) => {
		if (!knob.hasPointerCapture(e.pointerId)) return;
		const r = node.getBoundingClientRect();
		const angle = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
		const next = ((Math.round(((angle + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * steps)) % steps);
		if (next !== step) {
			step = next;
			draw();
			ctx.haptic("light");
			ctx.send("change", { value: step });
		}
	});

	return { node, update: (set) => { if ("value" in set) { step = set.value; draw(); } } };
});
