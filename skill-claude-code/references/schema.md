# Schema, query mechanics and recipes

Two things use this file, and neither is the common path:

1. **The `systembolaget_query` MCP tool**, for questions the purpose-built tools
   do not cover — counting, grouping, correlating. The schema below is what that
   tool queries; the recipes are worked examples.
2. **The `bolagetdb` fallback**, when the MCP tools are not configured or the
   server is unreachable.

For ordinary recommendation work, use the tools in `tools.md` instead. They
apply the availability rules and the pagination for you.

## Running queries

```bash
bolagetdb query "SELECT full_name, price FROM product LIMIT 5"
bolagetdb query --format json "SELECT ..."
bolagetdb stats                      # contents + staleness
```

**Never run `bolagetdb` against a database the MCP server is serving.** Opening
it converts the file to WAL mode, and the server reads it from a read-only
mount, where a WAL database cannot be opened at all. That applies to a plain
`SELECT 1`. The fallback path is for the local mirror on this machine, which is
a different file from the one the server publishes.

Use `--format json` for parsing, `--format table` when showing the user. The
database is found automatically: `$BOLAGETDB` if set, else `./bolaget.db` when
run inside the repo, else `~/.local/share/bolagetdb/bolaget.db`. Pass `--db` to
override. No `sqlite3` binary is needed.

If no database is found the command fails with an error naming the path — it
will never silently report an empty assortment. That means the mirror has not
been built on this machine yet:

```bash
make install && bolagetdb sync --store 1001 --store 1002 && bolagetdb stores
```

## Tables

`product` — one row per product.

- Identity: `product_id`, `product_number`, `name`, `name_thin`, `full_name`, `producer`, `country`, `origin1`, `origin2`
- Category: `cat1` (Vin/Öl/Sprit/…), `cat2` (Rött vin/Ale/Whisky/…), `cat3` (style — **NULL for ~62% of wine, so never filter on it alone**)
- Numbers: `vintage`, `price`, `volume_ml`, `abv`, `sugar_g_per_100ml`
- Derived: `sek_per_litre`, `sek_per_cl_alcohol` — use these for value comparisons, never raw `price` across different bottle sizes
- Availability: `availability`, `availability_rank`, `assortment_text`, `is_discontinued`, `is_out_of_stock`
- Assortment code: `assortment_code` — sharper than `assortment_text`, which collapses distinctions: `TSE` and `TSV` both display as "Tillfälligt sortiment", `TSS` is "Säsong", `TSLS` is "Lokalt & Småskaligt", `FS`/`FSN`/`FSB` are all "Fast sortiment", `BS` is order-only
- Release: `launch_date` (often in the **future** — releases are pre-announced), `sell_start_time` (usually `10:00:00`), `is_news`, `is_web_launch` (allocation drops applied for online, not shop releases; these read as `order_only` because their assortment text is not a shelf tier)
- Dietary: `is_organic`, `is_vegan`, `is_natural`, `is_gluten_free`, `is_kosher`, `is_sustainable`, `is_ethical`
- Taste clocks, 0–12: `clock_body`, `clock_tannin`, `clock_sweetness`, `clock_bitter`, `clock_fruitacid`, `clock_smokiness`, `clock_casque`
- Text: `taste`, `color`, `usage`
- `raw` — the verbatim API JSON, if a field is missing from the columns above

`product_grape` (`product_id`, `grape`, `raw_name`) — `grape` is canonical, so
querying `Syrah` also finds wines the API labelled `Shiraz`.

`product_pairing` (`product_id`, `pairing`) — food pairings such as `Nöt`,
`Fisk`, `Ost`, `Vilt`, `Sällskapsdryck`.

`product_fts` — full-text over `name`, `producer`, `taste`, `color`, `usage`.

`store` (`site_id`, `name`, `city`, …) — every Systembolaget store.
`store_product` (`site_id`, `product_id`) — the assortment of the stores that
have actually been mirrored, which is a much shorter list. Mirrored stores are
`SELECT DISTINCT site_id FROM store_product`; a store present in `store` but
absent there is simply not mirrored, not empty.

It is also a snapshot in time. A product whose `launch_date` is later than the
last sync cannot appear here — it did not exist in any shop when the assortment
was walked — so its absence says nothing about whether the store carries it.
Check before answering:

```sql
SELECT p.full_name, p.launch_date,
       (SELECT max(finished_at) FROM sync_run WHERE finished_at IS NOT NULL) AS last_sync,
       EXISTS (SELECT 1 FROM store_product sp
               WHERE sp.product_id = p.product_id AND sp.site_id = '1002') AS at_store
FROM product p WHERE p.product_id = '<id>'
```

If `launch_date` is after `last_sync`, `at_store = 0` is uninformative: say the
mirror predates the release and check live stock instead.

## Taste clocks

0–12 integers. `clock_tannin` is Systembolaget's *strävhet*. They are populated
for essentially every shelf-stocked product, and mostly absent for order-only
ones — another reason to filter on availability first.

Rough guide for red wine: `clock_body` 1–4 light, 5–8 medium, 9–12 full.
`clock_tannin` 1–3 soft, 4–7 moderate, 8–12 grippy.

See `preferences.md` for the full mapping from ordinary language onto these.

## Searching tasting notes

The FTS index supports real boolean logic, which Systembolaget's own site
cannot do — single-term search is all it offers. Join on `rowid`:

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

## Recipes

### Find something similar to a wine they liked

Match on taste-clock distance, prefer shared grapes. Given a Barolo this
returns Langhe Nebbiolo and Barbaresco.

