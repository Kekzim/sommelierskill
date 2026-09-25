# Deploying to Unraid

Phase 01 of the deployment plan: get the stack running on the NAS and reachable
on the LAN. Exposing it to the internet is Phase 02 and deliberately separate —
do not skip ahead, because the gate below is what makes that step safe.

The NAS never builds anything. Images are built on a workstation, pushed to
GHCR, and pulled here. Two files go on the server: `run.sh` and `.env` beside
it.

**There is no Compose here, on purpose.** Unraid ships none; it comes from the
Compose Manager plugin. When that plugin went missing the whole stack became
unmanageable at once — `docker compose` was an unknown command, and the `.env`
next to the compose file was then read by nothing, so edits to it appeared to
work and did nothing. `run.sh` is plain `docker run` and depends on no plugin.

---

## A. On the workstation — build and push (once per release)

Log in to GHCR. A GitHub personal access token with `write:packages` works as the
password. It must be a **classic** token; fine-grained tokens do not work with
the container registry.

```bash
docker login ghcr.io -u Kekzim
```

Then cut a release. Both images get the version tag and `latest`:

```bash
make release VERSION=v1.0.0
```

Pick the next version yourself; nothing derives it. The target warns if the
working tree is dirty, because an image built from uncommitted changes matches
no commit and cannot be rebuilt later.

**Make the packages public**, or the NAS needs a pull credential. They contain no
secrets — the mirror is a runtime volume, never baked into an image — so public
is the simpler choice. Do it once per package under the repository's Packages
settings on GitHub. To keep them private instead, run the same `docker login` on
the NAS with a token limited to `read:packages`.

---

## B. On Unraid — prepare the data directory

This must happen **before** the first run. Both containers run as uid `10001`,
which is not Unraid's `99:100` convention, and SQLite needs to create sidecar
files next to the database — so the *directory* has to be writable, not just the
file.

```bash
mkdir -p /mnt/user/appdata/sommelier && chown -R 10001:10001 /mnt/user/appdata/sommelier
```

Skip this and the sync fails with `attempt to write a readonly database`, which
says nothing about permissions. The preflight check in the sync container catches
it and prints the fix, but it costs you a cycle.

---

## C. On Unraid — configure

Copy `run.sh` and `.env.example` into a directory of your choosing, rename the
latter to `.env`, and fill in:

- `MCP_AUTH_TOKEN` — generate with `openssl rand -hex 32`
- `BIND_ADDR` — the Unraid LAN address, e.g. `192.168.1.10`
- `IMAGE_TAG` — the release from step A

Leave `BIND_ADDR` off `0.0.0.0`. Until the tunnel exists, binding to the LAN
address is what keeps this off every other interface, and `run.sh` refuses
`0.0.0.0` outright.

`.env` is parsed the way Compose parsed it — `KEY=VALUE`, quotes optional — so
values containing spaces (`SYNC_STORES=1001 1002`, `CRON_SCHEDULE=0 19 * * 5`)
need no quoting. It is deliberately not *sourced*: running it as shell would
turn that first line into `SYNC_STORES=1001` followed by an attempt to execute
`1002`.

---

## D. Start it, and watch the first sync

```bash
./run.sh
```

That pulls both images, recreates both containers, and restarts the tunnel if
one exists. Then watch:

```bash
docker logs -f sommelier-sync
```

With an empty data directory the first run builds the mirror from scratch:
**about 25 minutes**, paced deliberately because this is an undocumented API.
Stay on the logs for it. You are watching for the slice walk to complete
(17 slices), then the store passes, then a line reporting the published size.

If it fails, the mirror is not corrupted — the prune guard refuses to delete
after an incomplete run — so re-running is safe.

**Faster alternative:** if you already have a good mirror on the workstation, seed
it instead of waiting. Publish a read-only-safe copy and drop it in:

```bash
bolagetdb query "VACUUM INTO '/tmp/seed.db'"
```

Copy `seed.db` to the appdata directory **as `bolaget.db`**, then
`chown 10001:10001` it. Use `VACUUM INTO`, not `cp` — a plain copy is in WAL mode
and the server cannot open a WAL database read-only.

---

## E. Verify

```bash
./run.sh status
```

Both containers up, on the tag you pinned. Then:

```bash
curl -s http://<unraid-lan-ip>:8848/health
```

Expect `{"ok":true,"products":27000-ish,...}`. Then confirm the tools answer:

