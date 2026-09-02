package store

import (
	"database/sql"
	"fmt"
)

// schema.sql is all CREATE TABLE IF NOT EXISTS, so it only ever builds a fresh
// database -- adding a column there is silently skipped on an existing one, and
// the miss does not surface until an upsert fails on a column that is not
// there. Rebuilding instead would mean a ~25 minute resync for every new field.
//
// So added columns are declared here as well, applied with ALTER TABLE when
// absent, and backfilled from `raw`. Backfilling is what makes this cheap: the
// verbatim API JSON is already stored for every row, so historical values are
// recoverable without touching the network.
//
// Adding a column is therefore a two-line change: add it to schema.sql (for
// fresh databases) and add it here (for existing ones), with the json_extract
// that recovers it.
type addedColumn struct {
	table    string
	column   string
	ddl      string // the ALTER TABLE ADD COLUMN body
	backfill string // SQL expression over `raw`; empty means leave NULL
}

var addedColumns = []addedColumn{
	{"product", "launch_date", "TEXT", `NULLIF(json_extract(raw,'$.productLaunchDate'),'')`},
	{"product", "sell_start_time", "TEXT", `NULLIF(json_extract(raw,'$.sellStartTime'),'')`},
	{"product", "is_news", "INTEGER NOT NULL DEFAULT 0", `COALESCE(json_extract(raw,'$.isNews'),0)`},
	{"product", "assortment_code", "TEXT", `NULLIF(json_extract(raw,'$.assortment'),'')`},
	{"product", "is_web_launch", "INTEGER NOT NULL DEFAULT 0", `COALESCE(json_extract(raw,'$.isWebLaunch'),0)`},
}

// migrate brings an existing database up to the current schema. It is
// idempotent: columns already present are left alone, and a backfill only runs
// for a column this call actually added.
func migrate(db *sql.DB) error {
	for _, c := range addedColumns {
		// On a fresh database the table does not exist yet; schema.sql is about
		// to create it with every column already present, so there is nothing to
		// migrate.
		exists, err := tableExists(db, c.table)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		has, err := hasColumn(db, c.table, c.column)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		if _, err := db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", c.table, c.column, c.ddl)); err != nil {
			return fmt.Errorf("adding %s.%s: %w", c.table, c.column, err)
		}
		if c.backfill == "" {
			continue
		}
		// Only rows that already carry raw JSON can be recovered; a row without
		// it keeps the column default rather than failing the migration.
		q := fmt.Sprintf("UPDATE %s SET %s = %s WHERE raw IS NOT NULL", c.table, c.column, c.backfill)
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("backfilling %s.%s: %w", c.table, c.column, err)
		}
	}
	return nil
}

// hasColumn reports whether a column exists. Table and column names here come
// from the addedColumns list above, never from user input.
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

// tableExists reports whether a table is present. Migration runs before the
// schema is applied, so on a fresh database every table is still missing.
func tableExists(db *sql.DB, table string) (bool, error) {
	var n int
	err := db.QueryRow(
		`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n)
	return n > 0, err
}