```sql
WITH ref AS (
  SELECT * FROM product WHERE full_name LIKE '%Barolo%' AND availability_rank = 1
  ORDER BY price LIMIT 1
),
refg AS (SELECT grape FROM product_grape WHERE product_id = (SELECT product_id FROM ref))
SELECT p.full_name, p.producer, p.price,
       ABS(p.clock_body - ref.clock_body) + ABS(p.clock_tannin - ref.clock_tannin)
     + ABS(p.clock_sweetness - ref.clock_sweetness) + ABS(p.clock_fruitacid - ref.clock_fruitacid) AS dist,
       (SELECT count(*) FROM product_grape g
        WHERE g.product_id = p.product_id AND g.grape IN (SELECT grape FROM refg)) AS shared_grapes
FROM product p, ref
WHERE p.cat2 = ref.cat2 AND p.product_id <> ref.product_id
  AND p.availability_rank = 1 AND p.price < ref.price
ORDER BY shared_grapes DESC, dist, p.price
LIMIT 6;
```

Confirm the reference wine is the one they meant before trusting the result.

### Food pairing

**Pairings are assigned across every category, not just wine.** Without a
category filter, `pairing = 'Lamm'` ordered by body returns a barrel-aged maple
stout ahead of any wine — verified, not hypothetical. Constrain `cat1`/`cat2`
to what they actually asked for.

```sql
SELECT p.full_name, p.country, p.price, p.clock_body, p.clock_tannin
FROM product p JOIN product_pairing pr USING (product_id)
WHERE pr.pairing = 'Lamm' AND p.cat2 = 'Rött vin'
  AND p.availability_rank = 1 AND p.price < 200
ORDER BY p.clock_body DESC, p.price LIMIT 5;
```

Drop the `cat2` line deliberately when they are open to anything — a stout with
lamb is a real suggestion, just not the one someone asking for wine wants.

### Best value in a taste profile

```sql
SELECT full_name, price, volume_ml, ROUND(sek_per_litre) AS sek_per_l
FROM product
WHERE cat2 = 'Rött vin' AND clock_body >= 9 AND clock_tannin >= 8
  AND availability_rank = 1
ORDER BY sek_per_litre LIMIT 10;
```

### Grape logic with negation

```sql
SELECT p.full_name, p.price
FROM product p
WHERE p.product_id IN (SELECT product_id FROM product_grape WHERE grape = 'Cabernet sauvignon')
  AND p.product_id NOT IN (SELECT product_id FROM product_grape WHERE grape = 'Syrah')
  AND p.availability_rank = 1 AND p.price < 300
ORDER BY p.price LIMIT 10;
```

### Does a specific store carry these?

```sql
SELECT p.full_name, p.price,
       MAX(CASE WHEN sp.site_id = '1001' THEN 1 ELSE 0 END) AS wachtmeister,
       MAX(CASE WHEN sp.site_id = '1002' THEN 1 ELSE 0 END) AS amiralen
FROM product p
LEFT JOIN store_product sp ON sp.product_id = p.product_id
WHERE p.full_name IN ('Barone Montalto Passivento', 'A Modo Mio Montepulciano d''Abruzzo Umani Ronchi')
GROUP BY p.product_id;
```

Or filter a recommendation to one store from the start:

```sql
SELECT p.full_name, p.country, p.price
FROM product p
JOIN store_product sp USING (product_id)
JOIN product_pairing pr USING (product_id)
WHERE sp.site_id = '1001' AND pr.pairing = 'Vilt' AND p.availability_rank = 1
ORDER BY p.clock_body DESC, p.price LIMIT 5;
```

### What is being released in a date window

```sql
SELECT substr(launch_date,1,10) AS launch, sell_start_time, assortment_code,
       is_web_launch, full_name, producer, price
FROM product
WHERE substr(launch_date,1,10) BETWEEN '2026-09-01' AND '2026-09-16'
  AND assortment_code LIKE 'TS%'
ORDER BY launch, price DESC;
```

`launch_date` is a full timestamp, so compare on the date prefix. Filter
`is_web_launch = 0` for what can actually be bought over a counter.

### Find a specific bottle

```sql
SELECT product_id, full_name, producer, vintage, price, availability
FROM product WHERE full_name LIKE '%musar%' OR producer LIKE '%musar%';
```

Check the producer before concluding you found it.

## The live stock check

The mirror knows what exists; it does **not** know today's shelf count. For the
final shortlist only:

```bash
curl -s "https://api-extern.systembolaget.se/sb-api-ecommerce/v1/stockbalance/store/<siteId>/<productId>/" \
  -H "Origin: https://www.systembolaget.se" -H "Accept: application/json" \
  -H "Ocp-Apim-Subscription-Key: <key>"
```

Returns `stock` and `shelf` (the physical shelf position — worth passing on).
Find store ids with `bolagetdb stores --search <town>`, or from the `store`
table.

Never cache stock. Never check it for more than the handful of candidates you
are about to name.

## Pitfalls

- `cat3` is NULL for ~62% of wine, and ~76% of red wine. Never filter on it alone.
- The same wine appears once per vintage and per bottle size. Group by `full_name` and `producer` when presenting.
- `taste` is populated for 99.7% of `stocked` products, 54% of `limited` and only 12% of `order_only`. A missing note is not a missing flavour.
- Absent text is NULL, not `''`, so `taste IS NOT NULL` works.
- Compare value with `sek_per_litre`, never raw `price` — volumes range from 60 ml to 30 litres.
- `is_vegan`, `is_natural`, `is_gluten_free` and `is_kosher` come from enrichment passes. After a normal sync they are 0 or 1; `NULL` means enrichment was skipped, i.e. unknown rather than false.
- Tighten filters progressively. An over-constrained query returning nothing is a worse answer than a looser one returning near misses.
