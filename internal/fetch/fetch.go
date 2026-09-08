// Package fetch pulls the assortment from Systembolaget and feeds it to the store.
//
// Two upstream constraints shape everything here:
//
//  1. A query can return at most ~9,990 products (page size caps at 30, page
//     number at 333). The assortment is ~27k products, so it must be fetched in
//     slices. Slices are discovered from the API's own facet tree rather than
//     hardcoded, so a new category cannot silently go missing.
//
//  2. The otherSelections attributes (vegan, natural wine, gluten free, kosher)
//     are filterable but are never returned inside a product record. They can
//     only be learned by asking which products match the filter, which is what
//     the enrichment pass does.
package fetch

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/Kekzim/sommelierskill/internal/normalize"
	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
)

// pageCap is the maximum number of products any single query can yield
// (30 per page x 333 pages). A slice approaching it is silently truncated
// upstream, so we check rather than trust.
const pageCap = 333 * 30

// Slice is one fetchable partition of the assortment.
type Slice struct {
	Cat1 string
	Cat2 string // empty means "the whole of Cat1"
	Est  int    // expected product count, from the facet counts
}

func (s Slice) String() string {
	if s.Cat2 == "" {
		return s.Cat1
	}
	return s.Cat1 + " / " + s.Cat2
}

func (s Slice) filter() systembolaget.SearchFilter {
	return systembolaget.FilterByCategory(s.Cat1, s.Cat2, "")
}

// OtherSelections are the enrichable attributes, mapped to their db column.
var OtherSelections = map[string]string{
	"Vegansk":   "is_vegan",
	"Naturvin":  "is_natural",
	"Glutenfri": "is_gluten_free",
	"Koscher":   "is_kosher",
}

// filterByOtherSelection is not provided by the upstream library. SearchFilter
// is just func(*url.Values), so the gap is easy to close without forking.
func filterByOtherSelection(value string) systembolaget.SearchFilter {
	return func(v *url.Values) { v.Add("otherSelections", value) }
}

type Fetcher struct {
	Client    *systembolaget.AuthenticatedClient
	PageDelay time.Duration
	Log       *slog.Logger
}

// PlanSlices asks the API for its category tree and turns it into a slice plan.
// Every categoryLevel2 currently sits well under the page cap; a top-level
// category is only used whole when it fits.
func (f *Fetcher) PlanSlices(ctx context.Context) ([]Slice, error) {
	root, err := f.Client.Search(ctx, &systembolaget.SearchOptions{PageSize: 1})
	if err != nil {
		return nil, fmt.Errorf("discovering categories: %w", err)
	}

	cat1 := findFilter(root.Filters, "CategoryLevel1")
	if cat1 == nil {
		return nil, fmt.Errorf("no CategoryLevel1 facet in response; API shape changed")
	}

	var slices []Slice
	for _, m := range cat1.SearchModifiers {
		if m.Count == 0 {
			continue
		}
		if m.Count < pageCap {
			slices = append(slices, Slice{Cat1: m.Value, Est: m.Count})
			continue
		}
		// Too big to fetch whole: descend into its subcategories.
		sub, err := f.Client.Search(ctx, &systembolaget.SearchOptions{PageSize: 1},
			systembolaget.FilterByCategory(m.Value, "", ""))
		if err != nil {
			return nil, fmt.Errorf("discovering subcategories of %s: %w", m.Value, err)
		}
		child := findFilter(sub.Filters, "CategoryLevel1")
		if child == nil || child.Child == nil {
			return nil, fmt.Errorf("category %q exceeds the page cap but exposes no subcategories", m.Value)
		}
		for _, c := range child.Child.SearchModifiers {
			if c.Count == 0 {
				continue
			}
			if c.Count >= pageCap {
				f.Log.Warn("subcategory still exceeds the page cap and will be truncated upstream",
					slog.String("category", m.Value), slog.String("subcategory", c.Value),
					slog.Int("count", c.Count), slog.Int("cap", pageCap))
			}
			slices = append(slices, Slice{Cat1: m.Value, Cat2: c.Value, Est: c.Count})
		}
	}
	return slices, nil
}

// ProductFunc receives each product together with its verbatim JSON.
type ProductFunc func(normalize.Product) error

// passOrders are the sort orders tried in turn until a slice is fully covered.
//
// The API pages by offset over a non-stable ordering: rows shuffle between
// requests, so a single walk returns some products twice and skips others
// entirely. Leaving sortBy unset is worst (~23% of the assortment missed);
// an explicit sort cuts that to ~1%, and walking the same slice again from a
// different direction picks up the stragglers. Products are upserted by id,
// so extra passes only ever add coverage.
var passOrders = []struct {
	By  systembolaget.SortProperty
	Dir systembolaget.SortDirection
}{
	{systembolaget.SortPropertyName, systembolaget.SortDirectionAscending},
	{systembolaget.SortPropertyName, systembolaget.SortDirectionDescending},
	{systembolaget.SortPropertyPrice, systembolaget.SortDirectionAscending},
	{systembolaget.SortPropertyPrice, systembolaget.SortDirectionDescending},
}

// SliceResult reports how completely a slice was fetched.
type SliceResult struct {
	Rows     int // rows returned across all passes, duplicates included
	Unique   int // distinct products this slice contributed
	Passes   int
	Complete bool // Unique reached the count the API reported
}

