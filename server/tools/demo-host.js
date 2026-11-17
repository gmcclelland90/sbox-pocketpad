#!/usr/bin/env node
// A pretend game for trying the phone client (and your themes) without s&box.
//
//   node tools/demo-host.js [serverUrl] [--theme paper] [--auto 6]
//
// It opens a session, prints the join link, then shows each built-in screen in turn.
// Press Enter for the next screen (or use --auto <seconds>). Phone input is printed as it arrives,
// and buttons answer with feedback so you can feel the haptics and hear the sounds.

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf("--" + name);
	return i >= 0 ? args[i + 1] : fallback;
};
const server = (args.find((a) => /^https?:/.test(a)) || "http://localhost:8080").replace(/\/+$/, "");
const theme = flag("theme", "");
const auto = Number(flag("auto", 0));
const key = flag("key", "");

export const DEMO_SCREENS = [
	{
		title: "Mash!",
		subtitle: "Hit it as fast as you can",
		timer: 10,
		elements: [
			{ type: "progress", id: "meter", value: 0, label: "Power" },
			{ type: "button", id: "mash", label: "MASH!", color: "player", haptic: "tap", sound: "tap" },
		],
	},
	{
		title: "Pick one",
		subtitle: "Four big buttons",
		elements: [
			{ type: "row", children: [
				{ type: "button", id: "a", label: "A", color: "#e8574f" },
				{ type: "button", id: "b", label: "B", color: "#4a8ce8" },
			] },
			{ type: "row", children: [
				{ type: "button", id: "c", label: "C", color: "#f5c33b", textColor: "#222" },
				{ type: "button", id: "d", label: "D", color: "#5bbf72" },
			] },
		],
	},
	{
		title: "Gamepad",
		layout: "row",
		elements: [
			{ type: "joystick", id: "move", flex: 1.2 },
			{ type: "column", children: [
				{ type: "button", id: "jump", label: "JUMP", shape: "round", color: "player" },
				{ type: "button", id: "dash", label: "Dash", flex: 0.5 },
			] },
		],
	},
	{
		title: "D-pad",
		subtitle: "Slide your thumb between arrows",
		elements: [{ type: "dpad", id: "dpad" }],
	},
	{
		title: "Swipe to dodge",
		elements: [{ type: "swipe", id: "dodge", label: "Swipe in any direction" }],
	},
	{
		title: "Aim",
		subtitle: "Drag on the pad",
		elements: [{ type: "touchpad", id: "aim", label: "Touch here" }],
	},
	{
		title: "Tilt your phone",
		subtitle: "Roll the ball (tilt and shake are sensors)",
		sensors: { tilt: true, shake: true },
		elements: [{ type: "text", id: "tiltinfo", text: "x 0  y 0", size: "l" }],
	},
	{
		title: "How hot is it?",
		elements: [
			{ type: "slider", id: "heat", min: 0, max: 100, step: 1, value: 50, label: "Heat", showValue: true },
			{ type: "button", id: "lock", label: "Lock it in", flex: 0, color: "accent" },
		],
	},
	{
		title: "Quick quiz",
		subtitle: "What's 7 x 8?",
		timer: 15,
		elements: [{ type: "choice", id: "quiz", columns: 2, options: [
			{ value: "54", label: "54" }, { value: "56", label: "56" }, { value: "58", label: "58" }, { value: "64", label: "64" },
		] }],
	},
	{
		title: "Guess the number",
		elements: [{ type: "number", id: "guess", label: "How many jellybeans?", placeholder: "0", min: 0, max: 9999, submitLabel: "Guess" }],
	},
	{
		title: "Write a caption",
		scroll: true,
		elements: [{ type: "textinput", id: "caption", label: "Make it funny", maxLength: 60, submitLabel: "Send" }],
	},
	{
		title: "Draw a cat",
		scroll: true,
		elements: [{ type: "drawing", id: "sketch", width: 320, height: 240, submitLabel: "Done" }],
	},
	{
		title: "Round over",
		subtitle: "Waiting for the next microgame...",
		elements: [{ type: "text", text: "🎉", size: "xl" }],
	},
];

