// Optional check that a game creating a session is a real s&box player, using s&box auth tokens.
// https://sbox.game/dev/doc/services/auth-tokens
//
// The game gets a token with Sandbox.Services.Auth.GetToken(...) and sends it with its Steam ID when it
// opens the host socket. We ask Facepunch whether the token belongs to that Steam ID.

const STEAM_ID = /^\d{1,20}$/;

/**
 * Pull the token and Steam ID out of a host socket's upgrade request.
 * Headers: `Authorization: <token>` (a `Bearer ` prefix is fine) and `X-Steam-Id: <64-bit id>`.
 */
export function authFromRequest(req) {
	const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
	const steamId = String(req.headers["x-steam-id"] ?? "").trim();
	return { token, steamId };
}

/**
 * Ask Facepunch whether `token` belongs to `steamId`.
 * Returns "ok", "invalid" (missing or wrong token) or "unavailable" (couldn't reach Facepunch).
 */
export async function verifySboxToken({ token, steamId }, { url, timeoutMs = 5000, fetchImpl = fetch } = {}) {
	if (!token || token.length > 4096 || !STEAM_ID.test(steamId)) return "invalid";
	let res, text;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// Steam IDs don't fit in a JS number, so write it into the JSON by hand.
			body: `{"steamid":${steamId},"token":${JSON.stringify(token)}}`,
			signal: AbortSignal.timeout(timeoutMs),
		});
		text = await res.text();
	} catch {
		return "unavailable";
	}
	if (res.status >= 500) return "unavailable";
	if (res.status !== 200) return "invalid";
	// Read the fields from the raw text for the same reason: JSON.parse would round the Steam ID.
	const status = text.match(/"status"\s*:\s*"([^"]*)"/i)?.[1];
	const id = text.match(/"steamid"\s*:\s*"?(\d+)"?/i)?.[1];
	return status === "ok" && id === steamId ? "ok" : "invalid";
}
