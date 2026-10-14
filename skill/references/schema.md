# Schema and query recipes

For questions the purpose-built tools do not cover: counting, grouping,
correlating, boolean tasting-note search. Pass the SQL to
`systembolaget_query`, one `SELECT` (or `WITH … SELECT`) per call. It is
read-only, and a query without its own `LIMIT` is capped at 500 rows.

For ordinary recommendation work, use the purpose-built tools instead: they
apply the availability rules and paging for you. `systembolaget_search_products`
is the workhorse, `systembolaget_find_similar` does "like that, but cheaper",
`systembolaget_upcoming_releases` covers the coming drops, and
`systembolaget_check_stock` gives live shelf stock.

## Tables

**`product`**: one row per product, the full assortment of about 27,000.

| Group | Columns |
|---|---|
| Identity | `product_id`, `product_number`, `full_name`, `name`, `name_thin`, `producer`, `country`, `origin1`, `origin2` |
| Category | `cat1` (Vin/Öl/Sprit/Cider & blanddrycker/Alkoholfritt), `cat2` (Rött vin/Vitt vin/Ale/Whisky/…), `cat3` (style, NULL for ~62% of wine) |
| Numbers | `vintage`, `price`, `volume_ml`, `abv`, `sek_per_litre` |
| Availability | `availability` (`stocked`/`limited`/`order_only`), `availability_rank` (1/2/3) |
| Assortment code | `assortment_code` is sharper than the display label: `TSE` and `TSV` both show as "Tillfälligt sortiment", `TSS` is "Säsong", `TSLS` is "Lokalt & Småskaligt", `FS`/`FSN`/`FSB` are "Fast sortiment" |
| Release | `launch_date` (often in the **future**), `sell_start_time` (usually `10:00:00`), `is_news`, `is_web_launch` |
| Dietary | `is_organic`, `is_vegan`, `is_natural`, `is_gluten_free`, `is_kosher` (NULL means unknown, not no) |
| Taste clocks 0–12 | `clock_body`, `clock_tannin`, `clock_sweetness`, `clock_bitter`, `clock_fruitacid`, `clock_smokiness` |
| Text | `taste`, `color`, `usage`, `packaging` |

About 72% of wine is `order_only`: orderable, but not on any shelf. Filter on
`availability_rank = 1` for what someone can walk in and buy, and widen to 2 or
3 only when they want something unusual and can wait.

**`product_grape`** (`product_id`, `grape`, `raw_name`): `grape` is canonical,
so `Syrah` also finds wines labelled `Shiraz`.

**`product_pairing`** (`product_id`, `pairing`): see `preferences.md`.

**`product_fts`**: full-text over `full_name`, `producer`, `taste`, `color`,
`usage`. Join on `rowid`. Diacritics are folded, so `korsbar` matches `körsbär`.

**`store`** (`site_id`, `name`, `city`, `county`) and **`store_product`**
(`site_id`, `product_id`): the assortment of the stores that are mirrored.
`systembolaget_data_freshness` lists them, along with the last sync. A store not
listed is simply not mirrored, which says nothing about what it carries.

For a mirrored store, a product absent from `store_product` is usually one that
store does not carry, **unless it launched after the last sync**. The
assortment was recorded before that bottle reached any shop. Compare
`launch_date` with the last sync from `systembolaget_data_freshness`, and use
`systembolaget_check_stock` for the live answer.

## Recipes

### Boolean tasting-note search

Systembolaget's own site cannot do this; it offers single-term search only.

```sql
SELECT p.full_name, p.vintage, p.price, p.availability
FROM product_fts f JOIN product p ON p.rowid = f.rowid
WHERE product_fts MATCH 'taste:(tobak AND körsbär) NOT taste:ek'
  AND p.availability_rank = 1
ORDER BY p.price;
```

### Food pairing

**Pairings are assigned across every category, not just wine.** Without a
category filter, `pairing = 'Lamm'` ordered by body returns a barrel-aged maple
stout ahead of any wine. Constrain `cat1`/`cat2` to what they actually asked
for.

```sql
SELECT p.full_name, p.country, p.price, p.clock_body, p.clock_tannin
FROM product p JOIN product_pairing pr USING (product_id)
WHERE pr.pairing = 'Lamm' AND p.cat2 = 'Rött vin'
  AND p.availability_rank = 1 AND p.price < 200
ORDER BY p.clock_body DESC, p.price LIMIT 5;
```

Drop the `cat2` line deliberately when they are open to anything.

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

### Does a mirrored store carry these?

```sql
SELECT p.full_name, p.price,
       MAX(CASE WHEN sp.site_id = '1001' THEN 1 ELSE 0 END) AS store_1001,
       MAX(CASE WHEN sp.site_id = '1002' THEN 1 ELSE 0 END) AS store_1002
FROM product p
LEFT JOIN store_product sp ON sp.product_id = p.product_id
WHERE p.full_name IN ('Southern Ridge Shiraz Victoria', 'Dehesa La Granja')
GROUP BY p.product_id;
```

For filtering a recommendation to one store, `systembolaget_search_products`
with `store_id` does the same without SQL.

### Find a specific bottle

```sql
SELECT product_id, full_name, producer, vintage, price, availability
FROM product WHERE full_name LIKE '%musar%' OR producer LIKE '%musar%';
```

Check the producer before concluding you found it.

## Pitfalls

- `cat3` is NULL for ~62% of wine. Never filter on it alone.
- The same wine appears once per vintage and per bottle size. Group by `full_name` and `producer` when presenting.
- `taste` is populated for 99.7% of `stocked` products, ~54% of `limited` and ~12% of `order_only`. A missing note is not a missing flavour.
- **An unrated product has all its taste clocks at 0**, not NULL. A filter like `clock_tannin <= 2` therefore also matches every unrated wine. When filtering on clocks, add `clock_body > 0`, since a real rating always has a body of at least 1.
- Absent text is NULL, not `''`, so `taste IS NOT NULL` works.
- Compare value with `sek_per_litre`, never raw `price`.
- Tighten filters progressively. An over-constrained query returning nothing is a worse answer than a looser one returning near misses.
