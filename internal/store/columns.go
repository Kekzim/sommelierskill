package store

import (
	"strings"
	"time"

	"github.com/Kekzim/sommelierskill/internal/normalize"
)

// The product table is declared once, here, and every place that has to agree
// with it is generated from this list.
//
// It used to be spelled out by hand in five places that all had to stay in
// step: the CREATE TABLE in schema.sql, the migration's column list, the
// upsert's column list, its placeholders and its DO UPDATE SET, the argument
// slice passed to it, and the snapshot's schema and copy statement. Nothing
// checked that they matched. `launch_date` was added to four of them and missed
// in the snapshot, so the skill shipped for weeks unable to answer the one
// question the column existed for -- silently, because a column absent from a
// SELECT list is not an error.
//
// Adding a column is now one entry below. What it costs elsewhere:
//
//   - normalize.Product needs the field and FromAPI needs to populate it;
//   - a `backfill` expression recovers it for the ~27k rows already stored,
//     which is what keeps a new column a three-second job instead of a
//     25-minute resync (see migrate.go);
//   - `slim` decides whether it travels in the skill's snapshot;
//   - an index, if it will be filtered on, still goes in schema.sql.
//
// Order matters and is the table's physical order. The upsert, its arguments,
// the snapshot schema and the snapshot copy are all built by walking this slice
// in order, so they cannot disagree about which value belongs in which column.
type productColumn struct {
	name string
	// ddl is the type and constraints for the main table. For a generated
	// column it is the bare type; `generated` carries the expression.
	ddl       string
	generated string
	// key marks the primary key: excluded from the upsert's DO UPDATE SET (it
	// is the conflict target) and never migrated.
	key bool
	// value produces the upsert argument. nil means the column is not written
	// by a sync -- generated columns, and the otherSelections flags that only
	// SetFlag can learn.
	value func(p normalize.Product) any
	// backfill recovers the column from the verbatim `raw` JSON when migration
	// adds it to an existing database. Empty leaves it at its default.
	backfill string
	// slim is the column's declaration in the portable snapshot; empty keeps it
	// out. It differs from ddl because the snapshot stores generated columns as
	// plain values and carries no constraints.
	slim string
}

// txt returns a value function for an optional text field: "" becomes NULL, so
// `WHERE taste IS NOT NULL` means something. See nullIfEmpty.
func txt(get func(normalize.Product) string) func(normalize.Product) any {
	return func(p normalize.Product) any { return nullIfEmpty(get(p)) }
}

// as returns a value function that passes a field through untouched. Pointers
// (*int, *float64) already carry their own absence, and bools map to 0/1.
func as[T any](get func(normalize.Product) T) func(normalize.Product) any {
	return func(p normalize.Product) any { return get(p) }
}

