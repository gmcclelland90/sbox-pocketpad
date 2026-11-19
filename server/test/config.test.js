import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

function withEnv(vars, fn) {
	const saved = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try { return fn(); }
	finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("defaults allow audience-sized rooms", () => {
	withEnv({ MAX_PLAYERS: undefined, PORT: undefined, PUBLIC_URL: undefined }, () => {
		const config = loadConfig();
		assert.equal(config.maxPlayers, 100);
		assert.equal(config.port, 8080);
		assert.equal(config.publicUrl, "");
	});
});

test("MAX_PLAYERS and PUBLIC_URL come from the environment", () => {
	withEnv({ MAX_PLAYERS: "24", PUBLIC_URL: "https://pad.example.com/" }, () => {
		const config = loadConfig();
		assert.equal(config.maxPlayers, 24);
		assert.equal(config.publicUrl, "https://pad.example.com");
	});
});

test("a bad MAX_PLAYERS fails loudly", () => {
	withEnv({ MAX_PLAYERS: "lots" }, () => {
		assert.throws(() => loadConfig(), /MAX_PLAYERS must be a whole number/);
	});
});
