#!/usr/bin/env sh
# Starts a PocketPad server for local development on your network (plain http). macOS / Linux.
#
#   tools/start-dev-server.sh [port] [max-phones-per-room]
#
# Installs dependencies on first run, refuses to start if the port is taken, and prints the join address.
# The server works out this machine's LAN address by itself (set PUBLIC_URL to override). Your s&box game
# connects to http://localhost:<port>. Set SBOX_AUTH=true to require s&box auth tokens (needs internet access to
# Facepunch). Set THEMES_DIR to a folder of your own themes (one subfolder per theme, e.g. kept in your game's
# repo; several folders separated by ":") and DEFAULT_THEME to pick one. Ctrl+C stops the server.
set -eu

PORT="${1:-${PORT:-8080}}"
MAX_PLAYERS="${2:-${MAX_PLAYERS:-100}}"
SERVER_DIR="$(cd "$(dirname "$0")/../server" && pwd)"

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Port $PORT is already in use. Stop the other server first, or pass a different port." >&2
	exit 1
fi

if [ ! -d "$SERVER_DIR/node_modules" ]; then
	echo "Installing server dependencies..."
	(cd "$SERVER_DIR" && npm ci --no-audit --no-fund)
fi

export PORT MAX_PLAYERS
echo ""
echo "  Game connects to: http://localhost:$PORT"
echo "  Max phones/room:  $MAX_PLAYERS"
echo "  (the server prints the phone join address below)"
echo ""
cd "$SERVER_DIR"
exec node src/index.js
