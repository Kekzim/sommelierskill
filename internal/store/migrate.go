package store

import (
	"database/sql"
	"fmt"
)

// migrate brings an existing database up to the current schema.
//
// The product table is created with `IF NOT EXISTS`, so it only ever builds a
// fresh database -- adding a column to productColumns is silently skipped on an
// existing one, and the miss does not surface until an upsert fails on a column
// that is not there. Rebuilding instead would mean a ~25 minute resync for every
// new field.
//
// So every column is ALTER TABLE'd in when absent and backfilled from `raw`.
// Backfilling is what makes this cheap: the verbatim API JSON is already stored
// for every row, so historical values are recoverable without touching the
// network. The five release columns were recovered for ~27,000 products in
// about three seconds.
//
// Adding a column is therefore one entry in productColumns, and giving it a
// `backfill` expression is what decides whether existing rows get a value or
// wait for the next full sync.
//
// It is idempotent: columns already present are left alone, and a backfill only
// runs for a column this call actually added -- so a value edited after
// migration is never overwritten on the next Open.
func migrate(db *sql.DB) error {
	for _, c := range productColumns {
		// Generated columns cannot be added by ALTER TABLE (SQLite rejects
		// STORED), and the primary key cannot either. Neither can be missing
		// from a database this code created, so there is nothing to do.
		if c.generated != "" || c.key {
			continue
		}
		has, err := hasColumn(db, "product", c.name)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		// ALTER TABLE ADD COLUMN refuses NOT NULL without a default. Every
		// column declared that way carries one; a new one that does not will
		// fail loudly here rather than corrupting anything.
		if _, err := db.Exec(fmt.Sprintf("ALTER TABLE product ADD COLUMN %s %s", c.name, c.ddl)); err != nil {
			return fmt.Errorf("adding product.%s: %w", c.name, err)
		}
		if c.backfill == "" {
			continue
		}
		// Only rows that already carry raw JSON can be recovered; a row without
		// it keeps the column default rather than failing the migration.
		q := fmt.Sprintf("UPDATE product SET %s = %s WHERE raw IS NOT NULL", c.name, c.backfill)
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("backfilling product.%s: %w", c.name, err)
		}
	}
	return nil
}

// hasColumn reports whether a column exists. Table and column names here come
// from productColumns, never from user input.
func hasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid         int
			name, ctype string
			notnull, pk int
			dflt        sql.NullString
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}
