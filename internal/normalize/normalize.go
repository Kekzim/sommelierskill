// Package normalize turns raw Systembolaget product records into the typed,
// cleaned shape bolagetdb stores.
//
// The upstream API is deliberately loosely typed (see systembolaget.Product,
// which is a map[string]any) because Systembolaget changes fields without
// notice. Everything here is therefore defensive: a missing or unexpectedly
// typed field yields a zero value rather than an error, and the caller always
// keeps the verbatim JSON alongside.
package normalize

import (
	"bufio"
	_ "embed"
	"strconv"
	"strings"
	"time"

	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
)

//go:embed grapes.tsv
var grapesTSV string

var grapeSynonyms map[string]string

func init() {
	grapeSynonyms = make(map[string]string)
	s := bufio.NewScanner(strings.NewReader(grapesTSV))
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		from, to, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		grapeSynonyms[foldGrape(from)] = strings.TrimSpace(to)
	}
}

func foldGrape(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// CanonicalGrape maps a grape name to its canonical form. Unknown grapes pass
// through with whitespace tidied, so nothing is ever dropped.
func CanonicalGrape(raw string) string {
	raw = strings.TrimSpace(raw)
	if c, ok := grapeSynonyms[foldGrape(raw)]; ok {
		return c
	}
	return raw
}

// Availability tiers, ordered by how easily a customer can actually buy the
// product. Systembolaget's own assortment names conflate "in the catalogue"
// with "on a shelf"; roughly 72% of wine is order-only.
const (
	AvailStocked   = "stocked"    // walk in and buy
	AvailLimited   = "limited"    // in stores while stocks last
	AvailOrderOnly = "order_only" // must be ordered in
)

var availabilityByAssortment = map[string]struct {
	Tier string
	Rank int
}{
	"Fast sortiment":        {AvailStocked, 1},
	"Lokalt & Småskaligt":   {AvailStocked, 1},
	"Tillfälligt sortiment": {AvailLimited, 2},
	"Säsong":                {AvailLimited, 2},
	"Presentsortiment":      {AvailLimited, 2},
	"Ordervaror":            {AvailOrderOnly, 3},
	"Webblanseringar":       {AvailOrderOnly, 3},
}

// Availability maps an assortmentText to a normalised tier and rank. Unknown
// assortment names are treated as order-only: the conservative choice, since
// overstating availability is the failure that misleads a recommendation.
func Availability(assortmentText string) (string, int) {
	if a, ok := availabilityByAssortment[strings.TrimSpace(assortmentText)]; ok {
		return a.Tier, a.Rank
	}
	return AvailOrderOnly, 3
}

// Product is the normalised, storable form of a product record.
type Product struct {
	ProductID     string
	ProductNumber string
	Name          string
	NameThin      string
	FullName      string
	Producer      string
	Supplier      string

	Country string
	Origin1 string
	Origin2 string

	Cat1          string
	Cat2          string
	Cat3          string
	CategoryTitle string

	Vintage       *int
	Price         *float64
	VolumeML      *float64
	ABV           *float64
	SugarPer100ML *float64

	AssortmentText   string
	Availability     string
	AvailabilityRank int
	IsDiscontinued   bool
	IsOutOfStock     bool

	IsOrganic     bool
	IsSustainable bool
	IsEthical     bool
	EthicalLabel  string

	Packaging string
	Seal      string
	CO2Impact string

	ClockBody      *int
	ClockTannin    *int
	ClockSweetness *int
	ClockBitter    *int
	ClockFruitacid *int
	ClockSmokiness *int
	ClockCasque    *int
	CasqueText     string

	Taste string
	Color string
	Usage string

	// Release scheduling. Systembolaget lists limited products on a weekly
	// Thursday/Friday cadence and pre-announces them, so LaunchDate is often in
	// the future. SellStartTime is the time of day sales open ("10:00:00").
	LaunchDate    string
	SellStartTime string
	IsNews        bool
	// AssortmentCode is the short code behind AssortmentText: FS (fast), TSE/TSS/
	// TST/TSV (the temporary sub-types), and so on. Narrower than AssortmentText.
	AssortmentCode string

	Grapes   []Grape
	Pairings []string

	Raw      string
	SyncedAt time.Time
}

// Grape pairs a canonical grape name with the name the API actually used.
type Grape struct {
	Canonical string
	Raw       string
}

// FromAPI converts a raw product record. raw is the verbatim JSON for that
// record, stored as-is so a schema change here never loses data.
func FromAPI(p systembolaget.Product, raw string, syncedAt time.Time) Product {
	out := Product{
		ProductID:     str(p, "productId"),
		ProductNumber: str(p, "productNumber"),
		Name:          str(p, "productNameBold"),
		NameThin:      str(p, "productNameThin"),
		Producer:      str(p, "producerName"),
		Supplier:      str(p, "supplierName"),

		Country: str(p, "country"),
		Origin1: str(p, "originLevel1"),
		Origin2: str(p, "originLevel2"),

		Cat1:          str(p, "categoryLevel1"),
		Cat2:          str(p, "categoryLevel2"),
		Cat3:          str(p, "categoryLevel3"),
		CategoryTitle: str(p, "customCategoryTitle"),

		Vintage:       vintage(p),
		Price:         num(p, "price"),
		VolumeML:      num(p, "volume"),
		ABV:           num(p, "alcoholPercentage"),
		SugarPer100ML: num(p, "sugarContentGramPer100ml"),

		AssortmentText: str(p, "assortmentText"),
		IsDiscontinued: boolean(p, "isDiscontinued"),
		IsOutOfStock:   boolean(p, "isCompletelyOutOfStock") || boolean(p, "isTemporaryOutOfStock"),

		IsOrganic:     boolean(p, "isOrganic"),
		IsSustainable: boolean(p, "isSustainableChoice"),
		IsEthical:     boolean(p, "isEthical"),
		EthicalLabel:  str(p, "ethicalLabel"),

		Packaging: str(p, "packagingLevel1"),
		Seal:      str(p, "seal"),
		CO2Impact: str(p, "packagingCO2ImpactLevel"),

		ClockBody:      integer(p, "tasteClockBody"),
		ClockTannin:    integer(p, "tasteClockRoughness"),
		ClockSweetness: integer(p, "tasteClockSweetness"),
		ClockBitter:    integer(p, "tasteClockBitter"),
		ClockFruitacid: integer(p, "tasteClockFruitacid"),
		ClockSmokiness: integer(p, "tasteClockSmokiness"),
		ClockCasque:    integer(p, "tasteClockCasque"),
		CasqueText:     str(p, "hasCasqueTaste"),

		Taste: str(p, "taste"),
		Color: str(p, "color"),
		Usage: str(p, "usage"),

		LaunchDate:     str(p, "productLaunchDate"),
		SellStartTime:  str(p, "sellStartTime"),
		IsNews:         boolean(p, "isNews"),
		AssortmentCode: str(p, "assortment"),

		Raw:      raw,
		SyncedAt: syncedAt,
	}

	out.FullName = strings.TrimSpace(out.Name + " " + out.NameThin)
	out.Availability, out.AvailabilityRank = Availability(out.AssortmentText)

	for _, g := range strList(p, "grapes") {
		if g = strings.TrimSpace(g); g != "" {
			out.Grapes = append(out.Grapes, Grape{Canonical: CanonicalGrape(g), Raw: g})
		}
	}
	for _, s := range strList(p, "tasteSymbols") {
		if s = strings.TrimSpace(s); s != "" {
			out.Pairings = append(out.Pairings, s)
		}
	}
	return out
}

// --- defensive accessors -----------------------------------------------------

func str(p systembolaget.Product, key string) string {
	v, _ := p[key].(string)
	return strings.TrimSpace(v)
}

func boolean(p systembolaget.Product, key string) bool {
	v, _ := p[key].(bool)
	return v
}

func num(p systembolaget.Product, key string) *float64 {
	switch v := p[key].(type) {
	case float64:
		return &v
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return &f
		}
	}
	return nil
}

func integer(p systembolaget.Product, key string) *int {
	f := num(p, key)
	if f == nil {
		return nil
	}
	i := int(*f)
	return &i
}

// vintage arrives as a string ("2019") often enough that it needs its own path.
func vintage(p systembolaget.Product) *int {
	switch v := p["vintage"].(type) {
	case float64:
		i := int(v)
		return &i
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return &i
		}
	}
	return nil
}

func strList(p systembolaget.Product, key string) []string {
	raw, ok := p[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
