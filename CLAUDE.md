# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local SQLite mirror of Systembolaget's full assortment (~27k products), built
because their API is a product search rather than a query engine: free text is
single-term, there is no aggregation, no boolean logic and no derived sorting.
A full sync takes ~25 minutes and yields a ~115 MB database, and turns all of
that into SQL.

Data is fetched via [systembolaget-api](https://github.com/AlexGustafsson/systembolaget-api)
used as a **library**, not by shelling out to its CLI.

## First run on a new machine

**The database is not in the repo** (~115 MB, gitignored). A fresh clone has no
data, so every `query`, `stats` and `export` fails until it is built:

```bash
make install                                        # -> ~/.local/bin/bolagetdb
bolagetdb sync --store 0102 --store 1001 --store 1002
bolagetdb stores                                    # store metadata, one API call
make skill                                          # -> dist/sommelier.zip
```

**`bolagetdb stores` with no arguments is a required step, not an optional
one.** `sync --store` mirrors a store's *assortment* into `store_product`; the
`store` table holding names and addresses is only written by the bare `stores`
command. Skip it and `bolagetdb stats` reports `stores 0` while the assortments
are demonstrably present, and worse, `export` copies store names into the
snapshot — so the shipped skill knows site `1001` carries a wine but not that it
is Wachtmeister. `--search` does *not* do this: it queries the API live and
prints, writing nothing.

The sync takes ~25 minutes. **Run it in a real terminal, not as a backgrounded
command from a Claude Code session** — session teardown sends a signal that
cancels the context, and two attempts died that way mid-run. A partial sync is
not corrupting (the prune guard refuses to delete after an incomplete run) but
it leaves the mirror half-refreshed, which `bolagetdb stats` will show as rows
carrying two different `synced_at` dates.

The store ids above are the ones this project cares about: **1001
Wachtmeister** and **1002 Amiralen** are the maintainer's two local shops;
**0102 Fältöversten** (Stockholm) is kept from testing. Store
assortments are opt-in per store, roughly a minute each; mirroring all ~450
would take about 11 hours. Find ids with `bolagetdb stores --search <town>`.

The module is `github.com/Kekzim/sommelierskill`, matching the repository; the
binary and the CLI are still `bolagetdb`, which is what the package inside it
is. The two names are not meant to converge.

Go 1.21 or newer is enough — `go.mod` asks for 1.26.4 and `GOTOOLCHAIN=auto`
fetches it. `make skill` also needs `zip`. There is no cgo and no `sqlite3`
dependency.

## Commands

```bash
make install                # build + install to ~/.local/bin
make skill                  # build the Claude apps package -> dist/sommelier.zip
make skill-nas              # ...but from the NAS mirror, which is the current one
make release VERSION=v1.0.3 # build + push both container images to GHCR
make build                  # -> ./bolagetdb
make test                   # go test ./...
make vet
go test ./internal/store/ -run TestFTSBooleanSearch -v   # single test
(cd mcp-server && npm test)                              # MCP server tests (node:test)

./bolagetdb sync                            # full pull, ~25 min
./bolagetdb sync --only "Rött vin" --no-enrich --no-snapshot   # fast dev loop
./bolagetdb sync --store 0102               # also mirror one store's assortment
./bolagetdb stores --search majorna         # find store ids
./bolagetdb stats                           # contents + staleness
./bolagetdb query --format json "SELECT ..."
```

`--only` filters slices by substring and is the way to iterate without waiting
for a full sync. There is no `sqlite3` dependency — the driver is pure Go
(`modernc.org/sqlite`), so `query` is the way in.

`dbPath` resolves the database: `--db`/`$BOLAGETDB`, then `./bolaget.db` if it
exists, then `~/.local/share/bolagetdb/bolaget.db`. Never hardcode a path in a
skill or doc — the repo must clone cleanly onto another machine, and the
database is not committed.

## Architecture

Four packages, one direction of flow:

```
cmd/bolagetdb   CLI: sync / stores / query / stats
internal/fetch  slice discovery, multi-pass paging, enrichment
internal/normalize  raw API record -> typed row (+ grapes.tsv synonyms)
internal/store  columns.go (the product table, declared once), schema.sql, upserts
```

`sync` is the only complex flow: discover slices → walk each slice until fully
covered → normalise → upsert in one transaction → enrichment passes → optimize.

## Domain constraints that drove the design

These were measured against the live API. They are not obvious from the code and
are expensive to rediscover.

**Pagination is unstable.** The API pages by offset over an ordering that
shuffles between requests, so one walk returns some products twice and never
returns others — while the row count still matches the reported total. Fetching
with no `sortBy` misses **22.7%** of the assortment; `Name` ascending misses
0.96%. `fetch.FetchSlice` therefore walks each slice repeatedly under different
sort orders (`passOrders`) until distinct count reaches the API's reported
count. The enrichment and store-assortment walks share this via
`fetch.collectIDs` — a single walk there lost 134 of 1,043 vegan products.
Never "simplify" any of these back to a single pass, and route any new
id-collecting query through `collectIDs`.

**A query returns at most ~9,990 products** (page size caps at 30, page number
at 333), so the assortment must be fetched in slices. `PlanSlices` reads the
API's own category facets and subdivides only categories that exceed the cap —
currently 17 slices, since only `Vin` needs splitting. Do not hardcode the slice
list; it self-adjusts when categories change.

**`otherSelections` is filterable upstream but never returned.** A wine matched
by `otherSelections=Vegansk` has `"otherSelections": null` in its own record.
Vegan / natural / gluten-free / kosher status exists in no API response and is
materialised by separate enrichment passes into `is_vegan`, `is_natural`,
`is_gluten_free`, `is_kosher`. `NULL` in those columns means *unknown*, not
false.

**"In the catalogue" is not "on a shelf".** ~72% of wine is `Ordervaror`
(order-only). The `availability` / `availability_rank` columns normalise this.
Unknown assortment names deliberately default to `order_only` — overstating
availability is the failure mode that misleads a recommendation.

**Data quality tracks availability.** Tasting notes are present for 99.7% of
`stocked` products, 53.7% of `limited` and 11.9% of `order_only`. A missing
`taste` usually means "not stocked", not "no flavour".

**`cat3` is NULL for ~62% of wine** (~76% of red wine). Filtering on it
silently drops most of a category.

**Absent text is stored as NULL, not `""`.** `normalize` returns `""` for any
omitted field; `store.nullIfEmpty` converts those on the way in. Without it
`WHERE taste IS NOT NULL` matches every row — a wrong answer with no error.
Route new optional text columns through it (see `TestAbsentTextIsNull`).

**Upserts never delete, so `sync` prunes.** Anything Systembolaget delists
would otherwise linger in the mirror forever and be recommended long after it
stopped existing. After the fetch, products whose `synced_at` predates the run
are removed along with their grape, pairing and store rows.

Pruning only happens when the run is demonstrably complete — every slice
fetched, no failures, no `--only` filter, products not skipped. Pruning after a
partial run would delete good products merely because their slice failed. A
partial run logs that it skipped the prune. `--no-prune` opts out.

**Slices that fail are retried once, at the end of the run.** A 429 is not a
property of one request: Systembolaget refuses *everything* for minutes at a
time, so the per-request backoff in `fetch.RetryingClient` spends its attempts
against a door that is shut for the whole window, and consecutive slices fall
one after another. The sweep costs nothing when nothing failed, and the
remaining slices supply most of the cool-off for free (`--retry-delay`, default
2 minutes, covers the rest).

Measured on 2026-09-11: the throttle began at 19:13 and had lifted by 19:19, but
three slices had already given up inside it — while enrichment and both store
assortments, running minutes later, completed normally. The whole run was
discarded over a throttle that had already passed.

**The throttle is not a request quota — it looks like time of day.** The first
reading suggested a quota: 429s arrived 12 minutes in on 2026-09-08 and 13 on
2026-09-11, both around 1,500 requests. That was wrong. A run starting 22:12 the
same evening made ~2,661 requests over 23 minutes and was never refused once.

What separates them is the hour. 19:00 on a Friday is peak Systembolaget
traffic; 22:12 is quiet, and the 2026-09-08 refusal was self-inflicted (a second
full sync within an hour). A load-adaptive limiter fits all three; a quota fits
none. So **raising `--page-delay` is the wrong lever** — it would stretch the
run through more of the busy window, not less. Sync at a quiet hour instead.

Since confirmed, as far as one slot can: moved to Friday 23:00, the run of
2026-09-18 completed in 28 minutes with `errors=0` and no 429 at all. Every
throttle on record now has one of two causes — a full walk started within the
hour of another (2026-09-08 14:11, 2026-09-11 23:00), or the 19:00 peak slot
(2026-09-11). Only the last was not self-inflicted, and 23:00 avoids it.

Note that failed runs leave no trace in `sync_run`: the table lives in the work
copy, which is discarded rather than published. An absent row is how you spot
one after the fact.

**`sync_run.products` counts what was stored, not the sum of slice coverage.**
Those differ once coverage is counted per slice: a product in two slices is
covered by both and stored once, and a retried slice would be counted twice.
`len(seen)` is the honest number.

**A slice's coverage is counted separately from what the sync has stored.**
`seen` is shared across slices so a product is stored once per sync; slice
coverage uses its own set. Conflating them was a real bug: a product belonging
to two slices was counted only for whichever slice reached it first, leaving the
other permanently short of its facet count. No sort order can recover a product
that was fetched, just earlier — and one short slice sets `incomplete`, which
vetoes the prune for the **entire run**. Two wines counted elsewhere kept ~27k
products' worth of delisted stock in the mirror for another week.

Measured rather than reasoned: `Vin / Smaksatt vin & fruktvin` reported 176 of
178 in a full sync and 178 of 178 fetched alone with `--only`. The facet counts
were right all along. `TestCoverageCountsProductsAlreadySeenInAnotherSlice`
drives `FetchSlice` through a fake transport and fails with the old counting.

**Stock is never mirrored.** Product facts change slowly and are cached; shelf
stock changes hourly and must be read live from
`sb-api-ecommerce/v1/stockbalance/store/{storeId}/{productId}` at the moment of
recommending.

**A product id is not a vintage.** Systembolaget keeps both `product_id` and
`product_number` when a wine's vintage changes: between the snapshots of
2026-08-20 and 2026-08-25, 49 products changed vintage under an unchanged id and
number, and none changed id. Within one sync the numbers are unique, so nothing
looks wrong. Across time they are not identities. Anything that remembers a
product beyond one sync — the cellar, or price history built from `snapshots/` —
has to record the vintage alongside the id, or a 2022 silently becomes the 2024,
tasting note and price included.

## Conventions

**`product.raw` holds the verbatim API JSON.** The upstream library types
products as `map[string]any` on purpose, because Systembolaget changes fields
without notice. Typed columns are a convenience view; keep `raw` populated so a
schema miss never loses data. Everything in `normalize` is defensive — a missing
or mistyped field yields a zero value rather than an error (see
`TestFromAPIWrongTypes`).

**`internal/normalize/grapes.tsv` is a versioned domain artifact**, not
generated code, and is embedded via `go:embed`. It documents the near-misses it
deliberately does *not* merge: `Petite sirah` is Durif not Syrah,
`Welschriesling` is not Riesling, `Pinotage` is not Pinot noir. Unknown grapes
pass through unchanged, and `product_grape.raw_name` always keeps the original,
so a bad mapping is reversible.

**Filters the upstream library does not wrap are added locally.**
`systembolaget.SearchFilter` is just `func(*url.Values)`, so gaps close without
forking — see `filterByOtherSelection`.

**`store.SetFlag` interpolates a column name into SQL** and therefore
allowlists it. Any similar helper must do the same.

**Transient upstream failures are retried in the transport, not at the call
sites.** `fetch.RetryingClient` wraps the `*http.Client` the upstream library
uses, so every request is covered — slice pages, enrichment passes, store
assortments, and the API-key fetch that the whole run depends on — without a
single call site knowing about it.

It retries 429, the transient 5xx family and network errors, five attempts,
backing off 5s → 10s → 20s → 40s with jitter, preferring `Retry-After` when the
server sends one. Cancelled or expired contexts are passed straight back: those
are the caller's decision, not a transient failure. It is patient on purpose —
when Systembolaget rate-limits it refuses everything for a while, so retrying a
second later is just another refusal.

Why it exists: on 2026-09-08 a single 429 arrived twelve minutes into a
twenty-minute sync and took six slices, all four enrichment passes and both
store assortments with it in under half a second. Nothing was published, which
is the guards working — but one refused request cost a week of freshness.

Two things the tests pin down beyond the obvious: a 404 must **not** be retried
(one wrong URL would become five), and the response body of every abandoned
attempt must be drained and closed, or a long sync leaks a connection per retry
with no visible symptom until it runs out of descriptors.

**Keep `--page-delay` non-zero.** This is an undocumented API and an agent will
otherwise hit it far harder than any human browsing session.

**Adding a column is one entry in `internal/store/columns.go`.** That file is
the only place the `product` table is declared. The `CREATE TABLE`, the upsert's
column list, its placeholders, its `DO UPDATE SET`, the argument slice, the
migration, and the snapshot's schema and copy statement are all generated by
walking `productColumns` in order, so they cannot disagree.

Each entry decides the rest: `backfill` is a `json_extract` over `raw` that
recovers the column for rows already stored -- the verbatim JSON is what makes a
new column a three-second job rather than a 25-minute resync -- and `slim`
decides whether it travels in the app skill's snapshot. A `normalize.Product`
field and its `FromAPI` mapping are still needed, and an index still goes in
`schema.sql`.

`schema.sql` no longer holds the product table. It keeps everything that has
only one definition: indexes, triggers, the FTS table and the other tables.

The MCP server cannot import Go, so it asks the database instead: the `query`
tool's list of selectable columns is read at startup from
`pragma_table_xinfo('product')` (`xinfo`, not `info` -- `info` hides generated
columns, and `sek_per_litre` is one). It falls back to a static list when there
is no mirror to read, because the server starts without one on purpose. The
typed-out list it replaced had already drifted: `is_web_launch` was missing, so
an agent writing SQL had no way to tell a web allocation from a shop release.

Two tests hold this together. `TestUpsertArgumentsLineUpWithColumns` reads every
column back *by name* and compares it with the argument its value function
produced, so a builder that lists columns in one order and arguments in another
is caught. `TestSnapshotCarriesEverySlimColumn` exports a snapshot and checks
that every `slim` column arrives with the value it was stored with -- the check
that `launch_date` never had.

**busybox crond runs nothing unless it is root, and skips any crontab whose
user has a nologin shell.** Both failures are completely silent — at every log
level, crond prints `started, log level 8` and then sits there forever, having
never parsed the crontab. The sync image had `USER 10001` and `adduser -S`
(which gives `/sbin/nologin`), so it failed both conditions and **the weekly
schedule never fired once**. It went unnoticed for a week because the only sync
that ever ran was the initial inline one `sync.sh schedule` performs when it
finds no mirror, which looks exactly like a successful deployment.

So the sync container runs as root — that is the only reason it does — and
`crond` drops to `bolaget` for the job. `sync.sh once` drops too, so a
`docker exec` from the host does not leave root-owned files in `/data`.
`assert_cron_can_run` checks both conditions at startup and exits 1 rather than
idling convincingly; with `restart: unless-stopped` that surfaces as a
crash-loop, which is the point.

The job writes to `/tmp/sync.log`, tailed into the container's stdout. It used
to redirect to `/proc/1/fd/1`, which stops working the moment PID 1 is root:
`/proc/1/fd` is mode 0500, so an unprivileged job cannot open it, and
`docker logs` would show the schedule line and then nothing forever.

**The NAS deployment is `docker run`, not Compose.** Unraid ships no Compose of
its own — it comes from the Compose Manager plugin. When that plugin went
missing, `docker compose` became an unknown command and the `.env` beside the
compose file was suddenly read by nothing, so editing it looked like it worked
and did nothing at all. `deploy/unraid/run.sh` creates both containers with
plain `docker run` and depends on no plugin. The root `compose.yaml` stays: it
is the build file `make release` drives, and the NAS never touches it.

`run.sh` *parses* `.env` rather than sourcing it. Sourcing runs it as shell, so
an unquoted `SYNC_STORES=1001 1002` would set `SYNC_STORES=1001` and then try to
execute `1002`. Parsing `KEY=VALUE` literally keeps Compose's semantics, which
means a `.env` written for the old deployment still works untouched.

**The sync schedule is read only when the container is created.** `sync.sh`
writes the crontab at startup from `$CRON_SCHEDULE`, so changing `.env` and
restarting does nothing — the container must be recreated (`./run.sh sync`).
This is the single most likely way to believe a schedule changed when it did
not.

**`set -e` does not apply inside a function called from a `||` list.** POSIX
disables errexit for any command that is part of a `&&`/`||` list, and that
includes a shell function. `deploy/sync.sh` calls `run_once || log "..."` so a
failed first sync does not kill the scheduler — which silently meant *every*
failure inside `run_once` was ignored. A sync that died before fetching anything
still ran the store pass and published a database with no products in it. Every
step in `run_once` that must not be skipped therefore checks itself with
`if ! ...; then return 1; fi` rather than trusting errexit.

**A published database is checked for contents, not just format.**
`assert_readonly_safe` proves the file is openable; `assert_has_products` proves
the sync actually fetched something, and refuses a collapse to under half of
what is already live. The first guard would happily have published the empty
database that the errexit bug produced.

**Read commands must never go through `Open`.** `Open` sets
`journal_mode(WAL)` in its DSN, so any command routed through it rewrites the
header of whatever it touches. SQLite cannot open a WAL database read-only — it
wants to create a `-shm` sidecar and fails with "attempt to write a readonly
database" — and the MCP server reads the published file from a read-only mount,
so `query "SELECT 1"` used to take the server down until the next publish.

`OpenExisting` is therefore the read path: read-only, no pragmas beyond a busy
timeout, no migration, no schema. `query`, `stats` and `export` use it; only
`sync` and `stores` use `Open`. `VACUUM INTO` still works on a read-only
connection, which is what lets the publish step run through `query`.
`TestReadingDoesNotConvertToWAL` is the regression test — it fails with the
exact diagnostic if a read path is ever routed back through `Open`.

**`Open` creates the product table, then migrates, then applies `schema.sql`.**
The schema creates indexes over columns that migration is responsible for
adding, so applying it first to an older database fails on a missing column
*before* the migration that would have fixed it can run — leaving `Open`
permanently broken. Creating the table first also means migration never has to
special-case a database with no `product` table yet, which is what the
fresh-database branch used to be for.

## Where the work stands

Known open items, so a fresh session does not have to rediscover them:

- **The cellar is built but not deployed (branch `cellar`, as of 2026-09-25).**
  Four optional tools behind `CELLAR_DB_PATH`, including labelled profiles for
  wines Systembolaget does not describe — the maintainer's Champagne, mostly.
  Code, 17 tests (`cd mcp-server && npm test`), docs and both skills are on the
  branch; `main` does not have it. **Never verified: the container image.** The
  build hung at `npm ci` on the workstation's network (Cloudflare WARP
  suspected; the same install outside Docker took seconds), so the first image
  build, and the claim that a fresh named volume at `/cellar` inherits uid 10001,
  are both untested. Remaining, in order: `make release VERSION=v1.1.0` from
  this branch; on the NAS create `/mnt/user/appdata/sommelier-cellar` owned by
  10001, set `CELLAR_DIR` and `IMAGE_TAG` in `.env`, `./run.sh mcp`, confirm
  `/health` shows `cellar`, reconnect Claude's connector; rebuild and re-upload
  the apps skill (`make skill-nas`) so claude.ai gets the cellar rules; merge to
  `main` once it works. Then the maintainer enters the Champagnes — the fields
  are listed in `mcp-server/README.md` — and Claude fills in profiles from the
  `needs_profile` queue.