```bash
curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer <token>' -X POST http://<unraid-lan-ip>:8848/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Nine tools come back. A `401` means the token does not match `.env`; a refused
connection usually means `BIND_ADDR` is wrong.

The `query` tool's description should list `is_web_launch` among the product
columns. That list is built at startup from `pragma_table_xinfo('product')`, so
its presence proves the server is reading the real mirror rather than falling
back to a static list.

> **Gate for Phase 02.** `/health` answers from another machine on the LAN, and a
> full sync has completed in-container and published without the header
> assertion firing. Do not open anything to the internet until both hold.

Once that holds, `TUNNEL.md` covers exposing it to Anthropic and nothing else.

---

## Updating to a new release

Set `IMAGE_TAG` in `.env`, then:

```bash
./run.sh
```

The mirror lives in the bind mount, so it survives image updates untouched.

**Pin `IMAGE_TAG`; do not track `latest`.** `latest` moves under you — a pull
months from now can bring in a change nobody read, and nothing on the running
box says which build it is. A pinned tag makes an upgrade a decision, and makes
rolling one back a one-line edit followed by `./run.sh`.

## Changing the schedule

The sync container runs as **root**, and only because busybox crond refuses to
load a crontab otherwise. The sync itself runs as uid 10001: crond drops to
`bolaget` for the job, and so does `sync.sh once`. If either condition that
crond needs is ever broken, the container exits 1 at startup with a FATAL line
rather than idling — it will not silently fail to run again.

The crontab is written when the container starts, from `$CRON_SCHEDULE`. A
restart does not re-read it — the container must be recreated:

```bash
./run.sh sync
```

This is the step that bites. Editing `.env` alone changes nothing until you run
that, and `docker restart sommelier-sync` is not enough either.

To fire once at a specific time — proving the scheduled path works without
waiting a week — use a dated expression like `CRON_SCHEDULE=0 0 8 9 *` (midnight
on 8 September). **Compute it from the container's clock, not the host's**: the
Unraid host reports UTC while the containers run Europe/Stockholm, so an
expression worked out on the host lands two hours off.

```bash
docker exec sommelier-sync sh -c 'date -d @$(( $(date +%s) + 300 )) "+%-M %-H %-d %-m *"'
```
 Prefer that to `0 0 * * *`: if you forget to revert, a one-shot
goes quiet, while a nightly keeps hammering an undocumented API every night,
which is exactly what the weekly cadence exists to avoid.

## Running a sync on demand

```bash
docker exec sommelier-sync /usr/local/bin/sync.sh once
```

Safe at any time: a failure publishes nothing and leaves the live mirror alone.

## The cellar (optional)

The server can also keep your own wine cellar: what you have, where it is, when
to drink it, and how you rated what you opened. It adds four tools and is off
unless `CELLAR_DIR` is set.

It gets its own directory rather than living beside the mirror. The mirror is
mounted read-only and replaced every week; the cellar is written on every change
and is the only thing here that cannot be rebuilt.

```bash
mkdir -p /mnt/user/appdata/sommelier-cellar
chown 10001:10001 /mnt/user/appdata/sommelier-cellar
```

Set `CELLAR_DIR=/mnt/user/appdata/sommelier-cellar` in `.env`, then:

```bash
./run.sh mcp
```

`run.sh` refuses to start if the directory is missing or not owned by uid 10001,
and says which. Check it took:

```bash
curl -s http://BIND_ADDR:8848/health
```

`/health` now carries a `cellar` object with its path and bottle count, and
answers `ok: false` if the cellar cannot be written. Claude's connector may need
disconnecting and reconnecting before the new tools appear.

**Back it up.** Keeping it under `/mnt/user/appdata` puts it where the Appdata
Backup plugin looks. The database stays in rollback-journal mode, so the single
file `cellar.db` is complete between writes, and a plain copy is a usable backup:

```bash
cp /mnt/user/appdata/sommelier-cellar/cellar.db /mnt/user/backups/cellar-$(date +%F).db
```

## The one thing that will break it

**Never point `bolagetdb` at the published database.** Opening it sets
`journal_mode=WAL`, and the server reads from a read-only mount where a WAL
database cannot be opened at all — so even `query "SELECT 1"` against
`/data/bolaget.db` takes the server down until the next publish. Work on a copy.
The server recognises this specific failure and says so in `/health` rather than
repeating SQLite's unhelpful `unable to open database file`.
