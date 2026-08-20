# Schema and query recipes

## Running queries

```bash
python3 scripts/query.py "SELECT full_name, price FROM product LIMIT 5"
python3 scripts/query.py --format json "SELECT ..."
python3 scripts/query.py --schema          # full schema + snapshot date
```

Standard library only. `--limit` caps printed rows (default 50); the query is
unchanged.

## Tables

**`product`** — one row per product.

| Group | Columns |
|---|---|
| Identity | `product_id`, `full_name`, `name`, `name_thin`, `producer`, `country`, `origin1` |
| Category | `cat1` (Vin/Öl/Sprit/Cider & blanddrycker/Alkoholfritt), `cat2` (Rött vin/Vitt vin/Ale/Whisky/…), `cat3` (style, NULL for ~62% of wine) |
| Numbers | `vintage`, `price`, `volume_ml`, `abv`, `sek_per_litre` |
| Availability | `availability` (`stocked`/`limited`), `availability_rank` (1/2) |
| Dietary | `is_organic`, `is_vegan`, `is_natural`, `is_gluten_free`, `is_kosher` |
| Taste clocks 0–12 | `clock_body`, `clock_tannin`, `clock_sweetness`, `clock_bitter`, `clock_fruitacid`, `clock_smokiness` |
| Text | `taste`, `color`, `usage`, `packaging` |

**`product_grape`** (`product_id`, `grape`, `raw_name`) — `grape` is canonical.

**`product_pairing`** (`product_id`, `pairing`) — see `preferences.md`.

**`product_fts`** — full-text over `full_name`, `producer`, `taste`, `color`,
`usage`. Join on `rowid`. Diacritics folded, so `korsbar` matches `körsbär`.

**`store`** (`site_id`, `name`, `address`, `city`, `county`) and
**`store_product`** (`site_id`, `product_id`) — the assortment of the stores
that have been mirrored. Only some stores are covered; check
`meta.stores_covered`. A product absent from `store_product` for a covered
store means that store does not carry it.

**`meta`** — snapshot provenance, including `stores_covered`.

## Recipes

### Boolean tasting-note search

Systembolaget's own site cannot do this; single-term search is all it offers.

```sql
SELECT p.full_name, p.vintage, p.price, p.availability
FROM product_fts f JOIN product p ON p.rowid = f.rowid
WHERE product_fts MATCH 'taste:(tobak AND körsbär) NOT taste:ek'
  AND p.availability_rank = 1
ORDER BY p.price;
```

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

```sql
SELECT p.full_name, p.country, p.price, p.clock_body, p.clock_tannin
FROM product p JOIN product_pairing pr USING (product_id)
WHERE pr.pairing = 'Lamm' AND p.availability_rank = 1 AND p.price < 200
ORDER BY p.clock_body DESC, p.price LIMIT 5;
```

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
WHERE p.full_name IN ('Southern Ridge Shiraz Victoria', 'Dehesa La Granja')
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

List covered stores with
`SELECT * FROM store` — anything not listed is simply not mirrored.

### Find a specific bottle

```sql
SELECT product_id, full_name, producer, vintage, price, availability
FROM product WHERE full_name LIKE '%musar%' OR producer LIKE '%musar%';
```

Check the producer before concluding you found it.

## Pitfalls

- `cat3` is NULL for ~62% of wine. Never filter on it alone.
- The same wine appears once per vintage and per bottle size. Group by `full_name` and `producer` when presenting.
- `taste` is populated for 99.7% of `stocked` products but only ~54% of `limited`. A missing note is not a missing flavour.
- Absent text is NULL, not `''`, so `taste IS NOT NULL` works.
- Compare value with `sek_per_litre`, never raw `price`.
- Tighten filters progressively. An over-constrained query returning nothing is a worse answer than a looser one returning near misses.
