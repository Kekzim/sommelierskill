-- bolagetdb schema
--
-- Design notes:
--  * `raw` holds the untouched API JSON. Systembolaget changes fields without
--    notice; the typed columns are a convenience view over data we still keep
--    verbatim, so a schema miss never loses information.
--  * Derived columns (sek_per_litre, sek_per_cl_alcohol) are STORED generated
--    columns so they can never drift out of sync with their inputs.
--  * `otherSelections` (vegan/natural/gluten-free/kosher) is filterable upstream
--    but never returned in a product record, so those flags are materialised by
--    separate enrichment passes. See internal/fetch.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product (
  product_id            TEXT PRIMARY KEY,
  product_number        TEXT,
  name                  TEXT NOT NULL,      -- productNameBold
  name_thin             TEXT,               -- productNameThin
  full_name             TEXT,               -- name + name_thin, for display
  producer              TEXT,
  supplier              TEXT,

  country               TEXT,
  origin1               TEXT,
  origin2               TEXT,

  cat1                  TEXT,               -- Vin / Öl / Sprit / ...
  cat2                  TEXT,               -- Rött vin / Ale / Whisky / ...
  cat3                  TEXT,               -- style; NULL for ~76% of wine
  category_title        TEXT,

  vintage               INTEGER,
  price                 REAL,
  volume_ml             REAL,
  abv                   REAL,
  sugar_g_per_100ml     REAL,

  -- Derived. Guarded against zero volume / zero abv.
  sek_per_litre         REAL GENERATED ALWAYS AS (
                          CASE WHEN volume_ml > 0 THEN price / (volume_ml / 1000.0) END
                        ) STORED,
  sek_per_cl_alcohol    REAL GENERATED ALWAYS AS (
                          CASE WHEN volume_ml > 0 AND abv > 0
                               THEN price / (volume_ml * abv / 100.0 / 10.0) END
                        ) STORED,

  -- Availability. assortment_text is verbatim; availability/_rank are normalised.
  assortment_text       TEXT,
  availability          TEXT,               -- stocked | limited | order_only
  availability_rank     INTEGER,            -- 1 = easiest to actually buy
  is_discontinued       INTEGER NOT NULL DEFAULT 0,
  is_out_of_stock       INTEGER NOT NULL DEFAULT 0,

  -- Dietary / ethical. vegan..natural come from enrichment passes, not the record.
  is_organic            INTEGER NOT NULL DEFAULT 0,
  is_sustainable        INTEGER NOT NULL DEFAULT 0,
  is_ethical            INTEGER NOT NULL DEFAULT 0,
  ethical_label         TEXT,
  is_vegan              INTEGER,            -- NULL = not yet enriched
  is_natural            INTEGER,
  is_gluten_free        INTEGER,
  is_kosher             INTEGER,

  packaging             TEXT,
  seal                  TEXT,
  co2_impact            TEXT,

  -- Taste clocks, 0-12. Populated for essentially all shelf-stocked products.
  clock_body            INTEGER,
  clock_tannin          INTEGER,            -- tasteClockRoughness
  clock_sweetness       INTEGER,
  clock_bitter          INTEGER,
  clock_fruitacid       INTEGER,
  clock_smokiness       INTEGER,
  clock_casque          INTEGER,
  casque_text           TEXT,

  taste                 TEXT,
  color                 TEXT,
  usage                 TEXT,

  -- Release scheduling. Limited products are listed on a weekly Thu/Fri cadence
  -- and pre-announced, so launch_date is frequently in the future -- that is
  -- what makes "what drops on Friday" answerable at all. sell_start_time is the
  -- time of day sales open. assortment_code is the short code (FS, TSE, TSS,
  -- TST, TSV) behind assortment_text.
  launch_date           TEXT,
  sell_start_time       TEXT,
  is_news               INTEGER NOT NULL DEFAULT 0,
  -- Web launches ("Webblanseringar") are allocation drops applied for online,
  -- not bottles to queue for in a shop. Their assortment_text is unknown to the
  -- availability map, so they fall back to order_only -- correct, but it hides
  -- that they are the most sought-after releases.
  is_web_launch         INTEGER NOT NULL DEFAULT 0,
  assortment_code       TEXT,

  raw                   TEXT NOT NULL,      -- verbatim API JSON
  synced_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_cat        ON product(cat1, cat2, cat3);
CREATE INDEX IF NOT EXISTS idx_product_avail      ON product(availability_rank, price);
CREATE INDEX IF NOT EXISTS idx_product_price      ON product(price);
CREATE INDEX IF NOT EXISTS idx_product_sekl       ON product(sek_per_litre);
CREATE INDEX IF NOT EXISTS idx_product_country    ON product(country);
CREATE INDEX IF NOT EXISTS idx_product_producer   ON product(producer);
CREATE INDEX IF NOT EXISTS idx_product_clocks     ON product(clock_body, clock_tannin, clock_sweetness);
-- Upcoming releases are queried as a date window over the limited assortment.
CREATE INDEX IF NOT EXISTS idx_product_launch     ON product(launch_date, availability_rank);

-- Grapes, normalised to a canonical name. `raw_name` keeps what the API said so
-- a bad synonym mapping is always recoverable.
CREATE TABLE IF NOT EXISTS product_grape (
  product_id  TEXT NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  grape       TEXT NOT NULL,                -- canonical
  raw_name    TEXT NOT NULL,
  PRIMARY KEY (product_id, grape)
);
CREATE INDEX IF NOT EXISTS idx_grape ON product_grape(grape);

-- Food pairings (tasteSymbols).
CREATE TABLE IF NOT EXISTS product_pairing (
  product_id  TEXT NOT NULL REFERENCES product(product_id) ON DELETE CASCADE,
  pairing     TEXT NOT NULL,
  PRIMARY KEY (product_id, pairing)
);
CREATE INDEX IF NOT EXISTS idx_pairing ON product_pairing(pairing);

-- Full-text over the descriptive fields. remove_diacritics 2 so an agent can
-- write "korsbar" and still match "körsbär".
CREATE VIRTUAL TABLE IF NOT EXISTS product_fts USING fts5(
  name, producer, taste, color, usage,
  content='product', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS product_ai AFTER INSERT ON product BEGIN
  INSERT INTO product_fts(rowid, name, producer, taste, color, usage)
  VALUES (new.rowid, new.name, new.producer, new.taste, new.color, new.usage);
END;
CREATE TRIGGER IF NOT EXISTS product_ad AFTER DELETE ON product BEGIN
  INSERT INTO product_fts(product_fts, rowid, name, producer, taste, color, usage)
  VALUES ('delete', old.rowid, old.name, old.producer, old.taste, old.color, old.usage);
END;
CREATE TRIGGER IF NOT EXISTS product_au AFTER UPDATE ON product BEGIN
  INSERT INTO product_fts(product_fts, rowid, name, producer, taste, color, usage)
  VALUES ('delete', old.rowid, old.name, old.producer, old.taste, old.color, old.usage);
  INSERT INTO product_fts(rowid, name, producer, taste, color, usage)
  VALUES (new.rowid, new.name, new.producer, new.taste, new.color, new.usage);
END;

CREATE TABLE IF NOT EXISTS store (
  site_id     TEXT PRIMARY KEY,
  name        TEXT,
  address     TEXT,
  city        TEXT,
  county      TEXT,
  is_agent    INTEGER,
  raw         TEXT NOT NULL,
  synced_at   TEXT NOT NULL
);

-- Optional: assortment of one or more "home" stores. Full national per-store
-- mirroring is ~450 stores x ~50 pages and not worth it; a couple of local
-- stores is ~15s each.
CREATE TABLE IF NOT EXISTS store_product (
  site_id     TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (site_id, product_id)
);

-- One row per sync, so staleness is always answerable from inside the db.
CREATE TABLE IF NOT EXISTS sync_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  products      INTEGER,
  slices        INTEGER,
  errors        INTEGER,
  snapshot_path TEXT,
  note          TEXT
);
