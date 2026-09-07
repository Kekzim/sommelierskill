// Package store owns the SQLite database: schema, upserts and queries.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
	"github.com/ejonsvn/bolagetdb/internal/normalize"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

type DB struct{ db *sql.DB }

// OpenExisting opens a database read-only, for the commands that only read it:
// query, stats and export.
//
// It must not call Open. Open sets journal_mode=WAL in its DSN, which rewrites
// the header of whatever it touches -- so a read command against a published
// database used to convert it to WAL, and the MCP server reads that file from a
// read-only mount where a WAL database cannot be opened at all. `query
// "SELECT 1"` was enough to take the server down until the next publish.
//
// So this path opens read-only and applies no pragmas beyond a busy timeout, no
// migration and no schema. VACUUM INTO still works on a read-only connection,
// which the publish step depends on.
//
// It also refuses to create a database. Open would happily make an empty one,
// turning a wrong --db path into "0 products" instead of an error.
func OpenExisting(path string) (*DB, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no database at %s; run `bolagetdb sync` first, or set --db / $BOLAGETDB", path)
		}
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(10000)")
	if err != nil {
		return nil, err
	}
	// Fail here rather than at the first query, so an unreadable file is
	// reported by the command that opened it.
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("opening %s read-only: %w", path, err)
	}
	return &DB{db: db}, nil
}

// Open opens (creating if needed) the database at path and applies the schema.
// Only the commands that build the mirror use it: sync and stores. Read
// commands use OpenExisting -- that distinction is load-bearing, not tidiness.
func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// Order is load-bearing. The product table is created first so that a fresh
	// database already has every column; migration then adds whatever an older
	// one is missing; only then does schema.sql run, because it builds indexes
	// over columns migration is responsible for adding and would otherwise fail
	// on a missing column before the fix could be applied.
	if _, err := db.Exec(createProductTable); err != nil {
		db.Close()
		return nil, fmt.Errorf("creating product table: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrating schema: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("applying schema: %w", err)
	}
	return &DB{db: db}, nil
}

func (d *DB) Close() error { return d.db.Close() }

// SQL exposes the underlying handle for ad-hoc queries.
func (d *DB) SQL() *sql.DB { return d.db }

// Writer batches product upserts inside a single transaction.
type Writer struct {
	tx       *sql.Tx
	product  *sql.Stmt
	delGrape *sql.Stmt
	insGrape *sql.Stmt
	delPair  *sql.Stmt
	insPair  *sql.Stmt
}

func (d *DB) NewWriter() (*Writer, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return nil, err
	}
	w := &Writer{tx: tx}
	prep := func(q string) *sql.Stmt {
		if err != nil {
			return nil
		}
		var s *sql.Stmt
		s, err = tx.Prepare(q)
		return s
	}
	w.product = prep(upsertProduct)
	w.delGrape = prep(`DELETE FROM product_grape WHERE product_id = ?`)
	w.insGrape = prep(`INSERT OR REPLACE INTO product_grape (product_id, grape, raw_name) VALUES (?,?,?)`)
	w.delPair = prep(`DELETE FROM product_pairing WHERE product_id = ?`)
	w.insPair = prep(`INSERT OR REPLACE INTO product_pairing (product_id, pairing) VALUES (?,?)`)
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return w, nil
}

// nullIfEmpty maps an empty string to a SQL NULL.
//
// normalize returns "" for any field the API omitted, and storing that verbatim
// makes `WHERE taste IS NOT NULL` match every row — a wrong answer with no
// error. Optional text columns go through here so "absent" is representable.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (w *Writer) Put(p normalize.Product) error {
	if _, err := w.product.Exec(productArgs(p)...); err != nil {
		return fmt.Errorf("upsert product %s: %w", p.ProductID, err)
	}

	// Replace child rows wholesale; a product's grape list can shrink.
	if _, err := w.delGrape.Exec(p.ProductID); err != nil {
		return err
	}
	for _, g := range p.Grapes {
		if _, err := w.insGrape.Exec(p.ProductID, g.Canonical, g.Raw); err != nil {
			return err
		}
	}
	if _, err := w.delPair.Exec(p.ProductID); err != nil {
		return err
	}
	for _, s := range p.Pairings {
		if _, err := w.insPair.Exec(p.ProductID, s); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) Commit() error   { return w.tx.Commit() }
