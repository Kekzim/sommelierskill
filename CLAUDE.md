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
make skill                                          # -> dist/sommelier.zip
```

The sync takes ~25 minutes. **Run it in a real terminal, not as a backgrounded
command from a Claude Code session** — session teardown sends a signal that
cancels the context, and two attempts died that way mid-run. A partial sync is
not corrupting (the prune guard refuses to delete after an incomplete run) but
it leaves the mirror half-refreshed, which `bolagetdb stats` will show as rows
carrying two different `synced_at` dates.

The store ids above are the ones this project cares about: **1001
Wachtmeister** and **1002 Amiralen** are the owner's local shops in the
Karlskrona area; **0102 Fältöversten** (Stockholm) is kept from testing. Store
assortments are opt-in per store, roughly a minute each; mirroring all ~450
would take about 11 hours. Find ids with `bolagetdb stores --search <town>`.

Go 1.21 or newer is enough — `go.mod` asks for 1.26.4 and `GOTOOLCHAIN=auto`
fetches it. `make skill` also needs `zip`. There is no cgo and no `sqlite3`
dependency.

## Commands

```bash
make install                # build + install to ~/.local/bin
make skill                  # build the Claude apps package -> dist/sommelier.zip
make build                  # -> ./bolagetdb
make test                   # go test ./...
make vet
go test ./internal/store/ -run TestFTSBooleanSearch -v   # single test

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
internal/store  schema.sql (embedded), upserts, FTS triggers
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

**Stock is never mirrored.** Product facts change slowly and are cached; shelf
stock changes hourly and must be read live from
`sb-api-ecommerce/v1/stockbalance/store/{storeId}/{productId}` at the moment of
recommending.

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

**Keep `--page-delay` non-zero.** This is an undocumented API and an agent will
otherwise hit it far harder than any human browsing session.

## Where the work stands

Known open items, so a fresh session does not have to rediscover them:

- **The mirror may be mid-refresh.** Check with `bolagetdb stats`; if rows carry
  two `synced_at` dates, a sync was interrupted. Re-run a full sync, which will
  also prune whatever has been delisted since.
- **Module path is `github.com/ejonsvn/bolagetdb`** while the repo is
  `Kekzim/sommelierskill`. Harmless locally, breaks `go get`. Mechanical to
  change, deliberately left alone.
- **`push.gpgsign` is per-machine.** If it is `true` globally, pushes to GitHub
  fail with "the receiving end does not support --signed push" — GitHub signs
  commits, not pushes. Fix per-repo: `git config --local push.gpgsign false`.
- **Unanswered question: how many orange wines does Systembolaget carry?**
  There is no orange category — it has to be inferred. Name plus colour text
  gives ~71, but that misses wines advertised as `qvevri`, `anfora` or
  `macererad`, and ~3,300 white wines carry no colour description at all
  (almost all order-only). Any answer needs its uncertainty stated.
- **The two skills have diverged.** `skill/` has the sommelier persona and
  method; `.claude/skills/sommelier/` is still the older data-access-only
  version. The method is runtime-independent and could be shared; the
  mechanics (local binary and live stock vs bundled snapshot) cannot.

## Related work

The upstream CLI in `systembolaget-api` had `--sort-by` silently dropped
(`ctx.Value` instead of `cmd.String`). That is worse than it sounds: with
`sortBy` never sent, full-assortment dumps paged over an unstable ordering and
lost ~23% of products while reporting a plausible row count. A one-line fix
exists in that repo's working tree, uncommitted and unpushed.

## Agent-facing skills

There are two, targeting different runtimes. Keep both in step when the schema
changes.

`.claude/skills/sommelier/SKILL.md` — **Claude Code**. Drives the full local
database through `bolagetdb query`, and does live stock checks against the
Systembolaget API. Only active when Claude Code runs with this repo as cwd.

`skill/` — **the Claude apps** (claude.ai / desktop). This is the source;
`make skill` copies it into `dist/sommelier/`, adds the exported snapshot and
zips it (~2.0 MB). `dist/` is gitignored — edit `skill/`, never `dist/`.

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
