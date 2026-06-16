#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-choir}"
IMAGE_NAME="${IMAGE_NAME:-choir:latest}"
DOMAIN="${1:-${DOMAIN:-}}"
APP_PORT="${APP_PORT:-3000}"
HOST_BIND="${HOST_BIND:-127.0.0.1:${APP_PORT}}"
SERVICE_NAME="${SERVICE_NAME:-choir.service}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW_PUBLIC_BIND="${ALLOW_PUBLIC_BIND:-false}"
LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
PODMAN_RUNTIME_NETWORK="${PODMAN_RUNTIME_NETWORK:-host}"

# Podman bridge for the container. Default 10.88.0.0/16 collides with VT CS
# campus routing (see https://wiki.cs.vt.edu/index.php/HowTo:Docker_172_Fix),
# which silently breaks container outbound traffic. Override per-site if
# needed. Subnet must not overlap with any network the host actually routes.
# Used only when PODMAN_RUNTIME_NETWORK=bridge.
PODMAN_NETWORK_NAME="${PODMAN_NETWORK_NAME:-choirnet}"
PODMAN_NETWORK_SUBNET="${PODMAN_NETWORK_SUBNET:-10.1.0.0/24}"

# DNS servers the container should use. Default to the host's resolvers so
# the container resolves through the same path as the host (avoids forcing
# public 1.1.1.1/8.8.8.8 traffic out of the campus). Override with
# CONTAINER_DNS="ip1 ip2" if running outside VT.
# Used only when PODMAN_RUNTIME_NETWORK=bridge.
CONTAINER_DNS="${CONTAINER_DNS:-198.82.247.98}"

if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <public-domain>"
  echo "Example: $0 choir.example.com"
  echo "Or set DOMAIN=... in the environment before invoking."
  exit 1
fi

cd "$PROJECT_ROOT"

echo "Deploying CHOIR for https://${DOMAIN}"
echo "Podman runtime network: ${PODMAN_RUNTIME_NETWORK}"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman is not installed or not on PATH."
  exit 1
fi

if [ ! -f .env ]; then
  echo ".env not found. Create it from .env.example before deploying."
  exit 1
fi

if [ ! -f deployment/Containerfile ]; then
  echo "Containerfile not found."
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is not installed or not on PATH."
  exit 1
fi

mkdir -p data

if [[ "$ALLOW_PUBLIC_BIND" != "true" && ! "$HOST_BIND" =~ ^(127\.|localhost:|\[::1\]:|::1:) ]]; then
  echo "Refusing to deploy with non-loopback HOST_BIND=${HOST_BIND}."
  echo "Bind CHOIR to localhost and let nginx expose only HTTPS."
  echo "Set ALLOW_PUBLIC_BIND=true only if you intentionally want Podman to publish the app port externally."
  exit 1
fi

case "$PODMAN_RUNTIME_NETWORK" in
  host|bridge) ;;
  *)
    echo "Unsupported PODMAN_RUNTIME_NETWORK=${PODMAN_RUNTIME_NETWORK}. Use host or bridge."
    exit 1
    ;;
esac

if [[ "$PODMAN_RUNTIME_NETWORK" = "host" && "$LISTEN_HOST" != "127.0.0.1" && "$LISTEN_HOST" != "localhost" && "$ALLOW_PUBLIC_BIND" != "true" ]]; then
  echo "Refusing host-network deploy with LISTEN_HOST=${LISTEN_HOST}."
  echo "Use LISTEN_HOST=127.0.0.1 so nginx remains the only public entrypoint."
  echo "Set ALLOW_PUBLIC_BIND=true only if you intentionally want the app port exposed."
  exit 1
fi

SLACK_MODE_VALUE="$(grep -E '^SLACK_MODE=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' ' || true)"
SLACK_MODE_VALUE="${SLACK_MODE_VALUE:-single}"

if [ "$SLACK_MODE_VALUE" = "oauth" ]; then
  EXPECTED_REDIRECT="SLACK_REDIRECT_URI=https://${DOMAIN}/slack/oauth_redirect"
  if ! grep -q "^${EXPECTED_REDIRECT}$" .env; then
    echo "Warning: .env does not contain ${EXPECTED_REDIRECT}"
    echo "Slack OAuth will fail unless SLACK_REDIRECT_URI and the Slack dashboard match."
  fi
else
  echo "Detected SLACK_MODE=${SLACK_MODE_VALUE}. Make sure your Slack app's event/interactivity request URLs point to https://${DOMAIN}/slack/events."
fi

if ss -ltn 2>/dev/null | grep -qE "127\\.0\\.0\\.1:${APP_PORT}\\b|0\\.0\\.0\\.0:${APP_PORT}\\b|\\*:${APP_PORT}\\b"; then
  if ! sudo podman ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    echo "Port ${APP_PORT} appears to be in use by a non-${CONTAINER_NAME} process."
    echo "Stop the current dev server first, for example: fuser -k ${APP_PORT}/tcp"
    exit 1
  fi
fi

echo "Building TypeScript output..."
pnpm build

if [ ! -f dist/app.js ]; then
  echo "dist/app.js not found after build."
  exit 1
fi

