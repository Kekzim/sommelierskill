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

## Commands

```bash
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
