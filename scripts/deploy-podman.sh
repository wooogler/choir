#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-choir}"
IMAGE_NAME="${IMAGE_NAME:-choir:latest}"
DOMAIN="${1:-${DOMAIN:-choir.cs.vt.edu}}"
APP_PORT="${APP_PORT:-3000}"
HOST_BIND="${HOST_BIND:-127.0.0.1:${APP_PORT}}"
SERVICE_NAME="${SERVICE_NAME:-choir.service}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Deploying CHOIR for https://${DOMAIN}"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman is not installed or not on PATH."
  exit 1
fi

if [ ! -f .env ]; then
  echo ".env not found. Create it from env.sample before deploying."
  exit 1
fi

if [ ! -f Containerfile ]; then
  echo "Containerfile not found."
  exit 1
fi

mkdir -p data

EXPECTED_REDIRECT="SLACK_REDIRECT_URI=https://${DOMAIN}/slack/oauth_redirect"
if ! grep -q "^${EXPECTED_REDIRECT}$" .env; then
  echo "Warning: .env does not contain ${EXPECTED_REDIRECT}"
  echo "Slack OAuth will fail unless SLACK_REDIRECT_URI and the Slack dashboard match."
fi

if ss -ltn 2>/dev/null | grep -qE "127\\.0\\.0\\.1:${APP_PORT}\\b|0\\.0\\.0\\.0:${APP_PORT}\\b|\\*:${APP_PORT}\\b"; then
  if ! sudo podman ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
    echo "Port ${APP_PORT} appears to be in use by a non-${CONTAINER_NAME} process."
    echo "Stop the current dev server first, for example: fuser -k ${APP_PORT}/tcp"
    exit 1
  fi
fi

echo "Building image ${IMAGE_NAME}..."
podman build -t "$IMAGE_NAME" -f Containerfile .

echo "Copying image to root podman storage..."
podman save "$IMAGE_NAME" | sudo podman load

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
ExecStart=/usr/bin/podman run --rm --name ${CONTAINER_NAME} --env-file ${PROJECT_ROOT}/.env -p ${HOST_BIND}:${APP_PORT} -v ${PROJECT_ROOT}/data:/app/data:rw ${IMAGE_NAME}
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
