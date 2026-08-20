// Package store owns the SQLite database: schema, upserts and queries.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"text/tabwriter"
	"time"

	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
	"github.com/ejonsvn/bolagetdb/internal/normalize"
	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

type DB struct{ db *sql.DB }

// Open opens (creating if needed) the database at path and applies the schema.
func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
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

const upsertProduct = `
INSERT INTO product (
  product_id, product_number, name, name_thin, full_name, producer, supplier,
  country, origin1, origin2, cat1, cat2, cat3, category_title,
  vintage, price, volume_ml, abv, sugar_g_per_100ml,
  assortment_text, availability, availability_rank, is_discontinued, is_out_of_stock,
  is_organic, is_sustainable, is_ethical, ethical_label,
  packaging, seal, co2_impact,
  clock_body, clock_tannin, clock_sweetness, clock_bitter, clock_fruitacid,
  clock_smokiness, clock_casque, casque_text,
  taste, color, usage, launch_date, raw, synced_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(product_id) DO UPDATE SET
  product_number=excluded.product_number, name=excluded.name, name_thin=excluded.name_thin,
  full_name=excluded.full_name, producer=excluded.producer, supplier=excluded.supplier,
  country=excluded.country, origin1=excluded.origin1, origin2=excluded.origin2,
  cat1=excluded.cat1, cat2=excluded.cat2, cat3=excluded.cat3, category_title=excluded.category_title,
  vintage=excluded.vintage, price=excluded.price, volume_ml=excluded.volume_ml, abv=excluded.abv,
  sugar_g_per_100ml=excluded.sugar_g_per_100ml, assortment_text=excluded.assortment_text,
  availability=excluded.availability, availability_rank=excluded.availability_rank,
  is_discontinued=excluded.is_discontinued, is_out_of_stock=excluded.is_out_of_stock,
  is_organic=excluded.is_organic, is_sustainable=excluded.is_sustainable,
  is_ethical=excluded.is_ethical, ethical_label=excluded.ethical_label,
  packaging=excluded.packaging, seal=excluded.seal, co2_impact=excluded.co2_impact,
  clock_body=excluded.clock_body, clock_tannin=excluded.clock_tannin,
  clock_sweetness=excluded.clock_sweetness, clock_bitter=excluded.clock_bitter,
  clock_fruitacid=excluded.clock_fruitacid, clock_smokiness=excluded.clock_smokiness,
  clock_casque=excluded.clock_casque, casque_text=excluded.casque_text,
  taste=excluded.taste, color=excluded.color, usage=excluded.usage,
  launch_date=excluded.launch_date, raw=excluded.raw, synced_at=excluded.synced_at`

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
	ts := p.SyncedAt.UTC().Format(time.RFC3339)
	if _, err := w.product.Exec(
		p.ProductID, nullIfEmpty(p.ProductNumber), p.Name, nullIfEmpty(p.NameThin),
		p.FullName, nullIfEmpty(p.Producer), nullIfEmpty(p.Supplier),
		nullIfEmpty(p.Country), nullIfEmpty(p.Origin1), nullIfEmpty(p.Origin2),
		nullIfEmpty(p.Cat1), nullIfEmpty(p.Cat2), nullIfEmpty(p.Cat3), nullIfEmpty(p.CategoryTitle),
		p.Vintage, p.Price, p.VolumeML, p.ABV, p.SugarPer100ML,
		nullIfEmpty(p.AssortmentText), p.Availability, p.AvailabilityRank, p.IsDiscontinued, p.IsOutOfStock,
		p.IsOrganic, p.IsSustainable, p.IsEthical, nullIfEmpty(p.EthicalLabel),
		nullIfEmpty(p.Packaging), nullIfEmpty(p.Seal), nullIfEmpty(p.CO2Impact),
		p.ClockBody, p.ClockTannin, p.ClockSweetness, p.ClockBitter, p.ClockFruitacid,
		p.ClockSmokiness, p.ClockCasque, nullIfEmpty(p.CasqueText),
		nullIfEmpty(p.Taste), nullIfEmpty(p.Color), nullIfEmpty(p.Usage),
		nullIfEmpty(p.LaunchDate), p.Raw, ts,
	); err != nil {
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