- **The scheduled sync is verified as of 2026-09-08.** It had never fired before
  that — busybox crond needs root and a non-nologin shell, and the image gave it
  neither, silently. Fixed in v1.0.1 and observed firing on the minute, running
  as uid 10001, taking the incremental branch. The weekly path is now exercised
  end to end; what has still never been observed is an *unattended* Friday run.
- **Assortment churn is ~87 products a day; net drift is ~0.4.** Measuring net
  change badly understates staleness. Over the week 2026-09-11 to 2026-09-18 the
  mirror went 27,107 -> 27,110 — a net of **+3** — while that run pruned 304 and
  added 307. Roughly 611 products changed. Additions and delistings nearly
  cancel, which makes the net look reassuring and is not.

  A week of staleness is therefore ~600 products wrong, about 2.3% of the
  assortment, not the 0.01% the net figure suggests. Weekly is still defensible;
  twice-weekly would halve it. Earlier net-only readings (27,225 -> 27,124 over
  ten days, 27,121 -> 27,071 over four) were measuring the wrong thing.
- **The first unattended run happened on 2026-09-11 and did not publish.** Cron
  fired at 19:00:00 exactly, took the incremental branch, and the coverage fix
  held: `Vin / Smaksatt vin & fruktvin` reported 181 of 181 where it had
  reported 176 of 178, and `incompleteSlices=0`. What killed it was the
  throttle — three slices exhausted their retries inside it. The end-of-run
  sweep (v1.0.4) is the answer to that and is the next thing to watch.
