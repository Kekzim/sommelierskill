#!/bin/sh
# Create or recreate the sommelier containers.
#
# This replaced a compose file. Unraid ships no Compose of its own -- it comes
# from the Compose Manager plugin, and when that plugin went missing the whole
# stack became unmanageable: `docker compose` was an unknown command, and the
# .env beside the compose file was read by nothing, so edits to it silently did
# nothing at all. Plain `docker run` has no such dependency.
#
# Two files go on the server: this script and .env beside it. Run it after any
# change to .env; it pulls, recreates, and restarts the tunnel.
#
#   ./run.sh          both containers
#   ./run.sh sync     just the sync job (e.g. after changing CRON_SCHEDULE)
#   ./run.sh mcp      just the server
#   ./run.sh status   what is running, and on which image
set -eu

cd "$(dirname "$0")"

# .env is parsed, not sourced. Sourcing runs it as shell, so an unquoted
# `SYNC_STORES=1001 1002` would set SYNC_STORES=1001 and then try to execute
# `1002`. This reads KEY=VALUE literally, the way Compose did, so a file written
# for the old deployment still works unchanged.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in *[!A-Za-z0-9_]* | '') continue ;; esac
    # Strip one layer of surrounding quotes, if present.
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    export "$key=$val"
  done < .env
fi

IMAGE_TAG=${IMAGE_TAG:-latest}
SYNC_IMAGE="ghcr.io/kekzim/bolagetdb-sync:${IMAGE_TAG}"
MCP_IMAGE="ghcr.io/kekzim/systembolaget-mcp-server:${IMAGE_TAG}"
APPDATA=${APPDATA:-/mnt/user/appdata/sommelier}
NETWORK=${DOCKER_NETWORK:-sommelier_egress}
HOST_PORT=${HOST_PORT:-8848}
TZ=${TZ:-Europe/Stockholm}
CRON_SCHEDULE=${CRON_SCHEDULE:-0 19 * * 5}
SYNC_STORES=${SYNC_STORES:-1001 1002}
SYSTEMBOLAGET_API_KEY=${SYSTEMBOLAGET_API_KEY:-}
CELLAR_DIR=${CELLAR_DIR:-}

die() { echo "run.sh: $*" >&2; exit 1; }

require_mcp_env() {
  # Without a token the server accepts unauthenticated requests, and a private
  # network is not an authorisation boundary. Compose enforced this with `:?`.
  [ -n "${MCP_AUTH_TOKEN:-}" ] || die "MCP_AUTH_TOKEN is not set in .env (openssl rand -hex 32)"
  [ -n "${BIND_ADDR:-}" ] || die "BIND_ADDR is not set in .env (the Unraid LAN address)"
  [ "${BIND_ADDR}" != "0.0.0.0" ] || die "BIND_ADDR must be the LAN address, not 0.0.0.0"
}

ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"
}

# The tunnel is created by hand (it carries its own Cloudflare token) and is not
# managed here. It resolves sommelier-mcp by name, but recreating that container
# changes its IP and cloudflared can hold the old one -- which presents as the
# connector failing for no visible reason. Restarting it costs two seconds.
restart_tunnel() {
  if docker inspect sommelier-tunnel >/dev/null 2>&1; then
    docker restart sommelier-tunnel >/dev/null
    echo "restarted sommelier-tunnel"
  fi
}

start_sync() {
  [ -d "$APPDATA" ] || die "$APPDATA does not exist; see the runbook (it must be owned by uid 10001)"
  ensure_network
  docker pull "$SYNC_IMAGE"
  docker rm -f sommelier-sync >/dev/null 2>&1 || true
  docker run -d --name sommelier-sync --restart unless-stopped \
    --network "$NETWORK" \
    -e TZ="$TZ" \
    -e CRON_SCHEDULE="$CRON_SCHEDULE" \
    -e SYNC_STORES="$SYNC_STORES" \
    -v "$APPDATA:/data" \
    "$SYNC_IMAGE" >/dev/null
  echo "sommelier-sync: $SYNC_IMAGE, schedule '$CRON_SCHEDULE', stores '$SYNC_STORES'"
}

# The cellar is optional. When CELLAR_DIR is set it must already exist and
# belong to uid 10001: a bind mount keeps the host's ownership, and SQLite's
# complaint about an unwritable directory ("unable to open database file") says
# nothing about permissions. Checked here so it fails before anything changes.
check_cellar_dir() {
  [ -n "$CELLAR_DIR" ] || return 0
  [ -d "$CELLAR_DIR" ] || die "CELLAR_DIR $CELLAR_DIR does not exist; mkdir it and chown 10001:10001 (see the runbook)"
  owner=$(stat -c %u "$CELLAR_DIR")
  [ "$owner" = 10001 ] || die "CELLAR_DIR $CELLAR_DIR is owned by uid $owner, not 10001: chown -R 10001:10001 $CELLAR_DIR"
}

start_mcp() {
  require_mcp_env
  check_cellar_dir
  ensure_network
  # Positional parameters are this function's own, so this does not touch the
  # script's arguments.
  set --
  [ -z "$CELLAR_DIR" ] || set -- -v "$CELLAR_DIR:/cellar" -e CELLAR_DB_PATH=/cellar/cellar.db
  docker pull "$MCP_IMAGE"
  docker rm -f sommelier-mcp >/dev/null 2>&1 || true
  # /data read-only: the server has no business writing the mirror, and the
  # published copy is in rollback-journal mode precisely so this works.
  docker run -d --name sommelier-mcp --restart unless-stopped \
    --network "$NETWORK" \
    -p "${BIND_ADDR}:${HOST_PORT}:8848" \
    -e TZ="$TZ" \
    -e MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
    -e SYSTEMBOLAGET_API_KEY="$SYSTEMBOLAGET_API_KEY" \
    -v "$APPDATA:/data:ro" \
    "$@" \
    "$MCP_IMAGE" >/dev/null
  echo "sommelier-mcp: $MCP_IMAGE on ${BIND_ADDR}:${HOST_PORT}, cellar ${CELLAR_DIR:-disabled}"
  restart_tunnel
}

case "${1:-all}" in
  all)
    start_sync
    start_mcp
    ;;
  sync) start_sync ;;
  mcp) start_mcp ;;
  status)
    docker ps -a --filter name=sommelier --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
    ;;
  *)
    echo "usage: run.sh [all|sync|mcp|status]" >&2
    exit 64
    ;;
esac
