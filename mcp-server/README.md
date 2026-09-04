# systembolaget-mcp-server

An MCP server over the local `bolagetdb` mirror of Systembolaget's assortment.
Nine read-only tools plus one live shelf-stock check, served over streamable
HTTP.

The point is the same as the rest of this repo: Systembolaget's own API is a
product search, not a query engine — no aggregation, no boolean logic, no
derived sorting. This exposes the mirror as tools an agent can actually reason
with.

## Running it

```bash
npm install && npm run build && npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `BOLAGETDB_PATH` | `~/.local/share/bolagetdb/bolaget.db` | The mirror to read |
| `HOST` | `127.0.0.1` | Bind address — set to the VPN interface to serve other machines |
| `PORT` | `8848` | |
| `MCP_AUTH_TOKEN` | *unset* | Bearer token. **Unset means no auth at all.** |
| `SYSTEMBOLAGET_API_KEY` | *unset* | Enables live stock checks; everything else works without it |
| `ALLOWED_ORIGINS` | *unset* | Comma-separated origins allowed to send an `Origin` header |

`GET /health` reports the product count and the resolved database path. The MCP
endpoint is `POST /mcp`.

The mirror is **not** in the repo. Build it with `bolagetdb sync` first — see the
repo README.

## Tools

| Tool | For |
|---|---|
| `systembolaget_search_products` | The workhorse: name, category, grape, pairing, price, taste clocks, dietary flags, store |
| `systembolaget_search_tasting_notes` | Boolean full-text over Swedish tasting notes — the thing Systembolaget's own site cannot do |
| `systembolaget_get_product` | One product in full, with grapes, pairings and which stores carry it |
| `systembolaget_find_similar` | Taste-clock distance plus shared grapes; the "like that, but cheaper" tool |
| `systembolaget_upcoming_releases` | What drops on a given date, including pre-announced future releases |
| `systembolaget_list_stores` | Store ids, and which stores have mirrored assortments |
| `systembolaget_check_stock` | Live shelf count and shelf position — the only tool that leaves the mirror |
| `systembolaget_data_freshness` | Last sync, coverage, mirrored stores |
| `systembolaget_query` | Read-only SQL escape hatch for aggregation and odd joins |

### Examples

Upcoming releases, the drops that disappear:

```json
{"name":"systembolaget_upcoming_releases","arguments":{"limited_only":true,"max_price":300}}
```

Web launches only — allocation drops applied for online, where the rarest
bottles appear:

```json
{"name":"systembolaget_upcoming_releases","arguments":{"web_launches":"only"}}
```

A smooth red under 150 kr that a specific shop carries:

```json
{"name":"systembolaget_search_products",
 "arguments":{"category":"Rött vin","max_price":150,"max_tannin":4,"store_id":"1001"}}
```

Cherry and tobacco but no oak:

```json
{"name":"systembolaget_search_tasting_notes",
 "arguments":{"match":"taste:(tobak AND körsbär) NOT taste:ek"}}