// FetchSlice walks one slice until it has seen every product the API claims it
// holds, or until the available sort orders are exhausted.
//
// seen is shared across slices and carries the ids already stored, so fn is
// called at most once per product per sync. It deliberately does not affect
// this slice's coverage count -- see the note in the body.
func (f *Fetcher) FetchSlice(ctx context.Context, s Slice, syncedAt time.Time, seen map[string]struct{}, fn ProductFunc) (SliceResult, error) {
	var res SliceResult

	// Coverage of this slice is its own question, separate from what the sync
	// has already stored. A product can belong to two slices, and when it does,
	// counting only the ids this slice contributed *first* makes the second
	// slice permanently short of its facet count -- no sort order can recover a
	// product that was legitimately fetched, just earlier. Measured: "Vin /
	// Smaksatt vin & fruktvin" reports 176 of 178 in a full sync and 178 of 178
	// when fetched alone.
	//
	// That is not cosmetic. One slice short of its count sets incomplete, and
	// incomplete vetoes the prune for the entire run, so delisted products
	// survive another week because two wines were counted somewhere else.
	inSlice := make(map[string]struct{})

	for _, order := range passOrders {
		before := res.Unique
		rows, err := f.fetchPass(ctx, s, order.By, order.Dir, syncedAt, inSlice, seen, &res, fn)
		res.Rows += rows
		res.Passes++
		if err != nil {
			return res, err
		}

		if s.Est > 0 && res.Unique >= s.Est {
			res.Complete = true
			return res, nil
		}
		// A pass that added nothing new means more passes will not help either.
		if res.Unique == before {
			break
		}
		f.Log.Debug("slice incomplete, retrying with a different sort order",
			slog.String("slice", s.String()),
			slog.Int("unique", res.Unique), slog.Int("expected", s.Est))
	}

	res.Complete = s.Est > 0 && res.Unique >= s.Est
	if !res.Complete {
		f.Log.Warn("slice not fully covered after all sort orders",
			slog.String("slice", s.String()),
			slog.Int("unique", res.Unique), slog.Int("expected", s.Est),
			slog.Int("passes", res.Passes))
	}
	return res, nil
}

// fetchPass walks the slice once in a given order, forwarding only products not
// already seen.
func (f *Fetcher) fetchPass(
	ctx context.Context,
	s Slice,
	by systembolaget.SortProperty,
	dir systembolaget.SortDirection,
	syncedAt time.Time,
	inSlice map[string]struct{},
	seen map[string]struct{},
	res *SliceResult,
	fn ProductFunc,
) (int, error) {
	cursor := f.Client.SearchWithCursor(&systembolaget.SearchOptions{
		PageSize:      30,
		SortBy:        by,
		SortDirection: dir,
	}, s.filter())

	rows := 0
	for cursor.Next(ctx, f.PageDelay) {
		p := cursor.At()
		rows++

		id, ok := p.ID()
		if !ok {
			f.Log.Warn("skipping product without an id", slog.String("slice", s.String()))
			continue
		}
		// Coverage first: this slice has now returned this product, whether or
		// not another slice got to it earlier.
		if _, counted := inSlice[id]; !counted {
			inSlice[id] = struct{}{}
			res.Unique++
		}

		// Storage second: fn runs at most once per product per sync.
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}

		raw, err := json.Marshal(p)
		if err != nil {
			return rows, fmt.Errorf("re-encoding product %s: %w", id, err)
		}
		if err := fn(normalize.FromAPI(p, string(raw), syncedAt)); err != nil {
			return rows, err
		}
	}
	if err := cursor.Error(); err != nil {
		return rows, fmt.Errorf("slice %s (%s %s): %w", s, by, dir, err)
	}
	return rows, nil
}

// collectIDs walks a filtered query and returns the distinct product ids it
// matches.
//
// This carries the same pagination hazard as FetchSlice: a single walk over an
// unstable ordering silently misses rows. The expected count is taken from the
// first response's metadata, and passes continue until the distinct count
// reaches it.
func (f *Fetcher) collectIDs(ctx context.Context, label string, filters ...systembolaget.SearchFilter) ([]string, error) {
	seen := make(map[string]struct{})
	ids := make([]string, 0, 256)
	expected := -1

	for _, order := range passOrders {
		before := len(ids)

		cursor := f.Client.SearchWithCursor(&systembolaget.SearchOptions{
			PageSize:      30,
			SortBy:        order.By,
			SortDirection: order.Dir,
		}, filters...)

		for cursor.Next(ctx, f.PageDelay) {
			if expected < 0 {
				if page := cursor.CurrentPage(); page != nil {
					expected = page.Metadata.DocumentCount
				}
			}
			id, ok := cursor.At().ID()
			if !ok {
				continue
			}
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		if err := cursor.Error(); err != nil {
			return nil, fmt.Errorf("%s (%s %s): %w", label, order.By, order.Dir, err)
		}

		if expected >= 0 && len(ids) >= expected {
			return ids, nil
		}
		if len(ids) == before {
			break
		}
	}

	if expected >= 0 && len(ids) < expected {
		f.Log.Warn("could not collect every matching product",
			slog.String("query", label),
			slog.Int("collected", len(ids)), slog.Int("expected", expected))
	}
	return ids, nil
}

// EnrichOtherSelections returns the product ids carrying a given attribute.
// These attributes are filterable upstream but never appear in a product
// record, so this is the only way to learn them.
func (f *Fetcher) EnrichOtherSelections(ctx context.Context, value string) ([]string, error) {
	return f.collectIDs(ctx, "otherSelections="+value, filterByOtherSelection(value))
}

// StoreAssortment returns the product ids a specific store carries. Mirroring
// every store nationally is not worth it (~450 stores), but one or two local
// stores is quick and makes "can I walk in and buy this" answerable offline.
func (f *Fetcher) StoreAssortment(ctx context.Context, siteID string) ([]string, error) {
	return f.collectIDs(ctx, "store="+siteID, systembolaget.FilterByStore(siteID))
}

func findFilter(filters []systembolaget.Filter, name string) *systembolaget.Filter {
	for i := range filters {
		if filters[i].Name == name {
			return &filters[i]
		}
	}
	return nil
}