- **Whether any slice genuinely fails to converge is still unknown.** Both
  causes of `incomplete` seen so far were the counting bug, now fixed. The
  `note` column in `sync_run` records it; it will take several weekly runs to
  say. Watch that column rather than assuming.
- **Sharing the MCP server with other people — considered, not built.** The auth
  change is small: `authorise` in `mcp-server/src/index.ts` does one exact match
  against `MCP_AUTH_TOKEN`, so a list of `name:token` pairs plus a loop is ~20
  lines, and labelling them means one person can be revoked without disturbing
  anyone else. The Cloudflare WAF rule needs **no** change — other people's
  Claude connects from Anthropic's egress range too, not from their homes, so
  the IP allowlist keeps working unchanged.

  The gap to close first is not auth. `query` runs arbitrary SQL with a 500-row
  cap on output and nothing capping *work*, so a cartesian join over 27k
  products pins the container's single core; an agent writing a bad join gets
  there without malice. `busy_timeout` is about lock waits, not execution time.

  Two couplings worth remembering. `check_stock` would run on the owner's API
  key and go out through the owner's WAN address, so other people's lookups
  could get that IP rate-limited — and the thing that breaks is the weekly sync
  (see the 429 on 2026-09-08). And the NAS becomes their dependency: every
  reboot surfaces on their end as "couldn't reach the MCP server", which says
  nothing about the cause.

  Per-token rate limiting is real work and probably unnecessary until someone
  actually causes a problem.

  The cellar is the other coupling, if it is enabled: it is one cellar behind
  one set of tokens, so anyone with a token could read and edit it. A shared
  instance would need `CELLAR_DB_PATH` unset, or cellars scoped per token. Onboarding is the URL, a token, and telling them to
  type `Bearer ` in front of it — that omission cost two evenings once already.