echo "Building image ${IMAGE_NAME} (rootful, with cache mounts)..."
# --network=host lets the build container reach the npm/pnpm registries
# directly via the host network. Required because the host uses
# systemd-resolved (127.0.0.53) which isn't reachable from a default
# podman network namespace.
sudo podman build \
  --network=host \
  --format docker \
  -t "$IMAGE_NAME" \
  -f deployment/Containerfile \
  .

RUN_NETWORK_FLAGS="--network host"
RUN_PORT_FLAGS=""

if [ "$PODMAN_RUNTIME_NETWORK" = "bridge" ]; then
  # Ensure a dedicated podman network on a subnet that does not collide with
  # the host's routed networks. Idempotent: only creates when missing.
  #
  # --disable-dns turns off aardvark-dns. With aardvark on, the container's
  # resolv.conf is forced to the bridge gateway (10.1.0.1:53), so DNS packets
  # hit the host's INPUT chain -- and a default-deny ufw will silently drop them
  # unless the bridge interface is explicitly allowed. Disabling aardvark makes
  # the container resolve directly against the upstream from --dns=, which
  # travels through FORWARD (already ACCEPTed by netavark for this subnet).
  if ! sudo podman network exists "$PODMAN_NETWORK_NAME"; then
    echo "Creating podman network ${PODMAN_NETWORK_NAME} (${PODMAN_NETWORK_SUBNET})..."
    sudo podman network create \
      --subnet "$PODMAN_NETWORK_SUBNET" \
      --disable-dns \
      "$PODMAN_NETWORK_NAME"
  else
    EXISTING_SUBNET="$(sudo podman network inspect "$PODMAN_NETWORK_NAME" --format '{{range .Subnets}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
    if [ -n "$EXISTING_SUBNET" ] && [ "$EXISTING_SUBNET" != "$PODMAN_NETWORK_SUBNET" ]; then
      echo "Warning: podman network ${PODMAN_NETWORK_NAME} exists with subnet ${EXISTING_SUBNET}, expected ${PODMAN_NETWORK_SUBNET}."
      echo "Remove it with: sudo podman network rm ${PODMAN_NETWORK_NAME}"
    fi
  fi

  DNS_FLAGS=""
  for dns_ip in $CONTAINER_DNS; do
    DNS_FLAGS="${DNS_FLAGS} --dns=${dns_ip}"
  done

  RUN_NETWORK_FLAGS="--network ${PODMAN_NETWORK_NAME}${DNS_FLAGS}"
  RUN_PORT_FLAGS="-p ${HOST_BIND}:${APP_PORT}"
fi

echo "Writing systemd service ${SERVICE_NAME}..."
sudo tee "/etc/systemd/system/${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=CHOIR Slack App Container
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStartPre=-/usr/bin/podman stop ${CONTAINER_NAME}
ExecStartPre=-/usr/bin/podman rm -f ${CONTAINER_NAME}
ExecStart=/usr/bin/podman run --rm --name ${CONTAINER_NAME} ${RUN_NETWORK_FLAGS} --env-file ${PROJECT_ROOT}/.env --env PORT=${APP_PORT} --env LISTEN_HOST=${LISTEN_HOST} ${RUN_PORT_FLAGS} -v ${PROJECT_ROOT}/data:/app/data:rw ${IMAGE_NAME}
ExecStop=/usr/bin/podman stop -t 30 ${CONTAINER_NAME}
Restart=always
RestartSec=10
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
EOF

echo "Starting ${SERVICE_NAME}..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "Waiting for health check..."
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
    echo "Local health check passed."
    break
  fi

  if [ "$attempt" -eq 30 ]; then
    echo "Service did not become healthy. Recent logs:"
    sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager
    exit 1
  fi

  sleep 2
done

echo "Checking container outbound DNS..."
if sudo podman exec "$CONTAINER_NAME" node -e 'require("dns").lookup("slack.com",(err,addr)=>{ if (err) { console.error(err); process.exit(1); } console.log(addr); })' >/dev/null; then
  echo "Container outbound DNS check passed."
else
  echo "Container outbound DNS check failed. Slack OAuth install will hang or fail until container outbound networking is fixed."
  echo "Current runtime network: ${PODMAN_RUNTIME_NETWORK}"
  if [ "$PODMAN_RUNTIME_NETWORK" = "bridge" ]; then
    echo "Try the default host-network deploy, or rerun with: PODMAN_RUNTIME_NETWORK=host $0 ${DOMAIN}"
  fi
  exit 1
fi

if ss -ltnH 2>/dev/null | grep -qE "[[:space:]](0\\.0\\.0\\.0|\\*|\\[::\\]|::):${APP_PORT}[[:space:]]"; then
  echo "Port ${APP_PORT} is listening on a public interface."
  echo "This is unsafe for CHOIR; keep Podman bound to 127.0.0.1 and expose the app through nginx HTTPS only."
  exit 1
fi

if command -v nginx >/dev/null 2>&1; then
  echo "Testing nginx configuration..."
  sudo nginx -t
  sudo systemctl reload nginx
fi

echo "Checking public health endpoint..."
if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
  echo "Public health check passed."
else
  echo "Public health check failed. Confirm nginx proxies / to ${HOST_BIND}."
fi

echo "Deployment complete."
echo "Useful commands:"
echo "  sudo systemctl status ${SERVICE_NAME}"
echo "  sudo journalctl -u ${SERVICE_NAME} -f"
echo "  sudo systemctl restart ${SERVICE_NAME}"
