# Deploying to Unraid

Phase 01 of the deployment plan: get the stack running on the NAS and reachable
on the LAN. Exposing it to the internet is Phase 02 and deliberately separate —
do not skip ahead, because the gate below is what makes that step safe.

The NAS never builds anything. Images are built on a workstation, pushed to
GHCR, and pulled here. Two files go on the server: `compose.yaml` and `.env`.

---

## A. On the workstation — build and push (once per release)

Log in to GHCR. A GitHub personal access token with `write:packages` works as the
password; `gh auth token` will print one if the `write:packages` scope is on it.

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u Kekzim --password-stdin
```

Build and push both images:

```bash
cd /home/kazzim/repos/sommelierskill && MCP_AUTH_TOKEN=build docker compose build && docker compose push
```

`MCP_AUTH_TOKEN` is only there to satisfy interpolation during the build; it is
not baked into anything.

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

Put `compose.yaml` and `.env` in a directory of your choosing, e.g.
`/boot/config/plugins/compose.manager/projects/sommelier/`, or anywhere you
prefer if you are driving compose from the terminal.

Copy `.env.example` to `.env` and fill in:

- `MCP_AUTH_TOKEN` — generate with `openssl rand -hex 32`
- `BIND_ADDR` — the Unraid LAN address, e.g. `192.168.1.10`

Leave `BIND_ADDR` off `0.0.0.0`. Until the tunnel exists, binding to the LAN
address is what keeps this off every other interface.

The Docker Compose Manager plugin will run both files from the Unraid UI if you
would rather not use the terminal. The files are identical either way.

---

## D. Start it, and watch the first sync

```bash
docker compose pull && docker compose up -d && docker compose logs -f sync
```

With an empty data directory the first run builds the mirror from scratch:
**about 25 minutes**, paced deliberately because this is an undocumented API.
Stay on the logs for it. You are watching for the slice walk to complete
(17 slices), then the store passes, then a line reporting the published size.

This is the one path never verified end to end. Publish, atomic swap,
permissions and the read-only mount are all proven with real data; a complete
fetch inside a container is not. If it fails, the mirror is not corrupted — the
prune guard refuses to delete after an incomplete run — so re-running is safe.

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
curl -s http://<unraid-lan-ip>:8848/health
```

Expect `{"ok":true,"products":27000-ish,...}`. Then confirm the tools answer:

```bash
curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer <token>' -X POST http://<unraid-lan-ip>:8848/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Nine tools come back. A `401` means the token does not match `.env`; a refused
connection usually means `BIND_ADDR` is wrong.

> **Gate for Phase 02.** `/health` answers from another machine on the LAN, and a
> full sync has completed in-container and published without the header
> assertion firing. Do not open anything to the internet until both hold.

Once that holds, `TUNNEL.md` covers exposing it to Anthropic and nothing else.

---

## Updating later

```bash
docker compose pull && docker compose up -d
```

The mirror lives in the bind mount, so it survives image updates untouched. Pin
`IMAGE_TAG` in `.env` once you cut a real release rather than tracking `latest`.

## Running a sync on demand

```bash
docker compose exec sync /usr/local/bin/sync.sh once
```

## The one thing that will break it

**Never point `bolagetdb` at the published database.** Opening it sets
`journal_mode=WAL`, and the server reads from a read-only mount where a WAL
database cannot be opened at all — so even `query "SELECT 1"` against
`/data/bolaget.db` takes the server down until the next publish. Work on a copy.
The server recognises this specific failure and says so in `/health` rather than
repeating SQLite's unhelpful `unable to open database file`.