- **The mirror may be mid-refresh.** Check with `bolagetdb stats`; if rows carry
  two `synced_at` dates, a sync was interrupted. Re-run a full sync, which will
  also prune whatever has been delisted since.
- **`push.gpgsign` is per-machine.** If it is `true` globally, pushes to GitHub
  fail with "the receiving end does not support --signed push" — GitHub signs
  commits, not pushes. Fix per-repo: `git config --local push.gpgsign false`.
- **Unanswered question: how many orange wines does Systembolaget carry?**
  There is no orange category — it has to be inferred. Name plus colour text
  gives ~71, but that misses wines advertised as `qvevri`, `anfora` or
  `macererad`, and ~3,300 white wines carry no colour description at all
  (almost all order-only). Any answer needs its uncertainty stated.

## Related work

The upstream CLI in `systembolaget-api` had `--sort-by` silently dropped
(`ctx.Value` instead of `cmd.String`). That is worse than it sounds: with
`sortBy` never sent, full-assortment dumps paged over an unstable ordering and
lost ~23% of products while reporting a plausible row count. A one-line fix
exists in that repo's working tree, uncommitted and unpushed.

## Agent-facing surfaces

Three of them now, and they are not interchangeable. Keep the method in step
across the two skills when anything changes; keep the schema in step across all
three.