function main() {
	const q = new URLSearchParams();
	if (theme) q.set("theme", theme);
	if (key) q.set("key", key);
	const ws = new WebSocket(`${server.replace(/^http/, "ws")}/ws/host?${q}`);
	const send = (m) => ws.send(JSON.stringify(m));
	let index = -1;
	const mash = new Map();
	const players = new Map();

	const next = () => {
		index = (index + 1) % DEMO_SCREENS.length;
		mash.clear();
		send({ type: "show", screen: DEMO_SCREENS[index] });
		console.log(`\n--- screen ${index + 1}/${DEMO_SCREENS.length}: ${DEMO_SCREENS[index].title}`);
	};

	ws.on("message", (raw) => {
		const msg = JSON.parse(raw.toString());
		switch (msg.type) {
			case "ready":
				console.log(`Session ${msg.code}. Open ${msg.joinUrl} on a phone.`);
				console.log(auto ? `Changing screen every ${auto}s.` : "Press Enter for the next screen.");
				next();
				if (auto) setInterval(next, auto * 1000);
				break;
			case "join":
				players.set(msg.player.id, msg.player);
				console.log(`+ ${msg.player.name} (${msg.player.id})${msg.rejoin ? " rejoined" : " joined"}`);
				send({ type: "feedback", to: msg.player.id, feedback: { toast: `Hi ${msg.player.name}!`, haptic: "success", sound: "coin" } });
				break;
			case "leave": console.log(`- ${players.get(msg.id)?.name ?? msg.id} left`); break;
			case "status": console.log(`~ ${players.get(msg.id)?.name ?? msg.id} ${msg.connected ? "connected" : "disconnected"}`); break;
			case "input": {
				const who = players.get(msg.from)?.name ?? msg.from;
				const { type, from, seq, t, ...rest } = msg;
				if (typeof rest.value === "string" && rest.value.length > 60) rest.value = rest.value.slice(0, 40) + `... (${rest.value.length} chars)`;
				console.log(`  ${who}: ${JSON.stringify(rest)}`);
				if (msg.el === "mash" && msg.ev === "down") {
					const n = (mash.get(msg.from) ?? 0) + 1;
					mash.set(msg.from, n);
					send({ type: "update", to: msg.from, id: "meter", set: { value: Math.min(1, n / 40), label: `Power ${n}` } });
					if (n === 40) send({ type: "feedback", to: msg.from, feedback: { toast: "MAX!", sound: "success", haptic: "success", flash: true } });
				}
				if (msg.el === "$tilt") send({ type: "update", to: msg.from, id: "tiltinfo", set: { text: `x ${msg.x.toFixed(2)}  y ${msg.y.toFixed(2)}` } });
				if (msg.el === "$shake") send({ type: "feedback", to: msg.from, feedback: { toast: "Shaken!", haptic: "buzz", shake: true } });
				if (msg.el === "quiz") {
					const right = msg.value === "56";
					send({ type: "feedback", to: msg.from, feedback: right ? { toast: "Correct!", sound: "success", haptic: "success", flash: "success" } : { toast: "Nope!", sound: "fail", haptic: "error", flash: "danger", shake: true } });
				}
				if (["a", "b", "c", "d", "jump", "dash", "lock"].includes(msg.el) && msg.ev === "down") send({ type: "feedback", to: msg.from, feedback: { sound: "pop" } });
				if (msg.ev === "swipe") send({ type: "feedback", to: msg.from, feedback: { sound: "whoosh" } });
				break;
			}
			case "error": console.log("! server:", msg.message); break;
			case "ended": console.log("Session ended:", msg.message); process.exit(0);
		}
	});
	ws.on("close", (code) => { console.log("Disconnected", code); process.exit(1); });
	ws.on("error", (e) => { console.error(`Couldn't reach ${server}: ${e.message}`); process.exit(1); });

	if (!auto && process.stdin.isTTY) readline.createInterface({ input: process.stdin }).on("line", next);
	process.on("SIGINT", () => { send({ type: "end", reason: "The demo has finished." }); setTimeout(() => process.exit(0), 200); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
