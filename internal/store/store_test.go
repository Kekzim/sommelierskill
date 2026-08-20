package store

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ejonsvn/bolagetdb/internal/normalize"
)

func openTemp(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func f64(v float64) *float64 { return &v }
func i(v int) *int           { return &v }

func sample() normalize.Product {
	return normalize.Product{
		ProductID: "1", Name: "Château Test", NameThin: "Grand Cru",
		FullName: "Château Test Grand Cru", Producer: "Test Domaine",
		Cat1: "Vin", Cat2: "Rött vin",
		Price: f64(200), VolumeML: f64(500), ABV: f64(10),
		Availability: normalize.AvailStocked, AvailabilityRank: 1,
		AssortmentText: "Fast sortiment",
		ClockBody:      i(9), ClockTannin: i(7),
		Taste:    "Nyanserad smak med inslag av tobak, körsbär och choklad.",
		Raw:      `{"productId":"1"}`,
		SyncedAt: time.Now(),
		Grapes:   []normalize.Grape{{Canonical: "Syrah", Raw: "Shiraz"}},
		Pairings: []string{"Nöt", "Ost"},
	}
}

func put(t *testing.T, db *DB, ps ...normalize.Product) {
	t.Helper()
	w, err := db.NewWriter()
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	for _, p := range ps {
		if err := w.Put(p); err != nil {
			t.Fatalf("Put: %v", err)
		}
	}
	if err := w.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

func TestRoundTripAndGeneratedColumns(t *testing.T) {
	db := openTemp(t)
	put(t, db, sample())

	var name string
	var sekPerLitre, sekPerClAlcohol float64
	err := db.SQL().QueryRow(
		`SELECT full_name, sek_per_litre, sek_per_cl_alcohol FROM product WHERE product_id='1'`,
	).Scan(&name, &sekPerLitre, &sekPerClAlcohol)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if name != "Château Test Grand Cru" {
		t.Errorf("full_name = %q", name)
	}
	// 200 kr for 500 ml = 400 kr/litre
	if sekPerLitre != 400 {
		t.Errorf("sek_per_litre = %v, want 400", sekPerLitre)
	}
	// 500 ml at 10% = 5 cl pure alcohol; 200 kr / 5 = 40
	if sekPerClAlcohol != 40 {
		t.Errorf("sek_per_cl_alcohol = %v, want 40", sekPerClAlcohol)
	}
}

// A zero volume must not blow up the generated columns.
func TestGeneratedColumnsGuardZero(t *testing.T) {
	p := sample()
	p.VolumeML = f64(0)
	p.ABV = f64(0)
	db := openTemp(t)
	put(t, db, p)

	var sekPerLitre, sekPerCl any
	if err := db.SQL().QueryRow(
		`SELECT sek_per_litre, sek_per_cl_alcohol FROM product WHERE product_id='1'`,
	).Scan(&sekPerLitre, &sekPerCl); err != nil {
		t.Fatalf("select: %v", err)
	}
	if sekPerLitre != nil || sekPerCl != nil {
		t.Errorf("expected NULL for zero volume/abv, got %v and %v", sekPerLitre, sekPerCl)
	}
}

func TestFTSBooleanSearch(t *testing.T) {
	a := sample() // tobak + körsbär, no ek
	b := sample()
	b.ProductID, b.FullName, b.Name = "2", "Oaky Test", "Oaky Test"
	b.Taste = "Smak med tydlig ek och vanilj."

	db := openTemp(t)
	put(t, db, a, b)

	var got string
	err := db.SQL().QueryRow(`
		SELECT p.product_id FROM product_fts f JOIN product p ON p.rowid = f.rowid
		WHERE product_fts MATCH 'taste:(tobak AND körsbär) NOT taste:ek'`).Scan(&got)
	if err != nil {
		t.Fatalf("fts query: %v", err)
	}
	if got != "1" {
		t.Errorf("boolean FTS matched %q, want product 1", got)
	}

	// Diacritics are folded, so an agent can type ASCII.
	var n int
	if err := db.SQL().QueryRow(
		`SELECT count(*) FROM product_fts WHERE product_fts MATCH 'korsbar'`).Scan(&n); err != nil {
		t.Fatalf("diacritic query: %v", err)
	}
	if n != 1 {
		t.Errorf("diacritic-folded search matched %d rows, want 1", n)
	}
}

// Re-syncing must update in place and must not leave stale child rows behind.
func TestUpsertReplacesChildRows(t *testing.T) {
	db := openTemp(t)
	put(t, db, sample())

	updated := sample()
	updated.Price = f64(250)
	updated.Grapes = []normalize.Grape{{Canonical: "Merlot", Raw: "Merlot"}}
	updated.Pairings = []string{"Fisk"}
	put(t, db, updated)

	var products, grapes, pairings int
	var price float64
	db.SQL().QueryRow(`SELECT count(*) FROM product`).Scan(&products)
	db.SQL().QueryRow(`SELECT price FROM product WHERE product_id='1'`).Scan(&price)
	db.SQL().QueryRow(`SELECT count(*) FROM product_grape WHERE product_id='1'`).Scan(&grapes)
	db.SQL().QueryRow(`SELECT count(*) FROM product_pairing WHERE product_id='1'`).Scan(&pairings)

	if products != 1 {
		t.Errorf("products = %d, want 1 (upsert, not insert)", products)
	}
	if price != 250 {
		t.Errorf("price = %v, want 250", price)
	}
	if grapes != 1 || pairings != 1 {
		t.Errorf("stale child rows: grapes=%d pairings=%d, want 1 and 1", grapes, pairings)
	}

	// The FTS index must track the update, not accumulate duplicates.
	var ftsRows int
	db.SQL().QueryRow(`SELECT count(*) FROM product_fts WHERE product_fts MATCH 'tobak'`).Scan(&ftsRows)
	if ftsRows != 1 {
		t.Errorf("fts matched %d rows after update, want 1", ftsRows)
	}
}

func TestSetFlagRejectsUnknownColumn(t *testing.T) {
	db := openTemp(t)
	put(t, db, sample())

	if err := db.SetFlag("is_vegan", []string{"1"}); err != nil {
		t.Fatalf("SetFlag: %v", err)
	}
	var vegan int
	db.SQL().QueryRow(`SELECT is_vegan FROM product WHERE product_id='1'`).Scan(&vegan)
	if vegan != 1 {
		t.Errorf("is_vegan = %d, want 1", vegan)
	}

	// The column name is interpolated into SQL, so it must be allowlisted.
	if err := db.SetFlag("price = 0 --", []string{"1"}); err == nil {
		t.Error("SetFlag accepted an unknown column; it must reject anything not allowlisted")
	}
}

// A second pass must clear the flag from products that no longer carry it.
func TestSetFlagClearsStale(t *testing.T) {
	db := openTemp(t)
	a, b := sample(), sample()
	b.ProductID = "2"
	put(t, db, a, b)

	if err := db.SetFlag("is_vegan", []string{"1", "2"}); err != nil {
		t.Fatal(err)
	}
	if err := db.SetFlag("is_vegan", []string{"2"}); err != nil {
		t.Fatal(err)
	}

	var one, two int
	db.SQL().QueryRow(`SELECT is_vegan FROM product WHERE product_id='1'`).Scan(&one)
	db.SQL().QueryRow(`SELECT is_vegan FROM product WHERE product_id='2'`).Scan(&two)
	if one != 0 || two != 1 {
		t.Errorf("is_vegan = %d/%d, want 0/1 after re-enrichment", one, two)
	}
}

// Fields the API omitted must be stored as NULL, not "". Storing empty strings
// makes `WHERE taste IS NOT NULL` match every row -- a wrong answer with no error.
func TestAbsentTextIsNull(t *testing.T) {
	p := sample()
	p.Cat3 = ""
	p.Taste = ""
	p.EthicalLabel = ""
	p.Producer = ""
	p.NameThin = ""

	db := openTemp(t)
	put(t, db, p)

	var nulls int
	if err := db.SQL().QueryRow(`
		SELECT (cat3 IS NULL) + (taste IS NULL) + (ethical_label IS NULL)
		     + (producer IS NULL) + (name_thin IS NULL)
		FROM product WHERE product_id='1'`).Scan(&nulls); err != nil {
		t.Fatalf("select: %v", err)
	}
	if nulls != 5 {
		t.Errorf("%d of 5 absent fields stored as NULL; the rest are empty strings", nulls)
	}

	// The common filtering idiom must actually discriminate.
	var withTaste int
	db.SQL().QueryRow(`SELECT count(*) FROM product WHERE taste IS NOT NULL`).Scan(&withTaste)
	if withTaste != 0 {
		t.Errorf("taste IS NOT NULL matched %d rows, want 0", withTaste)
	}
}