var productColumns = []productColumn{
	{name: "product_id", ddl: "TEXT PRIMARY KEY", key: true, slim: "TEXT PRIMARY KEY",
		value: as(func(p normalize.Product) any { return p.ProductID })},
	{name: "product_number", ddl: "TEXT", value: txt(func(p normalize.Product) string { return p.ProductNumber })},
	{name: "name", ddl: "TEXT NOT NULL", slim: "TEXT", // productNameBold
		value: as(func(p normalize.Product) any { return p.Name })},
	{name: "name_thin", ddl: "TEXT", slim: "TEXT", // productNameThin
		value: txt(func(p normalize.Product) string { return p.NameThin })},
	{name: "full_name", ddl: "TEXT", slim: "TEXT", // name + name_thin, for display
		value: as(func(p normalize.Product) any { return p.FullName })},
	{name: "producer", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Producer })},
	{name: "supplier", ddl: "TEXT", value: txt(func(p normalize.Product) string { return p.Supplier })},

	{name: "country", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Country })},
	{name: "origin1", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Origin1 })},
	{name: "origin2", ddl: "TEXT", value: txt(func(p normalize.Product) string { return p.Origin2 })},

	{name: "cat1", ddl: "TEXT", slim: "TEXT", // Vin / Öl / Sprit / ...
		value: txt(func(p normalize.Product) string { return p.Cat1 })},
	{name: "cat2", ddl: "TEXT", slim: "TEXT", // Rött vin / Ale / Whisky / ...
		value: txt(func(p normalize.Product) string { return p.Cat2 })},
	{name: "cat3", ddl: "TEXT", slim: "TEXT", // style; NULL for ~76% of wine
		value: txt(func(p normalize.Product) string { return p.Cat3 })},
	{name: "category_title", ddl: "TEXT",
		value: txt(func(p normalize.Product) string { return p.CategoryTitle })},

	{name: "vintage", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.Vintage })},
	{name: "price", ddl: "REAL", slim: "REAL",
		value: as(func(p normalize.Product) any { return p.Price })},
	{name: "volume_ml", ddl: "REAL", slim: "REAL",
		value: as(func(p normalize.Product) any { return p.VolumeML })},
	{name: "abv", ddl: "REAL", slim: "REAL",
		value: as(func(p normalize.Product) any { return p.ABV })},
	{name: "sugar_g_per_100ml", ddl: "REAL",
		value: as(func(p normalize.Product) any { return p.SugarPer100ML })},

	// Derived, and STORED so they can never drift out of sync with their
	// inputs. Guarded against zero volume / zero abv. The snapshot carries
	// sek_per_litre as an ordinary value: it is already correct at export, and
	// a generated column would need its inputs to stay in the snapshot too.
	{name: "sek_per_litre", ddl: "REAL", slim: "REAL",
		generated: "CASE WHEN volume_ml > 0 THEN price / (volume_ml / 1000.0) END"},
	{name: "sek_per_cl_alcohol", ddl: "REAL",
		generated: "CASE WHEN volume_ml > 0 AND abv > 0 THEN price / (volume_ml * abv / 100.0 / 10.0) END"},

	// Availability. assortment_text is verbatim; availability/_rank are normalised.
	{name: "assortment_text", ddl: "TEXT",
		value: txt(func(p normalize.Product) string { return p.AssortmentText })},
	{name: "availability", ddl: "TEXT", slim: "TEXT",
		value: as(func(p normalize.Product) any { return p.Availability })},
	{name: "availability_rank", ddl: "INTEGER", slim: "INTEGER", // 1 = easiest to actually buy
		value: as(func(p normalize.Product) any { return p.AvailabilityRank })},
	{name: "is_discontinued", ddl: "INTEGER NOT NULL DEFAULT 0",
		value: as(func(p normalize.Product) any { return p.IsDiscontinued })},
	{name: "is_out_of_stock", ddl: "INTEGER NOT NULL DEFAULT 0",
		value: as(func(p normalize.Product) any { return p.IsOutOfStock })},

	{name: "is_organic", ddl: "INTEGER NOT NULL DEFAULT 0", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.IsOrganic })},
	{name: "is_sustainable", ddl: "INTEGER NOT NULL DEFAULT 0",
		value: as(func(p normalize.Product) any { return p.IsSustainable })},
	{name: "is_ethical", ddl: "INTEGER NOT NULL DEFAULT 0",
		value: as(func(p normalize.Product) any { return p.IsEthical })},
	{name: "ethical_label", ddl: "TEXT",
		value: txt(func(p normalize.Product) string { return p.EthicalLabel })},

	// otherSelections: filterable upstream but never returned in a product
	// record, so these are materialised by separate enrichment passes rather
	// than by the upsert. NULL means "not yet enriched" -- hence no value
	// function, and no NOT NULL. See DB.SetFlag and internal/fetch.
	{name: "is_vegan", ddl: "INTEGER", slim: "INTEGER"},
	{name: "is_natural", ddl: "INTEGER", slim: "INTEGER"},
	{name: "is_gluten_free", ddl: "INTEGER", slim: "INTEGER"},
	{name: "is_kosher", ddl: "INTEGER", slim: "INTEGER"},

	{name: "packaging", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Packaging })},
	{name: "seal", ddl: "TEXT", value: txt(func(p normalize.Product) string { return p.Seal })},
	{name: "co2_impact", ddl: "TEXT", value: txt(func(p normalize.Product) string { return p.CO2Impact })},

	// Taste clocks, 0-12. Populated for essentially all shelf-stocked products.
	{name: "clock_body", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockBody })},
	{name: "clock_tannin", ddl: "INTEGER", slim: "INTEGER", // tasteClockRoughness
		value: as(func(p normalize.Product) any { return p.ClockTannin })},
	{name: "clock_sweetness", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockSweetness })},
	{name: "clock_bitter", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockBitter })},
	{name: "clock_fruitacid", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockFruitacid })},
	{name: "clock_smokiness", ddl: "INTEGER", slim: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockSmokiness })},
	{name: "clock_casque", ddl: "INTEGER",
		value: as(func(p normalize.Product) any { return p.ClockCasque })},
	{name: "casque_text", ddl: "TEXT",
		value: txt(func(p normalize.Product) string { return p.CasqueText })},

	{name: "taste", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Taste })},
	{name: "color", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Color })},
	{name: "usage", ddl: "TEXT", slim: "TEXT",
		value: txt(func(p normalize.Product) string { return p.Usage })},

	// Release scheduling. Limited products are listed on a weekly Thu/Fri
	// cadence and pre-announced, so launch_date is frequently in the future --
	// that is what makes "what drops on Friday" answerable at all.
	// sell_start_time is the time of day sales open. assortment_code is the
	// short code (FS, TSE, TSS, TST, TSV) behind assortment_text.
	{name: "launch_date", ddl: "TEXT", slim: "TEXT",
		value:    txt(func(p normalize.Product) string { return p.LaunchDate }),
		backfill: `NULLIF(json_extract(raw,'$.productLaunchDate'),'')`},
	{name: "sell_start_time", ddl: "TEXT", slim: "TEXT",
		value:    txt(func(p normalize.Product) string { return p.SellStartTime }),
		backfill: `NULLIF(json_extract(raw,'$.sellStartTime'),'')`},
	{name: "is_news", ddl: "INTEGER NOT NULL DEFAULT 0", slim: "INTEGER",
		value:    as(func(p normalize.Product) any { return p.IsNews }),
		backfill: `COALESCE(json_extract(raw,'$.isNews'),0)`},
	// Web launches ("Webblanseringar") are allocation drops applied for online,
	// not bottles to queue for in a shop. Their assortment_text is unknown to
	// the availability map, so they fall back to order_only -- correct, but it
	// hides that they are the most sought-after releases.
	{name: "is_web_launch", ddl: "INTEGER NOT NULL DEFAULT 0", slim: "INTEGER",
		value:    as(func(p normalize.Product) any { return p.IsWebLaunch }),
		backfill: `COALESCE(json_extract(raw,'$.isWebLaunch'),0)`},
	{name: "assortment_code", ddl: "TEXT", slim: "TEXT",
		value:    txt(func(p normalize.Product) string { return p.AssortmentCode }),
		backfill: `NULLIF(json_extract(raw,'$.assortment'),'')`},

	// raw is the untouched API JSON. Systembolaget changes fields without
	// notice, so the typed columns above are a convenience view over data we
	// still keep verbatim: a schema miss never loses information, and every
	// backfill above is only possible because of this column.
	{name: "raw", ddl: "TEXT NOT NULL",
		value: as(func(p normalize.Product) any { return p.Raw })},
	{name: "synced_at", ddl: "TEXT NOT NULL",
		value: as(func(p normalize.Product) any { return p.SyncedAt.UTC().Format(time.RFC3339) })},
}

