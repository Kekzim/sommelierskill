package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// openAt opens a database at an explicit path so a test can close and reopen it.
func openAt(t *testing.T, path string) *DB {
	t.Helper()
	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return db
}

// A database created before the release columns existed must gain them on the
// next Open, with values recovered from `raw` -- otherwise every new column
// would cost a ~25 minute resync.
func TestMigrateAddsAndBackfillsFromRaw(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")

	// Build a database as it looked before the release columns existed: the real
	// current schema with exactly those columns removed. Hand-rolling a minimal
	// table instead would fail on unrelated indexes and prove nothing.
	seed := openAt(t, path)
	p := sample()
	p.Raw = `{"productId":"1","sellStartTime":"10:00:00","isNews":true,"assortment":"TSE"}`
	put(t, seed, p)
	if _, err := seed.SQL().Exec(`
		DROP INDEX IF EXISTS idx_product_launch;
		ALTER TABLE product DROP COLUMN launch_date;
		ALTER TABLE product DROP COLUMN sell_start_time;
		ALTER TABLE product DROP COLUMN is_news;
		ALTER TABLE product DROP COLUMN assortment_code;`); err != nil {
		t.Fatalf("regressing schema: %v", err)
	}
	seed.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open (should migrate): %v", err)
	}
	defer db.Close()

	var (
		sellStart, code sql.NullString
		isNews          int
	)
	if err := db.SQL().QueryRow(
		`SELECT sell_start_time, is_news, assortment_code FROM product WHERE product_id='1'`,
	).Scan(&sellStart, &isNews, &code); err != nil {
		t.Fatalf("selecting migrated columns: %v", err)
	}
	if sellStart.String != "10:00:00" {
		t.Errorf("sell_start_time = %q, want 10:00:00 (backfill from raw did not run)", sellStart.String)
	}
	if isNews != 1 {
		t.Errorf("is_news = %d, want 1", isNews)
	}
	if code.String != "TSE" {
		t.Errorf("assortment_code = %q, want TSE", code.String)
	}
}

// Opening repeatedly must not fail or re-run backfills -- Open happens on every
// command, so a non-idempotent migration would corrupt data edited since.
func TestMigrateIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "repeat.db")
	for i := 0; i < 3; i++ {
		db, err := Open(path)
		if err != nil {
			t.Fatalf("Open #%d: %v", i+1, err)
		}
		db.Close()
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	// A value written after migration must survive later Opens rather than being
	// overwritten by a backfill that runs unconditionally.
	if _, err := db.SQL().Exec(
		`INSERT INTO product (product_id,name,sell_start_time,raw,synced_at)
		 VALUES ('1','x','13:00:00','{"sellStartTime":"10:00:00"}','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	db.Close()

	db2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer db2.Close()

	var got string
	if err := db2.SQL().QueryRow(`SELECT sell_start_time FROM product WHERE product_id='1'`).Scan(&got); err != nil {
		t.Fatalf("select: %v", err)
	}
	if got != "13:00:00" {
		t.Errorf("sell_start_time = %q, want 13:00:00; a backfill re-ran over existing data", got)
	}
}

// The release columns are the point of the migration: they must be queryable as
// a date window, which is what the upcoming-releases lookup does.
func TestReleaseColumnsRoundTrip(t *testing.T) {
	p := sample()
	p.LaunchDate = "2026-09-11T00:00:00"
	p.SellStartTime = "10:00:00"
	p.IsNews = true
	p.AssortmentCode = "TSE"

	db := openTemp(t)
	put(t, db, p)

	var n int
	if err := db.SQL().QueryRow(`
		SELECT count(*) FROM product
		WHERE launch_date >= '2026-09-01' AND launch_date < '2026-09-15'
		  AND assortment_code = 'TSE'`).Scan(&n); err != nil {
		t.Fatalf("select: %v", err)
	}
	if n != 1 {
		t.Errorf("date-window query matched %d rows, want 1", n)
	}
}

// Absent release text must be NULL, not "", for the same reason every other
// optional text column is: `WHERE sell_start_time IS NOT NULL` has to mean
// something. See TestAbsentTextIsNull.
func TestAbsentReleaseTextIsNull(t *testing.T) {
	p := sample()
	p.LaunchDate = ""
	p.SellStartTime = ""
	p.AssortmentCode = ""

	db := openTemp(t)
	put(t, db, p)

	var nulls int
	if err := db.SQL().QueryRow(`
		SELECT (launch_date IS NULL) + (sell_start_time IS NULL) + (assortment_code IS NULL)
		FROM product WHERE product_id='1'`).Scan(&nulls); err != nil {
		t.Fatalf("select: %v", err)
	}
	if nulls != 3 {
		t.Errorf("%d of 3 absent release fields stored as NULL; the rest are empty strings", nulls)
	}
}