```

## Design notes

**The mirror is reopened when it is swapped.** The sync job writes a fresh
database and renames it into place. That is atomic for the filesystem but not
for an open SQLite handle, which would keep reading the old inode and serve a
stale assortment forever without failing. `Mirror` stats the path before each
use and reopens on inode change.

**Availability is never omitted from output.** ~72% of wine is order-only. A
recommendation that does not say which tier a product is in is worse than no
recommendation, so `availability` appears on every product line and searches
default to `max_availability_rank: 1`.

**Web launches are labelled explicitly.** `Webblanseringar` are allocation drops
applied for online, not bottles to queue for. Their assortment text is not a
shelf tier, so they fall back to `order_only` — technically correct and
actively misleading in a release listing. The release tool labels them and can
filter them in or out.

**Stock is never cached.** Product facts are mirrored because they change
slowly; shelf stock changes hourly and is read live, for a shortlist only, at
most 10 products per call. This is an undocumented API.

**The SQL tool is read-only three times over**: the SQLite connection is opened
`readOnly`, only a single `SELECT`/`WITH` statement is accepted, and a query
without its own `LIMIT` is capped. The connection is the real guarantee; the
validation exists to give a clear error rather than a confusing SQLite one.

**Auth is on even inside the network.** The server is reachable only over the
VPN, but a private network is not an authorisation boundary. Set
`MCP_AUTH_TOKEN`; the check is constant-time.

## Running it in Docker

From the repo root:

```bash
cp .env.example .env    # set MCP_AUTH_TOKEN (openssl rand -hex 32)
docker compose up -d
```

Two services share one volume. `sync` writes it: it refreshes the mirror on a
schedule and publishes a copy. `mcp` mounts the same volume **read-only** and
serves it. The MCP port binds to `127.0.0.1` unless `BIND_ADDR` says otherwise —
set that to the VPN address to reach it from another machine.

With an empty volume the first run builds the mirror from scratch, which takes
about 25 minutes. The server starts anyway and reports the missing database
through `/health` rather than crash-looping.

### The publish step, and the trap in it

The sync job never edits the live file. It copies it, syncs the copy, then
writes the result with `VACUUM INTO` and renames that into place. Two separate
reasons:

**Atomicity.** Rename is atomic within the volume, so a reader sees the old
database or the new one, never a half-written one. The server compares the inode
before each use and reopens when it changes — verified: a swap under a running
server is picked up with no restart.

**Read-only openability.** `bolagetdb` keeps the mirror in WAL mode, and SQLite
**cannot open a WAL database read-only** — it wants to create a `-shm` sidecar
and fails with `attempt to write a readonly database`. `VACUUM INTO` writes a
fresh database in rollback-journal mode, which opens read-only cleanly, and
compacts it on the way.

> **Never point `bolagetdb` at the published database.** `Open()` sets
> `journal_mode=WAL` in its DSN, so any command against the live file — even
> `query "SELECT 1"` — silently converts it back to WAL and breaks the server.
> Work on a copy. The publish step asserts the write version before renaming,
> and the server explains this specific cause if it happens anyway.

### If the volume was seeded by hand

Restoring a backup instead of waiting 25 minutes is reasonable, but the files
must be owned by uid 10001, and so must the directory — SQLite needs to create
sidecar files next to the database:

```bash
docker run --rm -v sommelier_mirror:/data alpine chown -R 10001:10001 /data
```

Without it the sync fails with SQLite's `attempt to write a readonly database`,
which does not mention permissions at all. The sync script checks for this up
front and prints the fix.

### Schedule

`CRON_SCHEDULE` defaults to `0 19 * * 5` — Friday evening, Europe/Stockholm.
Releases land weekly on Thursday and Friday and are pre-announced, so a weekly
run sees next week's drops before they happen; nightly would triple the load on
an undocumented API for nothing. Run one on demand with:

```bash
docker compose exec sync /usr/local/bin/sync.sh once
```

## Deploying to Unraid

`deploy/unraid/` holds a standalone compose file that pulls pre-built images from
GHCR, plus `RUNBOOK.md` with the exact steps. The NAS never builds: images are
built and pushed from a workstation with the repo's own `compose.yaml`, and only
`compose.yaml` and `.env` go on the server.

Two things bite if skipped, both documented in the runbook: the appdata directory
must be owned by uid 10001 before the first run, and the published database must
be produced with `VACUUM INTO` rather than copied.

## Connecting a client

The server speaks streamable HTTP at `POST /mcp` and expects the bearer token in
an `Authorization` header. Copy `.mcp.json.example`, fill in the host and token,
and place it where your client reads MCP configuration — for Claude Code that is
`.mcp.json` in the project directory, or `~/.claude.json` for every project.

```json
{
  "mcpServers": {
    "systembolaget": {
      "type": "http",
      "url": "http://YOUR-VPN-HOST:8848/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

`claude mcp add` can register it from the command line instead; check
`claude mcp add --help` for the current flags rather than trusting a snippet.

**Do not commit the filled-in file** — it holds the token. `.mcp.json` is
gitignored for that reason; the example is not.

Check it end to end before wiring a client up:

```bash
curl -s -H 'Authorization: Bearer YOUR_MCP_AUTH_TOKEN' \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -X POST http://YOUR-VPN-HOST:8848/mcp \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Nine tools come back. A 401 means the token does not match; a connection refusal
usually means `BIND_ADDR` is still `127.0.0.1` on the server.
