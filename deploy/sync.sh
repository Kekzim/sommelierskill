#!/bin/sh
# Refresh the mirror, then publish a copy the MCP server can read.
#
# Two things make this more than "run sync":
#
#   1. The server must never see a half-written database. Sync works on a
#      scratch copy and the result is renamed into place, which is atomic.
#
#   2. The published file must be openable read-only. bolagetdb keeps the mirror
#      in WAL mode, and SQLite cannot open a WAL database from a read-only mount
#      -- it needs to create a -shm sidecar and fails with "attempt to write a
#      readonly database". VACUUM INTO writes a fresh database in rollback-journal
#      mode, which opens read-only cleanly, and compacts it on the way.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
LIVE="${DATA_DIR}/bolaget.db"
WORK="${DATA_DIR}/work.db"
STAGE="${DATA_DIR}/publish.tmp"

# Stores whose assortment is mirrored. Each costs about a minute.
STORES="${SYNC_STORES:-1001 1002}"
# Releases land weekly on Thursday and Friday and are pre-announced, so a weekly
# run picks up next week's drops before they happen. Nightly would triple the
# load on an undocumented API for nothing.
SCHEDULE="${CRON_SCHEDULE:-0 19 * * 5}"

log() { echo "[sync] $(date '+%Y-%m-%dT%H:%M:%S%z') $*"; }

# The published file must never be opened by bolagetdb: Open() sets
# journal_mode=WAL in its DSN, which converts the file back to WAL, and SQLite
# cannot open a WAL database from the server's read-only mount. Byte 18 of the
# header is the write version -- 1 is rollback journal, 2 is WAL.
assert_readonly_safe() {
  mode=$(od -An -tu1 -j18 -N1 "$1" | tr -d ' ')
  if [ "$mode" != "1" ]; then
    log "FATAL: $1 is in WAL mode (write version $mode)."
    log "  The MCP server mounts /data read-only and cannot open a WAL database."
    log "  Something ran bolagetdb against the published file. Re-publish with"
    log "  VACUUM INTO and do not point bolagetdb at \$LIVE."
    return 1
  fi
}

run_once() {
  log "starting refresh"

  # SQLite needs to create sidecar files, so the directory must be writable by
  # this user -- not just the database. A volume seeded as root fails here, and
  # the error SQLite gives ("attempt to write a readonly database") does not say
  # so. Seeding a backup by hand is exactly when this bites.
  if ! touch "${DATA_DIR}/.writable" 2>/dev/null; then
    log "FATAL: ${DATA_DIR} is not writable by uid $(id -u)."
    log "  Fix: docker run --rm -v <volume>:/data alpine chown -R 10001:10001 /data"
    exit 1
  fi
  rm -f "${DATA_DIR}/.writable"

  # Start from the current mirror so upserts are incremental and the prune can
  # tell what has been delisted. A missing mirror is a first run, not an error.
  if [ -f "$LIVE" ]; then
    cp "$LIVE" "$WORK"
    log "copied existing mirror to work file"
  else
    rm -f "$WORK"
    log "no existing mirror; building from scratch (~25 minutes)"
  fi
  rm -f "${WORK}-wal" "${WORK}-shm"

  store_args=""
  for s in $STORES; do
    store_args="$store_args --store $s"
  done

  # shellcheck disable=SC2086
  bolagetdb --db "$WORK" sync $store_args
  # Store names and addresses come from a separate call; without it the mirror
  # knows site 1001 carries a wine but not that it is Wachtmeister.
  bolagetdb --db "$WORK" stores

  rm -f "$STAGE"
  bolagetdb --db "$WORK" query "VACUUM INTO '${STAGE}'"

  assert_readonly_safe "$STAGE" || exit 1

  # Atomic within the volume: a reader sees the old file or the new one, never a
  # partial write. The server notices the inode change and reopens.
  mv "$STAGE" "$LIVE"
  rm -f "$WORK" "${WORK}-wal" "${WORK}-shm"

  log "published $(du -h "$LIVE" | cut -f1) to $LIVE"
}

case "${1:-schedule}" in
  once)
    run_once
    ;;
  schedule)
    log "schedule: $SCHEDULE (TZ=${TZ:-UTC}); stores: $STORES"
    if [ ! -f "$LIVE" ]; then
      log "no mirror yet, running an initial sync before scheduling"
      run_once || log "initial sync failed; the schedule still stands"
    fi
    # busybox crond needs the crontab under the running user's name.
    mkdir -p /tmp/crontabs
    echo "$SCHEDULE /usr/local/bin/sync.sh once >> /proc/1/fd/1 2>&1" > "/tmp/crontabs/$(id -un)"
    exec crond -f -d 8 -c /tmp/crontabs
    ;;
  *)
    echo "usage: sync.sh [once|schedule]" >&2
    exit 64
    ;;
esac