// insertable returns the columns a sync writes, in table order.
func insertable() []productColumn {
	out := make([]productColumn, 0, len(productColumns))
	for _, c := range productColumns {
		if c.value != nil {
			out = append(out, c)
		}
	}
	return out
}

// slimColumns returns the columns that travel in the portable snapshot.
func slimColumns() []productColumn {
	out := make([]productColumn, 0, len(productColumns))
	for _, c := range productColumns {
		if c.slim != "" {
			out = append(out, c)
		}
	}
	return out
}

// createProductTable is the main product table, built from productColumns.
// Indexes, triggers, the FTS table and every other table stay in schema.sql --
// only the column list is generated, because only the column list was
// duplicated.
var createProductTable = func() string {
	defs := make([]string, 0, len(productColumns))
	for _, c := range productColumns {
		d := "  " + c.name + " " + c.ddl
		if c.generated != "" {
			d += " GENERATED ALWAYS AS (" + c.generated + ") STORED"
		}
		defs = append(defs, d)
	}
	return "CREATE TABLE IF NOT EXISTS product (\n" + strings.Join(defs, ",\n") + "\n);"
}()

// upsertProduct writes one product. The column list, the placeholders and the
// DO UPDATE SET are all built from the same slice, so a column can never appear
// in one and be forgotten in another.
var upsertProduct = func() string {
	cols := insertable()
	names := make([]string, len(cols))
	holes := make([]string, len(cols))
	sets := make([]string, 0, len(cols))
	for i, c := range cols {
		names[i] = c.name
		holes[i] = "?"
		if !c.key {
			sets = append(sets, c.name+"=excluded."+c.name)
		}
	}
	return "INSERT INTO product (\n  " + strings.Join(names, ", ") + "\n) VALUES (" +
		strings.Join(holes, ",") + ")\nON CONFLICT(product_id) DO UPDATE SET\n  " +
		strings.Join(sets, ", ")
}()

// productArgs builds the upsert's arguments by walking the same slice in the
// same order the column list was built from.
func productArgs(p normalize.Product) []any {
	cols := insertable()
	args := make([]any, len(cols))
	for i, c := range cols {
		args[i] = c.value(p)
	}
	return args
}

// slimProductTable is the snapshot's product table. Column names match the main
// table so SQL written against one works against the other.
var slimProductTable = func() string {
	cols := slimColumns()
	defs := make([]string, len(cols))
	for i, c := range cols {
		defs[i] = c.name + " " + c.slim
	}
	return "CREATE TABLE product (" + strings.Join(defs, ", ") + ");"
}()

// slimProductCopy selects the snapshot's columns from the main table, in the
// order slimProductTable declares them.
var slimProductCopy = func() string {
	cols := slimColumns()
	names := make([]string, len(cols))
	for i, c := range cols {
		names[i] = c.name
	}
	return "INSERT INTO slim.product SELECT " + strings.Join(names, ", ") +
		" FROM main.product WHERE availability_rank <= ? AND is_discontinued = 0"
}()