func (w *Writer) Rollback() error { return w.tx.Rollback() }

// SetFlag materialises one of the otherSelections attributes. These are
// filterable upstream but never present in a product record, so they can only
// be learned by asking which products match the filter.
func (d *DB) SetFlag(column string, ids []string) error {
	switch column {
	case "is_vegan", "is_natural", "is_gluten_free", "is_kosher":
	default:
		return fmt.Errorf("refusing to set unknown flag column %q", column)
	}
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Default the whole corpus to false, then mark the matches true, so a
	// product that loses the attribute upstream also loses it here.
	if _, err := tx.Exec(`UPDATE product SET ` + column + ` = 0`); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`UPDATE product SET ` + column + ` = 1 WHERE product_id = ?`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := stmt.Exec(id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) StartRun(started time.Time, snapshot string) (int64, error) {
	res, err := d.db.Exec(`INSERT INTO sync_run (started_at, snapshot_path) VALUES (?,?)`,
		started.UTC().Format(time.RFC3339), snapshot)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (d *DB) FinishRun(id int64, products, slices, errs int, note string) error {
	_, err := d.db.Exec(
		`UPDATE sync_run SET finished_at=?, products=?, slices=?, errors=?, note=? WHERE id=?`,
		time.Now().UTC().Format(time.RFC3339), products, slices, errs, note, id)
	return err
}

// Optimize rebuilds FTS and reclaims space. Worth running after a full sync.
func (d *DB) Optimize() error {
	for _, q := range []string{
		`INSERT INTO product_fts(product_fts) VALUES ('optimize')`,
		`ANALYZE`,
		`VACUUM`,
	} {
		if _, err := d.db.Exec(q); err != nil {
			return fmt.Errorf("%s: %w", q, err)
		}
	}
	return nil
}

// SetStoreAssortment replaces the recorded assortment for one store.
func (d *DB) SetStoreAssortment(siteID string, productIDs []string, syncedAt time.Time) error {
	ts := syncedAt.UTC().Format(time.RFC3339)
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM store_product WHERE site_id = ?`, siteID); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO store_product (site_id, product_id, synced_at) VALUES (?,?,?)`)
	if err != nil {
		return err
	}
	for _, id := range productIDs {
		if _, err := stmt.Exec(siteID, id, ts); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PutStores replaces the store list.
func (d *DB) PutStores(stores []systembolaget.Store, syncedAt time.Time) (int, error) {
	ts := syncedAt.UTC().Format(time.RFC3339)
	tx, err := d.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(`
		INSERT INTO store (site_id, name, address, city, county, is_agent, raw, synced_at)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(site_id) DO UPDATE SET
		  name=excluded.name, address=excluded.address, city=excluded.city,
		  county=excluded.county, is_agent=excluded.is_agent,
		  raw=excluded.raw, synced_at=excluded.synced_at`)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, s := range stores {
		raw, err := json.Marshal(s)
		if err != nil {
			return n, err
		}
		if _, err := stmt.Exec(s.SiteID, s.DisplayName, s.StreetAddress, s.City, s.County,
			s.IsAgent, string(raw), ts); err != nil {
			return n, err
		}
		n++
	}
	return n, tx.Commit()
}

// Stats writes a human-readable summary, including how stale the data is.
func (d *DB) Stats(ctx context.Context, w io.Writer) error {
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	defer tw.Flush()

	var products, stores, grapes int
	var lastSync sql.NullString
	d.db.QueryRowContext(ctx, `SELECT count(*) FROM product`).Scan(&products)
	d.db.QueryRowContext(ctx, `SELECT count(*) FROM store`).Scan(&stores)
	d.db.QueryRowContext(ctx, `SELECT count(DISTINCT grape) FROM product_grape`).Scan(&grapes)
	d.db.QueryRowContext(ctx, `SELECT max(finished_at) FROM sync_run WHERE finished_at IS NOT NULL`).Scan(&lastSync)

	fmt.Fprintf(tw, "products\t%d\n", products)
	fmt.Fprintf(tw, "stores\t%d\n", stores)
	fmt.Fprintf(tw, "distinct grapes\t%d\n", grapes)

	if lastSync.Valid {
		age := "unknown"
		if t, err := time.Parse(time.RFC3339, lastSync.String); err == nil {
			age = time.Since(t).Round(time.Minute).String() + " ago"
		}
		fmt.Fprintf(tw, "last sync\t%s (%s)\n", lastSync.String, age)
	} else {
		fmt.Fprintf(tw, "last sync\tnever\n")
	}

	fmt.Fprintln(tw, "\nBY CATEGORY\tPRODUCTS\tSTOCKED\tORDER ONLY")
	rows, err := d.db.QueryContext(ctx, `
		SELECT cat1, count(*),
		       sum(availability = 'stocked'),
		       sum(availability = 'order_only')
		FROM product GROUP BY cat1 ORDER BY 2 DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cat sql.NullString
		var n, stocked, orderOnly int
		if err := rows.Scan(&cat, &n, &stocked, &orderOnly); err != nil {
			return err
		}
		fmt.Fprintf(tw, "%s\t%d\t%d\t%d\n", cat.String, n, stocked, orderOnly)
	}
	return rows.Err()
}

// exportSchema is the shape of the portable snapshot. The product table comes
// from productColumns, so a column marked `slim` reaches the snapshot without
// anyone remembering to add it here -- which is exactly what went wrong with
// launch_date. The rest is literal: these tables have no second definition to
// drift from.
var exportSchema = slimProductTable + `
CREATE TABLE product_grape (product_id TEXT, grape TEXT, raw_name TEXT);
CREATE TABLE product_pairing (product_id TEXT, pairing TEXT);
CREATE TABLE store (site_id TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT, county TEXT);
CREATE TABLE store_product (site_id TEXT, product_id TEXT, PRIMARY KEY (site_id, product_id));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX idx_x_cat ON product(cat1, cat2);
CREATE INDEX idx_x_avail ON product(availability_rank, price);
CREATE INDEX idx_x_launch ON product(launch_date, availability_rank);
CREATE INDEX idx_x_grape ON product_grape(grape);
CREATE INDEX idx_x_pairing ON product_pairing(pairing);
CREATE INDEX idx_x_storeprod ON store_product(product_id);
`

// ExportSlim writes a portable snapshot containing only products a customer can
// realistically buy, without the verbatim raw JSON.
//
// The full database is ~115MB, which is far too large to travel with a skill.
// Dropping order-only products (which also mostly lack tasting notes) and the
// raw column brings it to a few MB.
func (d *DB) ExportSlim(ctx context.Context, path string, maxRank int) (int, error) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return 0, err
	}

	if _, err := d.db.ExecContext(ctx, `ATTACH DATABASE ? AS slim`, path); err != nil {
		return 0, fmt.Errorf("attaching %s: %w", path, err)
	}
	defer d.db.ExecContext(ctx, `DETACH DATABASE slim`)

	for _, stmt := range strings.Split(exportSchema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		// Every object must be created in the attached database, not the main
		// one. Missing a keyword here silently pollutes the source database.
		stmt = strings.Replace(stmt, "CREATE TABLE ", "CREATE TABLE slim.", 1)
		stmt = strings.Replace(stmt, "CREATE INDEX ", "CREATE INDEX slim.", 1)
		if _, err := d.db.ExecContext(ctx, stmt); err != nil {
			return 0, fmt.Errorf("export schema: %w", err)
		}
	}

	copies := []string{
		slimProductCopy,
		`INSERT INTO slim.product_grape SELECT g.* FROM main.product_grape g
		 JOIN slim.product p ON p.product_id = g.product_id`,
		`INSERT INTO slim.product_pairing SELECT r.* FROM main.product_pairing r
		 JOIN slim.product p ON p.product_id = r.product_id`,
		// Only stores whose assortment has actually been mirrored. A store row
		// without store_product rows would read as "carries nothing".
		`INSERT INTO slim.store SELECT s.site_id, s.name, s.address, s.city, s.county
		 FROM main.store s
		 WHERE s.site_id IN (SELECT DISTINCT site_id FROM main.store_product)`,
		`INSERT INTO slim.store_product SELECT sp.site_id, sp.product_id
		 FROM main.store_product sp JOIN slim.product p ON p.product_id = sp.product_id`,
	}
	for i, q := range copies {
		var err error
		if i == 0 {
			_, err = d.db.ExecContext(ctx, q, maxRank)
		} else {
			_, err = d.db.ExecContext(ctx, q)
		}
		if err != nil {
			return 0, fmt.Errorf("export copy %d: %w", i, err)
		}
	}

	// Full-text over the descriptive fields is the whole point of the snapshot,
	// so build it here rather than hoping the consumer can. External content
	// indexes the product table in place instead of storing a second copy of
	// every tasting note, which matters when the file has to travel.
	if _, err := d.db.ExecContext(ctx, `CREATE VIRTUAL TABLE slim.product_fts USING fts5(
		full_name, producer, taste, color, usage,
		content='product', content_rowid='rowid',
		tokenize='unicode61 remove_diacritics 2')`); err != nil {
		return 0, fmt.Errorf("export fts: %w", err)
	}
	if _, err := d.db.ExecContext(ctx, `INSERT INTO slim.product_fts(product_fts) VALUES ('rebuild')`); err != nil {
		return 0, fmt.Errorf("populate fts: %w", err)
	}
	if _, err := d.db.ExecContext(ctx, `INSERT INTO slim.product_fts(product_fts) VALUES ('optimize')`); err != nil {
		return 0, fmt.Errorf("optimize fts: %w", err)
	}

	var n int
	d.db.QueryRowContext(ctx, `SELECT count(*) FROM slim.product`).Scan(&n)

	// ATTACH does not compact, and the file has to travel.
	if _, err := d.db.ExecContext(ctx, `VACUUM slim`); err != nil {
		return n, fmt.Errorf("vacuuming snapshot: %w", err)
	}

	// Record provenance so the consumer can tell how stale the snapshot is.
	var lastSync sql.NullString
	d.db.QueryRowContext(ctx, `SELECT max(finished_at) FROM sync_run WHERE finished_at IS NOT NULL`).Scan(&lastSync)
	var stores sql.NullString
	d.db.QueryRowContext(ctx, `SELECT group_concat(site_id || ' ' || name, '; ')
		FROM slim.store`).Scan(&stores)

	for k, v := range map[string]string{
		"exported_at":    time.Now().UTC().Format(time.RFC3339),
		"source_sync":    lastSync.String,
		"products":       fmt.Sprint(n),
		"max_avail_rank": fmt.Sprint(maxRank),
		"stores_covered": stores.String,
	} {
		if _, err := d.db.ExecContext(ctx, `INSERT INTO slim.meta (key, value) VALUES (?,?)`, k, v); err != nil {
			return n, err
		}
	}
	return n, nil
}

// PruneStale removes products that were not seen during the current sync.
//
// Upserts alone never delete, so anything Systembolaget delists lingers in the
// mirror indefinitely and can be recommended long after it stopped existing.
//
// Callers must only prune after a run that fetched every slice successfully.
// Pruning after a partial run would delete perfectly good products merely
// because their slice failed.
func (d *DB) PruneStale(ctx context.Context, before time.Time) (int, error) {
	cutoff := before.UTC().Format(time.RFC3339)

	tx, err := d.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM product WHERE synced_at < ?`, cutoff).Scan(&n); err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, tx.Commit()
	}

	// Delete children explicitly rather than relying on foreign_keys being on
	// for whichever pooled connection runs this.
	for _, q := range []string{
		`DELETE FROM product_grape   WHERE product_id IN (SELECT product_id FROM product WHERE synced_at < ?)`,
		`DELETE FROM product_pairing WHERE product_id IN (SELECT product_id FROM product WHERE synced_at < ?)`,
		`DELETE FROM store_product   WHERE product_id IN (SELECT product_id FROM product WHERE synced_at < ?)`,
		`DELETE FROM product         WHERE synced_at < ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, cutoff); err != nil {
			return 0, fmt.Errorf("pruning: %w", err)
		}
	}
	return n, tx.Commit()
}
