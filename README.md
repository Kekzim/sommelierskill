# bolagetdb

A local, queryable mirror of Systembolaget's assortment, and the sommelier
skill built on top of it.

Two things live here: `bolagetdb`, the Go tool that mirrors and normalises the
assortment into SQLite, and `skill/`, the sommelier skill packaged for the
Claude apps. See [Skill packages](#skill-packages).

Systembolaget's API is a *product search*, not a query engine. It answers
"show me red wines under 200 kr" well, and cannot answer "which wines taste of
tobacco but not oak", "what is the average tannin level by country", or "what is
the best value per litre among full-bodied wines actually on a shelf".

`bolagetdb` pulls the whole assortment once, normalises it, and gives you SQL.

## Why mirror at all

Measured against the live API:

| Upstream limit | Detail |
|---|---|
| Free text is **single-term** | `tobak` → 144 hits, `läder` → 5, `tobak läder` → **0**. No AND, OR or NOT. |
| Page ceiling **~9,990** | Page size caps at 30, page number at 333. No cursor. |
| No aggregation | Facet counts only — no `AVG`, no `GROUP BY`. |
| No derived sorting | Sorts on `price`, never price-per-litre. |
| AND-only filters | No "Cabernet but not Syrah". |
| Silent failure | An unrecognised filter parameter is ignored, returning the full unfiltered set. |

A full sync takes ~25 minutes and yields a ~115 MB database. Queries return in
single-digit milliseconds.

## Two things the API knows but never tells you

**1. `otherSelections` is filterable but never returned.** A wine matched by
`otherSelections=Vegansk` has `"otherSelections": null` in its own record. Vegan,
natural-wine, gluten-free and kosher status exist in *no* API response. `sync`
materialises them with separate enrichment passes, into `is_vegan`,
`is_natural`, `is_gluten_free` and `is_kosher`.

**2. "In the catalogue" is not "on a shelf".** About 72% of wine is
`Ordervaror` — order-only. A large Stockholm store carries roughly 1,300 of
15,442 wines. The `availability` column normalises this into `stocked`,
`limited` and `order_only`, ranked by `availability_rank` (1 = easiest to buy).

Conveniently, data quality tracks availability almost exactly:

| Availability tier | products | has tasting notes |
|---|---|---|
| `stocked` | 7,330 | 99.7% |
| `limited` | 3,194 | 53.7% |
| `order_only` | 16,651 | 11.9% |

So the products you can actually buy are the ones described well enough to
reason about.

## Usage

```bash
make install                # builds and installs to ~/.local/bin

# Full pull (~25 min). Also mirror one store's assortment while you are at it.
bolagetdb sync --store 0102

# Find a store id
./bolagetdb stores --search majorna

# What is in the database, and how stale is it
./bolagetdb stats

# Ask it anything
./bolagetdb query --format json "SELECT name, price FROM product LIMIT 5"
```

`query` accepts `--format table|json|csv`. No `sqlite3` binary is required —
the driver is pure Go, so the tool is a single static binary with no cgo.

The database is located automatically: `$BOLAGETDB` if set, else `./bolaget.db`
when run inside the repo, else `~/.local/share/bolagetdb/bolaget.db`. Nothing
in the repo hardcodes a path, so a clone works unchanged on another machine —
the database itself is not committed (it is ~115 MB) and has to be built there
with `bolagetdb sync`.

## Query cookbook

Boolean search over tasting notes — impossible upstream:

```sql
SELECT p.full_name, p.vintage, p.price, p.availability
FROM product_fts f JOIN product p ON p.rowid = f.rowid
WHERE product_fts MATCH 'taste:(tobak AND körsbär) NOT taste:ek'
  AND p.availability = 'stocked'
ORDER BY p.price;
```

Best value per litre in a taste profile:

```sql
SELECT full_name, price, volume_ml, ROUND(sek_per_litre) AS sek_per_l
FROM product
WHERE cat2 = 'Rött vin' AND clock_body >= 10 AND clock_tannin >= 9
  AND availability_rank = 1
ORDER BY sek_per_litre LIMIT 10;
```

Grape logic with negation:

```sql
SELECT p.full_name, p.price, group_concat(g.grape) AS grapes
FROM product p JOIN product_grape g USING (product_id)
WHERE p.product_id IN (SELECT product_id FROM product_grape WHERE grape = 'Cabernet sauvignon')
  AND p.product_id NOT IN (SELECT product_id FROM product_grape WHERE grape = 'Syrah')
GROUP BY p.product_id HAVING p.price < 300
ORDER BY p.price;
```

Aggregate profiling:

```sql
SELECT country, count(*) AS n, ROUND(AVG(clock_tannin),1) AS tannin,
       ROUND(AVG(clock_body),1) AS body, ROUND(AVG(price)) AS avg_price
FROM product WHERE cat2 = 'Rött vin' AND clock_tannin IS NOT NULL
GROUP BY country HAVING n >= 100 ORDER BY tannin DESC;
```

What a specific store carries:

```sql
SELECT p.full_name, p.price FROM product p
JOIN store_product sp USING (product_id)
WHERE sp.site_id = '0102' AND p.cat2 = 'Rött vin'
ORDER BY p.sek_per_litre LIMIT 20;
```

## Design decisions

**Slices are discovered, not hardcoded.** The ~9,990 page ceiling means the
assortment must be fetched in parts. `sync` reads the API's own category facets
and splits only the categories that exceed the cap — currently 17 slices, since
only `Vin` needs subdividing. A new category cannot silently go missing, and a
slice that grows past the cap logs a warning rather than truncating quietly.

**Pagination is not stable, so slices are walked more than once.** The API pages
by offset over an ordering that shuffles between requests. A single walk
therefore returns some products twice and never returns others at all, and
nothing in the response says so — the row count still matches the reported
total. Measured over the full assortment:

| Sort order | Rows fetched | Distinct | Products missed |
|---|---|---|---|
| none (relevance) | 27,176 | 20,997 | **22.7%** |
| `Name` ascending | 27,176 | 26,915 | 0.96% |
| multi-pass (this tool) | — | 27,175 | **0.004%** |

The same hazard applies to the enrichment and store-assortment walks, which go
through the identical multi-pass path — a single walk lost 134 of 1,043 vegan
products.

`sync` walks each slice with an explicit sort, then walks it again from the
other direction, and keeps going through `Price` in both directions until the
distinct count reaches what the API reported for that slice. Products are
upserted by id, so extra passes only ever add coverage. A slice that still
cannot be completed logs a warning and is recorded in `sync_run.note` rather
than silently shipping a partial mirror.

**`raw` keeps the verbatim JSON.** The upstream library types products as
`map[string]any` on purpose, because Systembolaget changes fields without
notice. The typed columns are a convenience view; the original record is always
recoverable, so a schema miss never loses data.

**Grape synonyms live in a data file.** `internal/normalize/grapes.tsv` maps
`Shiraz` → `Syrah`, `Garnacha` → `Grenache` and so on. It is a versioned domain
artifact, editable without touching code. `product_grape.raw_name` always keeps
the original name, so a bad mapping is reversible. The file documents the
near-misses it deliberately does *not* merge — `Petite sirah` is Durif, not
Syrah; `Welschriesling` is not Riesling; `Pinotage` is not Pinot noir.

**Stock is never cached.** Product facts change slowly and are mirrored. Shelf
stock changes hourly and must be read live from
`sb-api-ecommerce/v1/stockbalance/store/{storeId}/{productId}` at the moment of
recommending. The mirror answers *what exists and what matches*; the live API
answers *can I buy it today*.

**Delisted products are pruned, but only after a complete run.** Upserts alone
never delete, so a discontinued wine would stay in the mirror indefinitely.
`sync` removes anything not seen during the run — but only when every slice
succeeded, since pruning after a partial fetch would delete good data. Use
`--no-prune` to keep everything.

**Snapshots are written from day one.** Each sync writes a dated JSONL file to
`snapshots/`. The one public archive of this data has only 5 snapshots in 8
years and stopped updating in November 2025, so there is no usable price
history to import — but history cannot be reconstructed after the fact, and
keeping it costs nothing.

## Skill packages

`make skill` builds a self-contained sommelier package for the Claude apps from
`skill/`: the persona and method, reference tables mapping ordinary language
onto the schema, a stdlib-only query script, and a slim snapshot. ~2 MB zipped.
Skills there run in Anthropic's sandbox and cannot reach this machine, which is
why the data has to travel with them.

```bash
make skill      # -> dist/sommelier.zip
```

The snapshot carries only products a customer can realistically buy
(`availability_rank <= 2`), which is ~10,500 of ~27,000. `bolagetdb export
--max-availability-rank 1` narrows it to shelf-stocked only (~5.6 MB).

For Claude Code, `.claude/skills/sommelier/` drives the full database directly
and is picked up automatically when running in this repo.

## Data sourcing

Fetching uses [systembolaget-api](https://github.com/AlexGustafsson/systembolaget-api)
as a library. That project handles the API-key discovery (the key is scraped
from the public frontend's JS bundles) and pagination. Filters it does not wrap
— `otherSelections` here — are added locally; `systembolaget.SearchFilter` is
just `func(*url.Values)`, so the gap closes without forking.

Please keep `--page-delay` non-zero. This is an undocumented API and an agent
will otherwise hit it far harder than any human browsing session.
