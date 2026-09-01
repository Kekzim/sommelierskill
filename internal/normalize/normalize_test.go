package normalize

import (
	"testing"
	"time"

	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
)

func TestCanonicalGrape(t *testing.T) {
	cases := []struct{ in, want string }{
		// Genuine synonyms that must merge.
		{"Shiraz", "Syrah"},
		{"shiraz", "Syrah"},
		{"  Garnacha  ", "Grenache"},
		{"Tinta roriz", "Tempranillo"},
		{"Spätburgunder", "Pinot noir"},
		{"Primitivo", "Zinfandel"},
		{"Monastrell", "Mourvèdre"},
		{"Pinot grigio", "Pinot gris"},

		// Distinct grapes that look like synonyms and must NOT merge.
		{"Petite sirah", "Petite sirah"}, // Durif, not Syrah
		{"Welschriesling", "Welschriesling"},
		{"Pinotage", "Pinotage"},
		{"Cabernet franc", "Cabernet franc"},

		// Already canonical, and unknown grapes pass through.
		{"Syrah", "Syrah"},
		{"Nerello mascalese", "Nerello mascalese"},
		{"Some Unlisted Grape", "Some Unlisted Grape"},
	}
	for _, c := range cases {
		if got := CanonicalGrape(c.in); got != c.want {
			t.Errorf("CanonicalGrape(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAvailability(t *testing.T) {
	cases := []struct {
		in   string
		tier string
		rank int
	}{
		{"Fast sortiment", AvailStocked, 1},
		{"Lokalt & Småskaligt", AvailStocked, 1},
		{"Tillfälligt sortiment", AvailLimited, 2},
		{"Ordervaror", AvailOrderOnly, 3},
		{"Webblanseringar", AvailOrderOnly, 3},
		// Unknown assortment names are treated as order-only: overstating
		// availability is the failure that misleads a recommendation.
		{"Something New", AvailOrderOnly, 3},
		{"", AvailOrderOnly, 3},
	}
	for _, c := range cases {
		tier, rank := Availability(c.in)
		if tier != c.tier || rank != c.rank {
			t.Errorf("Availability(%q) = %q/%d, want %q/%d", c.in, tier, rank, c.tier, c.rank)
		}
	}
}

func TestFromAPI(t *testing.T) {
	now := time.Now()
	p := systembolaget.Product{
		"productId":           "12345",
		"productNameBold":     "Château Test",
		"productNameThin":     "Grand Cru",
		"producerName":        "Test Domaine",
		"categoryLevel1":      "Vin",
		"categoryLevel2":      "Rött vin",
		"assortmentText":      "Fast sortiment",
		"price":               float64(199),
		"volume":              float64(750),
		"alcoholPercentage":   float64(13.5),
		"vintage":             "2019", // arrives as a string in practice
		"isOrganic":           true,
		"tasteClockBody":      float64(9),
		"tasteClockRoughness": float64(7),
		"grapes":              []any{"Shiraz", "Merlot"},
		"tasteSymbols":        []any{"Nöt", "Ost"},
		"taste":               "Tobak och körsbär.",
	}

	out := FromAPI(p, `{"productId":"12345"}`, now)

	if out.FullName != "Château Test Grand Cru" {
		t.Errorf("FullName = %q", out.FullName)
	}
	if out.Vintage == nil || *out.Vintage != 2019 {
		t.Errorf("Vintage = %v, want 2019", out.Vintage)
	}
	if out.Availability != AvailStocked || out.AvailabilityRank != 1 {
		t.Errorf("availability = %q/%d", out.Availability, out.AvailabilityRank)
	}
	if out.ClockTannin == nil || *out.ClockTannin != 7 {
		t.Errorf("ClockTannin = %v, want 7 (tasteClockRoughness)", out.ClockTannin)
	}
	if len(out.Grapes) != 2 || out.Grapes[0].Canonical != "Syrah" || out.Grapes[0].Raw != "Shiraz" {
		t.Errorf("Grapes = %+v, want Shiraz canonicalised to Syrah with raw preserved", out.Grapes)
	}
	if len(out.Pairings) != 2 {
		t.Errorf("Pairings = %+v", out.Pairings)
	}
}

// A record missing nearly everything must not panic: the upstream API is
// loosely typed and fields disappear without notice.
func TestFromAPISparse(t *testing.T) {
	out := FromAPI(systembolaget.Product{"productId": "1"}, "{}", time.Now())
	if out.ProductID != "1" {
		t.Fatalf("ProductID = %q", out.ProductID)
	}
	if out.Price != nil || out.Vintage != nil || out.ClockBody != nil {
		t.Errorf("expected nil numerics for a sparse record, got %+v", out)
	}
	if out.Availability != AvailOrderOnly {
		t.Errorf("Availability = %q, want conservative default", out.Availability)
	}
}

// Wrong types must yield zero values rather than panicking.
func TestFromAPIWrongTypes(t *testing.T) {
	out := FromAPI(systembolaget.Product{
		"productId":       "1",
		"productNameBold": float64(42), // not a string
		"price":           "not a number",
		"grapes":          "not a list",
		"isOrganic":       "yes", // not a bool
	}, "{}", time.Now())

	if out.Name != "" || out.Price != nil || out.Grapes != nil || out.IsOrganic {
		t.Errorf("expected zero values for mistyped fields, got %+v", out)
	}
}

// Release scheduling is what makes "what drops on Friday" answerable, so the
// three fields behind it must survive the raw record.
func TestFromAPIReleaseFields(t *testing.T) {
	p := systembolaget.Product{
		"productId":         "1",
		"productNameBold":   "Château Test",
		"assortmentText":    "Tillfälligt sortiment",
		"productLaunchDate": "2026-09-11T00:00:00",
		"sellStartTime":     "10:00:00",
		"isNews":            true,
		"assortment":        "TSE",
	}
	got := FromAPI(p, "{}", time.Now())

	if got.LaunchDate != "2026-09-11T00:00:00" {
		t.Errorf("LaunchDate = %q", got.LaunchDate)
	}
	if got.SellStartTime != "10:00:00" {
		t.Errorf("SellStartTime = %q", got.SellStartTime)
	}
	if !got.IsNews {
		t.Error("IsNews = false, want true")
	}
	// assortment_code discriminates where assortment_text cannot: TSE and TSV
	// both read as "Tillfälligt sortiment".
	if got.AssortmentCode != "TSE" {
		t.Errorf("AssortmentCode = %q, want TSE", got.AssortmentCode)
	}
}

// A record missing the release fields entirely must yield zero values rather
// than an error, like every other field in normalize.
func TestFromAPIReleaseFieldsAbsent(t *testing.T) {
	got := FromAPI(systembolaget.Product{"productId": "1", "productNameBold": "x"}, "{}", time.Now())
	if got.LaunchDate != "" || got.SellStartTime != "" || got.AssortmentCode != "" || got.IsNews {
		t.Errorf("absent release fields did not yield zero values: %+v", got)
	}
}
