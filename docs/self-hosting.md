# Self-hosting

The server is one Node.js process with everything in memory: no database, no external services.
A small VPS (512 MB RAM) handles hundreds of sessions.

## Docker

```bash
docker run -d --name pocketpad --restart unless-stopped \
  -p 8080:8080 \
  -e PUBLIC_URL=https://pad.example.com \
  -e HOST_KEYS=change-me \
  -v "$PWD/themes:/themes:ro" \
  ghcr.io/gmcclelland90/sbox-pocketpad:latest
```

or `docker compose up -d` with the [`docker-compose.yml`](../docker-compose.yml) in the repo root.

Images: `latest` / `1` / `1.2` / `1.2.3` from release tags, `edge` from `main`, and `sha-xxxxxxx`.
Built for `linux/amd64` and `linux/arm64` (Raspberry Pi, Ampere, Apple Silicon).

## Without Docker

```bash
cd server
npm ci --omit=dev
PORT=8080 PUBLIC_URL=https://pad.example.com node src/index.js
```

Needs Node 20 or newer.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PUBLIC_URL` | (from request) | Address phones use, shown to games as `JoinUrl`. Set this behind a proxy or in Docker |
| `HOST_KEYS` | (none) | Comma-separated keys. When set, games must send one (`PadHost.HostKey`) to create sessions. Recommended for public servers |
| `SBOX_AUTH` | `false` | Only let games signed in to s&box create sessions. See [s&box auth tokens](#sbox-auth-tokens). Recommended for public servers |
| `SBOX_AUTH_URL` | Facepunch's | Token check endpoint. Only change it for testing |
| `DEFAULT_THEME` | `default` | Theme for the plain join page and for games that don't pick one |
| `THEMES_DIR` | `/themes` | Folder of extra themes |
| `MAX_SESSIONS` | `500` | Concurrent sessions |
| `MAX_PLAYERS` | `16` | Players per session (games can ask for fewer) |
| `HOST_GRACE_SECONDS` | `120` | How long a session survives without its game connected |
| `MAX_MESSAGE_KB` | `1024` | Biggest message (drawings are sent as PNGs) |
| `MAX_BUFFERED_KB` | `4096` | Most unsent data held for one connection. A phone or game that falls further behind is disconnected and reconnects (phones get their current screen back) |
| `PLAYER_RATE_LIMIT` | `120` | Inputs per second per phone before extras are dropped |
| `CREATE_RATE_LIMIT` | `10` | New sessions per minute from one IP address. `0` turns it off |
| `JOIN_RATE_LIMIT` | `30` | Wrong room codes per minute from one IP address before it's refused for the rest of the minute. Only misses count, so players on one Wi-Fi joining and reconnecting don't use it up. `0` turns it off |
| `TRUSTED_PROXIES` | (none) | Comma-separated IP addresses or CIDR ranges of your reverse proxies. Their `X-Forwarded-*` headers are believed; loopback always is. See [HTTPS and reverse proxies](#https-and-reverse-proxies) |
| `TRUST_PROXY` | `false` | Old switch that believes `X-Forwarded-*` headers from anyone. Use `TRUSTED_PROXIES` instead |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Home network testing

Run the container, then set `PUBLIC_URL` to your PC's LAN address (`ipconfig` on Windows, for example
`http://192.168.1.20:8080`). The game connects to `http://localhost:8080`; phones on the same Wi-Fi open
the LAN address. Allow port 8080 through the firewall for private networks if asked.

Running `node src/index.js` directly (not in Docker) works this out itself: when the game connects via
localhost, join links use the machine's LAN address.

## HTTPS and reverse proxies

Phones need HTTPS for tilt and shake on iPhone (motion sensors), wake lock, and to avoid mixed-content
warnings, so put the server behind TLS in production. WebSockets must be passed through.

Caddy (gets certificates automatically):

```
pad.example.com {
	reverse_proxy localhost:8080
}
```

nginx:

```nginx
location / {
	proxy_pass http://127.0.0.1:8080;
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection "upgrade";
	proxy_set_header Host $host;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	proxy_read_timeout 1h;
}
```

Set `PUBLIC_URL=https://pad.example.com`.

The server believes `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` only from proxies it trusts,
because anyone can send those headers. A proxy on the same machine (connecting over loopback) is trusted
automatically. If the proxy reaches the server from another address, list it in `TRUSTED_PROXIES`. The common
case is Caddy or nginx on the Docker host talking to the PocketPad container, where the container sees the
Docker bridge address: `TRUSTED_PROXIES=172.16.0.0/12` covers Docker's default networks.

The client's real address is taken from `X-Forwarded-For` by walking from the right past your trusted
proxies, so a phone can't pretend to be someone else by sending its own header. The rate limits use this address.

## s&box auth tokens

`HOST_KEYS` ship inside your game, so anyone can dig one out and create sessions on your server. With
`SBOX_AUTH=true`, the server instead asks Facepunch to confirm that a game creating a session is a real
Steam user running s&box ([auth tokens](https://sbox.game/dev/doc/services/auth-tokens)):

1. Turn on **Send Auth Token** on the PocketPad Host (`PadSessionOptions.SendAuthToken`). The library calls
   `Sandbox.Services.Auth.GetToken(...)` and sends the token (`Authorization` header) and the player's Steam ID
   (`X-Steam-Id` header) when it opens the host socket.
2. The server posts them to `https://public.facepunch.com/sbox/auth/token` and only creates the session if
   Facepunch answers `ok` for that Steam ID. The Steam ID is logged with the new session's code.
3. A game resuming its own session doesn't need a new token. If Facepunch can't be reached, the server closes
   the socket with `1013` and the library tries again.

Phones aren't in s&box, so this only applies to games. It works alongside `HOST_KEYS` and the rate limits.
Leave it off for local testing.

## Health and monitoring

- `GET /healthz` returns `{ok, version, sessions}`; the Docker image has a built-in healthcheck on it.
- `GET /api/v1/info` lists version, protocol, themes, and whether a host key or s&box auth is required.

## Scaling

Sessions live in one process's memory, so run one instance per hostname. If you ever need more, shard by
hostname (for example `eu.pad.example.com`, `us.pad.example.com`) and point games at the nearest. A
restart ends running sessions; games and phones show a message and players rejoin with a new code.
