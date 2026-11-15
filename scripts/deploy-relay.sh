#!/bin/sh
# Deploy prebuilt images; never build or upload broadcaster media on the relay.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
test -f .env.relay || { echo 'Run python3 scripts/setup-relay.py first.' >&2; exit 1; }
compose() {
    if [ "$(sed -n 's/^RELAY_PUBLIC_ENABLED=//p' .env.relay)" = true ]; then
        docker compose --env-file .env.relay -f compose.relay.yaml -f compose.public.yaml "$@"
    else
        docker compose --env-file .env.relay -f compose.relay.yaml "$@"
    fi
}
compose config --quiet
previous=$(compose ps -q relay | xargs -r docker inspect --format '{{.Image}}')
compose pull --quiet
if ! compose up --no-build -d --wait --wait-timeout 120; then
    echo 'Deployment did not become healthy. Restoring the previous relay image if available.' >&2
    if [ -n "$previous" ]; then RELAY_IMAGE="$previous" compose up --no-build -d --wait --wait-timeout 120 || true; fi
    exit 1
fi
compose ps
