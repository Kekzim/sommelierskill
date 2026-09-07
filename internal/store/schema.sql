-- bolagetdb schema
--
-- Design notes:
--  * The product table is generated from columns.go -- see the note below.
--  * Indexes, triggers and the FTS table live here because they have a single
--    definition and nothing else has to agree with them.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- The `product` table itself is NOT here. Its columns are declared once in
-- columns.go and the CREATE TABLE is generated from that list, along with the
-- upsert and the snapshot schema, so those four cannot drift apart. Open()
-- creates it before running this file; the indexes below therefore always find
-- their columns. Everything that has only one definition stays here.

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