`mcp-server/` — **the MCP server**. Nine tools over the full mirror plus a live
stock check, TypeScript, streamable HTTP, containerised alongside the Go sync
job. With `CELLAR_DB_PATH` set it also keeps the user's wine cellar: four more
tools over a separate, writable SQLite file, which is the only thing the server
writes and the only data in this whole setup that cannot be rebuilt. The root `compose.yaml` only *builds* those two images; the NAS runs them
with `deploy/unraid/run.sh`. This is the data-access surface: it is what the Claude
Code skill drives when it is configured, and it is reachable only where the
server is — inside the network, over the VPN. See `mcp-server/README.md`.

The tools describe their own parameters. **Do not restate them in a skill** —
that duplication is exactly how the two skills drifted apart the first time. A
skill carries routing and judgement; the tools carry their own interface.

`skill-claude-code/` — **Claude Code**. The judgement layer over whichever data
access is available.

  skill-claude-code/SKILL.md                  persona, method, rules, tone
  skill-claude-code/references/tools.md       which MCP tool, and when
  skill-claude-code/references/schema.md      schema, for raw SQL and the fallback
  skill-claude-code/references/preferences.md -> ../../skill/references/preferences.md

It drives the `systembolaget_*` MCP tools when they are configured and falls
back to `bolagetdb query` against the local mirror when they are not — the
method is identical either way, which is the point. The fallback matters
because the server is unreachable off the VPN.

