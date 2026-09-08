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
# The unprivileged user the sync runs as. The container starts as root only so
# that crond works; every job drops to this user.
RUN_USER=bolaget
# Job output goes here and is streamed to the container's stdout. It used to go
# to /proc/1/fd/1, which stops working the moment PID 1 is root: /proc/1/fd is
# mode 0500, so an unprivileged job cannot open it.
JOB_LOG=/tmp/sync.log

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

# busybox crond executes nothing unless it is root, and silently skips any
# crontab whose user has a nologin shell. Neither failure is reported at any
# log level: crond starts, says "started, log level 8", and sits there forever
# having never parsed the crontab. That is exactly how a weekly schedule that
# had never fired once went unnoticed -- the only sync that ever ran was the
# initial inline one below.
#
# So both conditions are asserted at startup, and failing them kills the
# container rather than letting it idle convincingly.
assert_cron_can_run() {
  if [ "$(id -u)" != 0 ]; then
    log "FATAL: crond needs to be root to run anything; this container is uid $(id -u)."
    log "  busybox crond loads no crontab at all when unprivileged, and says nothing."
    return 1
  fi
  shell=$(awk -F: -v u="$RUN_USER" '$1 == u { print $7 }' /etc/passwd)
  case "$shell" in
    */nologin | */false | '')
      log "FATAL: user $RUN_USER has shell '${shell:-none}'; crond skips such crontabs silently."
      log "  Give the user a real shell (adduser -s /bin/sh) in the Dockerfile."
      return 1
      ;;
  esac
  return 0
}

# A published database must actually contain the assortment. The journal-mode
# assertion only proves the file is openable -- a sync that failed before
# fetching anything still produces a valid, empty database, and publishing that
# takes the server down just as thoroughly as a corrupt one.
assert_has_products() {
  n=$(bolagetdb --db "$1" query --format csv "SELECT count(*) FROM product" 2>/dev/null | tail -1)
  case "$n" in
    ''|*[!0-9]*) log "FATAL: could not count products in $1"; return 1 ;;
  esac
  if [ "$n" -lt 1000 ]; then
    log "FATAL: $1 holds only $n products; refusing to publish."
    log "  The sync did not complete. The previous mirror is left in place."
    return 1
  fi
  # A collapse relative to what is already live means something went wrong even
  # if the run reported success.
  if [ -f "$LIVE" ]; then
    prev=$(bolagetdb --db "$LIVE" query --format csv "SELECT count(*) FROM product" 2>/dev/null | tail -1)
    case "$prev" in
      ''|*[!0-9]*) prev=0 ;;
    esac
    if [ "$prev" -gt 0 ] && [ "$n" -lt $((prev / 2)) ]; then
      log "FATAL: $n products vs $prev already live -- refusing to publish a collapse."
      return 1
    fi
  fi
  log "published database holds $n products"
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
    return 1
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

  # These are checked explicitly rather than relying on `set -e`. run_once is
  # called from a `||` list so the shell can keep the schedule alive when a sync
  # fails -- and POSIX disables errexit inside any command in such a list, which
  # once let a failed sync run on and publish a database with no products in it.
  #
  # --no-snapshot because the JSONL archive is a development artifact: the
  # container has nowhere writable to put it, and it would fill appdata.
  # shellcheck disable=SC2086
  if ! bolagetdb --db "$WORK" sync --no-snapshot $store_args; then
    log "FATAL: sync failed; not publishing. The previous mirror is untouched."
    return 1
  fi
  # Store names and addresses come from a separate call; without it the mirror
  # knows site 1001 carries a wine but not that it is Wachtmeister.
  if ! bolagetdb --db "$WORK" stores; then
    log "FATAL: store metadata failed; not publishing."
    return 1
  fi

  rm -f "$STAGE"
  if ! bolagetdb --db "$WORK" query "VACUUM INTO '${STAGE}'"; then
    log "FATAL: publishing failed."
    return 1
  fi

  assert_readonly_safe "$STAGE" || return 1
  assert_has_products "$STAGE" || return 1

  # Atomic within the volume: a reader sees the old file or the new one, never a
  # partial write. The server notices the inode change and reopens.
  mv "$STAGE" "$LIVE"
  rm -f "$WORK" "${WORK}-wal" "${WORK}-shm"

  log "published $(du -h "$LIVE" | cut -f1) to $LIVE"
}

case "${1:-schedule}" in
  once)
    # crond already invokes this as $RUN_USER. A `docker exec` from the host
    # arrives as root, and a root sync would leave root-owned files in /data
    # that the next unprivileged run could not rewrite -- so drop here too.
    if [ "$(id -u)" = 0 ]; then
      exec su "$RUN_USER" -c "$0 once"
    fi
    run_once
    ;;
  schedule)
    log "schedule: $SCHEDULE (TZ=${TZ:-UTC}); stores: $STORES"
    assert_cron_can_run || exit 1
    if [ ! -f "$LIVE" ]; then
      log "no mirror yet, running an initial sync before scheduling"
      # Through $0, not run_once, so it drops to $RUN_USER like every other run.
      "$0" once || log "initial sync failed; the schedule still stands"
    fi
    # The crontab must be named for the user the job should run as -- crond
    # switches to it. Naming it after the *current* user would run the sync as
    # root, which is precisely what this arrangement is avoiding.
    mkdir -p /tmp/crontabs
    echo "$SCHEDULE /usr/local/bin/sync.sh once >> $JOB_LOG 2>&1" > "/tmp/crontabs/$RUN_USER"
    : > "$JOB_LOG"
    chown "$RUN_USER" "$JOB_LOG"
    # PID 1 will be crond, so the job cannot write to the container's stdout
    # directly. Tail the job log into it instead, or `docker logs` shows the
    # schedule line and then nothing for the rest of the container's life.
    tail -F "$JOB_LOG" 2>/dev/null &
    log "crontab installed for $RUN_USER (uid $(id -u "$RUN_USER")); waiting for $SCHEDULE"
    exec crond -f -d 8 -c /tmp/crontabs
    ;;
  *)
    echo "usage: sync.sh [once|schedule]" >&2
    exit 64
    ;;
esac
