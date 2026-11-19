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

For local development, `tools/start-dev-server.ps1` (Windows) or `tools/start-dev-server.sh` (macOS / Linux) does
the setup for you: installs dependencies on first run, refuses to start if the port is taken, sets `PUBLIC_URL` to
your LAN address and prints where phones join. Plain `npm start` also works on a LAN: when a game connects through
`localhost`, the server hands phones its LAN address instead.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PUBLIC_URL` | (from request) | Address phones use, shown to games as `JoinUrl`. Set this behind a proxy or in Docker |
| `HOST_KEYS` | (none) | Comma-separated keys. When set, games must send one (`PadHost.HostKey`) to create sessions. Recommended for public servers |
| `DEFAULT_THEME` | `default` | Theme for the plain join page and for games that don't pick one |
| `THEMES_DIR` | `/themes` | Folder of extra themes |
| `MAX_SESSIONS` | `500` | Concurrent sessions |
| `MAX_PLAYERS` | `100` | Phones per session, players and spectators/audience together (games can ask for fewer with `MaxPlayers`) |
| `HOST_GRACE_SECONDS` | `120` | How long a session survives without its game connected |
| `MAX_MESSAGE_KB` | `1024` | Biggest message (drawings are sent as PNGs) |
| `PLAYER_RATE_LIMIT` | `120` | Inputs per second per phone before extras are dropped |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-Proto/Host` to build join links |
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
	proxy_read_timeout 1h;
}
```

Set `PUBLIC_URL=https://pad.example.com` (or `TRUST_PROXY=true`).

## Health and monitoring

- `GET /healthz` returns `{ok, version, sessions}`; the Docker image has a built-in healthcheck on it.
- `GET /api/v1/info` lists version, protocol, themes, and whether a host key is required.

## Scaling

Sessions live in one process's memory, so run one instance per hostname. If you ever need more, shard by
hostname (for example `eu.pad.example.com`, `us.pad.example.com`) and point games at the nearest. A
restart ends running sessions; games and phones show a message and players rejoin with a new code.