It is installed **user-wide**, not per-project, by a symlink:

```bash
ln -s "$(pwd)/skill-claude-code" ~/.claude/skills/sommelier   # from the repo root
```

so it is active in every Claude Code session on that machine, not only when cwd
is this repo. Nothing in it is repo-relative — `bolagetdb` resolves the database
from `~/.local/share/bolagetdb/`, so working directory is irrelevant. It lives
in the repo (and not directly in `~/.claude/skills/`) so it stays versioned.

Do not put it back under `.claude/skills/` in this repo: it would then register
twice in any session opened here, once as a project skill and once as a user
skill.

Both skills carry the **same** method, rules and tone — that part is
runtime-independent and any change to one belongs in the other. What differs is
only the mechanics: `bolagetdb query` over all ~27k products with a live stock
check, versus `query.py` over the bundled ~10.5k snapshot.

`references/preferences.md` is a **symlink** to `skill/references/preferences.md`,
not a copy. It is pure domain judgement with no runtime coupling, so the two
runtimes share one file and cannot drift. Copying it back is how they diverged
the first time. `make skill` only reads `skill/`, so the symlink never reaches
the package.

The symlink is **relative and therefore depth-sensitive** — moving the skill
directory silently breaks it, and a broken `preferences.md` does not fail
loudly, it just drops the whole taste vocabulary. This already happened once
when the skill moved out of `.claude/skills/`. After any move, check it:

