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
