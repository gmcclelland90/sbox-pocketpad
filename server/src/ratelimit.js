// Per-address rate limiting for things that are cheap to spam: creating sessions and guessing room codes.

/**
 * Counts hits per key in fixed one-minute windows. A limit of 0 turns it off.
 */
export class RateLimiter {
	constructor({ limit, windowMs = 60_000, now = Date.now }) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.now = now;
		/** @type {Map<string, {count: number, resetAt: number}>} */
		this.entries = new Map();
	}

	get enabled() {
		return this.limit > 0;
	}

	#entry(key) {
		const now = this.now();
		let e = this.entries.get(key);
		if (!e || e.resetAt <= now) {
			e = { count: 0, resetAt: now + this.windowMs };
			this.entries.set(key, e);
		}
		return e;
	}

	/** True when this key has used up its allowance for the current window. Doesn't count as a hit. */
	blocked(key) {
		if (!this.enabled) return false;
		const e = this.entries.get(key);
		return !!e && e.resetAt > this.now() && e.count >= this.limit;
	}

	/** Record a hit. Returns false when the key was already over its limit. */
	hit(key) {
		if (!this.enabled) return true;
		const e = this.#entry(key);
		if (e.count >= this.limit) return false;
		e.count++;
		return true;
	}

	/** Forget windows that have ended, so the map doesn't grow forever. */
	sweep() {
		const now = this.now();
		for (const [key, e] of this.entries) if (e.resetAt <= now) this.entries.delete(key);
	}
}