```bash
readlink -f ~/.claude/skills/sommelier/references/preferences.md
```

`skill/` — **the Claude apps** (claude.ai / desktop). This is the source;
`make skill` copies it into `dist/sommelier/`, adds the exported snapshot and
zips it (~2.0 MB). `dist/` is gitignored — edit `skill/`, never `dist/`.

**`make skill` exports from whichever mirror is on the machine running it**, and
on a workstation that is whatever was last synced *here* — which is nobody's job
and drifts. The NAS mirror is the one actually kept current, refreshed weekly by
the sync container, so `make skill-nas` copies that over `scp` and builds from
it. It asks for the NAS password; there is no key installed.

A stale snapshot is invisible — the package looks identical and simply gives old
prices and misses new releases — so every build now prints the snapshot's
`source_sync` age and warns past ten days, a little over one sync cycle. That
warning is how this was noticed: the shipped snapshot was thirteen days old
while the NAS had data from that morning.

Any mirror works as the source: `make skill SKILL_DB=/path/to/bolaget.db`.

  skill/SKILL.md                  persona, method, the rules that matter
  skill/references/preferences.md ordinary language -> SQL (the domain artifact)
  skill/references/schema.md      schema, query mechanics, tested recipes
  skill/scripts/query.py          stdlib-only runner

SKILL.md is loaded always; the references only when needed, so keep the method
in SKILL.md and the lookup tables in references. `preferences.md` is the piece
with real domain judgement in it — the taste-clock mappings, the Swedish
flavour vocabulary, the "something like a Burgundy" translations.

The snapshot holds only `availability_rank <= 2` — the ~10,500 products a
customer can realistically buy, out of ~27,000. That keeps it small, but means
absence from the snapshot does not imply absence from Systembolaget, and the
app-side skill says so explicitly.
