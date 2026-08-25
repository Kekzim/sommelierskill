---
name: sommelier
description: Query the local Systembolaget assortment mirror (bolagetdb) to find wines, beer and spirits that are actually purchasable in Sweden. Use whenever recommending a specific drink to buy, checking whether a bottle is available, or answering questions about price, grape, taste profile, or food pairing for Swedish retail. Covers the SQL schema, availability tiers, and the live stock check.
---

# Sommelier

Systembolaget is Sweden's alcohol retail monopoly, so "can I buy this" has
exactly one answer. `bolagetdb` is a local SQL mirror of their full assortment
(~27k products), which makes taste-based discovery fast and expressive.

## The one rule

**Never recommend something without establishing how buyable it is.** About 72%
of wine in the catalogue is order-only and never sits on a shelf. A
recommendation that ignores this is worse than no recommendation.

Every query that ends in a recommendation must select `availability` and say
which tier the result is in.

| `availability` | `availability_rank` | Means |
|---|---|---|
| `stocked` | 1 | On shelves. `Fast sortiment` or `Lokalt & Småskaligt`. |
| `limited` | 2 | In stores while stocks last. |
| `order_only` | 3 | Must be ordered in; days of waiting. |

Default to `availability_rank = 1` unless the user asked for something rare.

## Running queries

```bash
bolagetdb query --format json "SELECT ..."
```

The database is found automatically: `$BOLAGETDB` if set, else `./bolaget.db`
when run inside the repo, else `~/.local/share/bolagetdb/bolaget.db`. Pass
`--db` to override.

Use `--format json` for parsing, `--format table` when showing the user. No
`sqlite3` binary is needed. If no database is found the command fails with an
error naming the path — it will never silently report an empty assortment.

If it reports no database, the mirror has not been built on this machine yet:

```bash
cd <repo> && make install && bolagetdb sync
```

Check freshness before trusting the data:

```bash
bolagetdb stats
```

## Schema

`product` — one row per product.

- Identity: `product_id`, `product_number`, `name`, `name_thin`, `full_name`, `producer`, `country`, `origin1`, `origin2`
- Category: `cat1` (Vin/Öl/Sprit/…), `cat2` (Rött vin/Ale/Whisky/…), `cat3` (style — **NULL for ~62% of wine, so never filter on it alone**)
- Numbers: `vintage`, `price`, `volume_ml`, `abv`, `sugar_g_per_100ml`
- Derived: `sek_per_litre`, `sek_per_cl_alcohol` — use these for value comparisons, never raw `price` across different bottle sizes
- Availability: `availability`, `availability_rank`, `assortment_text`, `is_discontinued`, `is_out_of_stock`
- Dietary: `is_organic`, `is_vegan`, `is_natural`, `is_gluten_free`, `is_kosher`, `is_sustainable`, `is_ethical`
- Taste clocks, 0–12: `clock_body`, `clock_tannin`, `clock_sweetness`, `clock_bitter`, `clock_fruitacid`, `clock_smokiness`, `clock_casque`
- Text: `taste`, `color`, `usage`
- `raw` — the verbatim API JSON, if a field is missing from the columns above

`product_grape` (`product_id`, `grape`, `raw_name`) — `grape` is canonical, so
querying `Syrah` also finds wines the API labelled `Shiraz`.

`product_pairing` (`product_id`, `pairing`) — food pairings such as `Nöt`,
`Fisk`, `Ost`, `Vilt`, `Sällskapsdryck`.

`product_fts` — full-text over `name`, `producer`, `taste`, `color`, `usage`.

`store` / `store_product` — store list, and the assortment of any store that has
been mirrored locally.

## Searching tasting notes

The FTS index supports real boolean logic. Join on `rowid`:

```sql
SELECT p.full_name, p.vintage, p.price, p.availability
FROM product_fts f JOIN product p ON p.rowid = f.rowid
WHERE product_fts MATCH 'taste:(tobak AND körsbär) NOT taste:ek'
  AND p.availability_rank = 1
ORDER BY p.price;
```

Notes are in **Swedish**. Useful vocabulary: `körsbär` cherry, `hallon`
raspberry, `svarta vinbär` blackcurrant, `plommon` plum, `läder` leather,
`tobak` tobacco, `choklad` chocolate, `vanilj` vanilla, `ek` oak, `kryddig`
spicy, `mineralisk` mineral, `citrus`, `smörig` buttery, `rostad` toasted.

Diacritics are folded, so `korsbar` matches `körsbär`.

## Taste clocks

0–12 integers. `clock_tannin` is Systembolaget's *strävhet*. They are populated
for essentially every shelf-stocked product, and mostly absent for order-only
ones — another reason to filter on availability first.

Rough guide for red wine: `clock_body` 1–4 light, 5–8 medium, 9–12 full.
`clock_tannin` 1–3 soft, 4–7 moderate, 8–12 grippy.

## Confirming availability before recommending

The mirror knows what exists; it does **not** know today's shelf count. For the
final shortlist only, check live stock:

```bash
curl -s "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/stockbalance/store/<siteId>/<productId>/" \
  -H "Origin: https://www.systembolaget.se" -H "Accept: application/json" \
  -H "Ocp-Apim-Subscription-Key: <key>"
```

Returns `stock` and `shelf` (the physical shelf position — worth passing on).
Find store ids with `bolagetdb stores --search <town>`.

Never cache stock. Never check it for more than the handful of candidates you
are about to name.

## Working with web research

Research enriches; the database decides. Prefer to **filter first, research
second** — start from what is buyable and matches the taste brief, then look up
reviews and background on the survivors. Researching first mostly produces
well-informed disappointments, because the Swedish monopoly carries a small
slice of the world's wine.

When the user names a specific bottle, search locally by name and confirm the
producer matches. Fuzzy name matching is unreliable in both directions — a
search for `Sassicaia` upstream returns `Grappa Sassicaia` and an unrelated
`Sassaia di Albereto` ahead of the real wine. Always check `producer` and
`full_name` before concluding you found it.

## Pitfalls

- `cat3` (style) is NULL for ~62% of wine, and ~76% of red wine. Filtering on it silently drops most of a category.
- `taste` is populated for 99.7% of `stocked` products, 54% of `limited` and only 12% of `order_only`. A missing `taste` usually means "not stocked", not "no flavour".
- Absent text fields are stored as NULL, not `''`, so `taste IS NOT NULL` is a valid filter.
- Compare value with `sek_per_litre`, not `price` — volumes range from 60 ml to 30 litres.
- The same wine appears as separate rows per vintage and per bottle size. Group by name and producer when presenting.
- `is_vegan`, `is_natural`, `is_gluten_free` and `is_kosher` come from enrichment passes. After a normal sync they are 0 or 1; `NULL` would mean enrichment was skipped, i.e. unknown rather than false.
