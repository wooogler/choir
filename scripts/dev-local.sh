#!/usr/bin/env bash
#
# One-command local development loop.
#
#   pnpm dev:local                 app + docs viewer on http://localhost:5173
#   pnpm dev:local --fake-google   ...with Drive and GitHub faked, and a local sign-in
#   pnpm dev:local --tunnel        ...published through the reserved ngrok domain instead
#
# Starts two processes and ties their lifetimes together:
#
#   1. the CHOIR node app (Socket Mode, .env.development, data/dev, port 3031)
#      under nodemon, so a .ts save restarts it in ~3s
#   2. the Vite dev server on :5173, which serves the React viewer with HMR and
#      proxies /api, /docs/auth and friends back to the node app
#
# The browser talks to Vite only. That is what makes the loop fast: editing
# anything under web/ is a hot reload, with no `pnpm build:web` and no deploy.
#
# --tunnel points ngrok at Vite (not at the node app) so that Slack's and
# Google's OAuth callbacks come back to the same origin the browser is already
# on. It needs DOCS_BASE_URL in .env.development to match the ngrok domain, and
# the same URL registered as a redirect URL on the Slack app and the Google
# OAuth client.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.development}"
APP_PORT="${CHOIR_DEV_APP_PORT:-3031}"
WEB_PORT="${CHOIR_DEV_WEB_PORT:-5173}"
USE_TUNNEL=false
FAKE_GOOGLE=false

for arg in "$@"; do
  case "$arg" in
    --tunnel) USE_TUNNEL=true ;;
    --fake-google) FAKE_GOOGLE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# --fake-google turns on /docs/auth/dev-login, which mints a session for any
# known user. Publishing that through a tunnel would put an authentication
# bypass on the public internet, so the two modes are mutually exclusive.
if [ "$USE_TUNNEL" = true ] && [ "$FAKE_GOOGLE" = true ]; then
  die "--tunnel and --fake-google cannot be combined: dev-login must never be publicly reachable"
fi

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy .env.example and fill it in."

# The app calls process.exit(1) when OPENAI_API_KEY is missing, which would
# leave Vite running against a dead backend.
grep -qE '^OPENAI_API_KEY=.+' "$ENV_FILE" || die "OPENAI_API_KEY is not set in $ENV_FILE"

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if port_busy "$APP_PORT"; then die "port $APP_PORT is already in use (another dev server?)"; fi
if port_busy "$WEB_PORT"; then die "port $WEB_PORT is already in use (another dev server?)"; fi

DOCS_BASE_URL_VALUE="$(sed -n 's/^DOCS_BASE_URL=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"

if [ "$USE_TUNNEL" = true ]; then
  command -v ngrok >/dev/null || die "ngrok is not on PATH"
  TUNNEL_HOST="${CHOIR_DEV_TUNNEL_HOST:-${DOCS_BASE_URL_VALUE#*://}}"
  TUNNEL_HOST="${TUNNEL_HOST%%/*}"
  [ -n "$TUNNEL_HOST" ] || die "set CHOIR_DEV_TUNNEL_HOST or DOCS_BASE_URL in $ENV_FILE"
  export CHOIR_DEV_TUNNEL_HOST="$TUNNEL_HOST"
fi

pids=()

# Every child here is a wrapper around the process that actually holds a port:
# `pnpm` spawns vite, `npx nodemon` spawns ts-node. Killing only the wrapper
# leaves the real server orphaned onto init and the port bound, so walk the
# tree depth-first and kill leaves before their parents — nothing gets
# reparented mid-sweep, and nothing outside this script's own tree is touched.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▸ node app   http://127.0.0.1:$APP_PORT  (Socket Mode, $ENV_FILE, data/dev)"
echo "  This connects to the REAL Slack workspace configured in $ENV_FILE."

TS_NODE_EXEC='ts-node -r tsconfig-paths/register'
if [ "$FAKE_GOOGLE" = true ]; then
  TS_NODE_EXEC="$TS_NODE_EXEC -r ./scripts/dev/fake-google.ts"
  export CHOIR_DEV_LOGIN=true
  # The sweep is what turns a simulated edit into a review card. Three minutes
  # is right for production and far too slow to iterate against.
  export GOOGLE_DRIFT_POLL_MS="${GOOGLE_DRIFT_POLL_MS:-5000}"
  echo "  Drive and GitHub are faked, and /docs/auth/dev-login is on."
fi

ENV_FILE="$ENV_FILE" \
SLACK_MODE=single \
NODE_ENV=development \
CHOIR_DATA_DIR=data/dev \
DATABASE_URL=file:data/dev/choir-dev.db \
PORT="$APP_PORT" \
LISTEN_HOST=127.0.0.1 \
  npx nodemon \
    --watch app.ts --watch listeners --watch services --watch src --watch scripts \
    --ext ts,json \
    --ignore 'web/**' --ignore 'data/**' --ignore 'dist/**' --ignore '__tests__/**' \
    --exec "$TS_NODE_EXEC" app.ts &
pids+=($!)

echo "▸ docs viewer http://localhost:$WEB_PORT  (Vite, hot reload)"
CHOIR_DEV_ORIGIN="http://127.0.0.1:$APP_PORT" \
CHOIR_DEV_WEB_PORT="$WEB_PORT" \
  pnpm --filter choir-web dev &
pids+=($!)

if [ "$USE_TUNNEL" = true ]; then
  echo "▸ tunnel      https://$CHOIR_DEV_TUNNEL_HOST → :$WEB_PORT"
  # --log stdout turns off ngrok's fullscreen TUI, which would otherwise fight
  # the other two processes for the terminal.
  ngrok http "$WEB_PORT" --domain "$CHOIR_DEV_TUNNEL_HOST" --log stdout --log-level warn &
  pids+=($!)
fi

echo
echo "Open the viewer at:"
if [ "$USE_TUNNEL" = true ]; then
  echo "  https://$CHOIR_DEV_TUNNEL_HOST/docs/<workspaceId>/README.md"
elif [ "$FAKE_GOOGLE" = true ]; then
  echo "  http://localhost:$WEB_PORT/docs/auth/dev-login?workspace=<workspaceId>&user=<userId>"
  echo "  then: pnpm gdocs:seed  →  pnpm gdocs:edit"
else
  echo "  http://localhost:$WEB_PORT/docs/<workspaceId>/README.md"
  echo "  (signing in needs a public HTTPS callback: use --tunnel or --fake-google)"
fi
echo
echo "Ctrl-C stops everything."

wait -n
