package fetch

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Kekzim/sommelierskill/internal/normalize"
	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
)

// fakeAPI answers every search with the next canned page, so a slice walk can
// be driven without touching Systembolaget. The host is hardcoded upstream, so
// intercepting at the transport is the only way in.
type fakeAPI struct {
	pages [][]string // product ids, one entry per pass
	calls int
}

func (f *fakeAPI) RoundTrip(*http.Request) (*http.Response, error) {
	ids := f.pages[min(f.calls, len(f.pages)-1)]
	f.calls++

	products := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		products = append(products, map[string]any{
			"productId":       id,
			"productNameBold": "Wine " + id,
			"categoryLevel1":  "Vin",
			"categoryLevel2":  "Smaksatt vin & fruktvin",
		})
	}
	body, _ := json.Marshal(map[string]any{
		// nextPage -1 ends the walk after this page.
		"metadata": map[string]any{"nextPage": -1, "docCount": len(products)},
		"products": products,
		"filters":  []any{},
	})
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

func fetcherWith(api *fakeAPI) *Fetcher {
	return &Fetcher{
		Client: &systembolaget.AuthenticatedClient{
			APIKey: "test",
			Client: &http.Client{Transport: api},
		},
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// A product can belong to two slices. When it does, the second slice must still
// count it as covered -- it was returned, just stored earlier.
//
// Counting only first-time ids made that slice permanently short of its facet
// count, no sort order could fix it, and one short slice vetoes the prune for
// the whole run. Measured against the live API: "Vin / Smaksatt vin &
// fruktvin" reported 176 of 178 in a full sync and 178 of 178 alone.
func TestCoverageCountsProductsAlreadySeenInAnotherSlice(t *testing.T) {
	api := &fakeAPI{pages: [][]string{{"1", "2", "3"}}}
	f := fetcherWith(api)

	// "2" was fetched by an earlier slice in this same sync.
	seen := map[string]struct{}{"2": {}}

	var stored []string
	res, err := f.FetchSlice(context.Background(), Slice{Cat1: "Vin", Cat2: "Smaksatt", Est: 3},
		time.Now(), seen, func(p normalize.Product) error {
			stored = append(stored, p.ProductID)
			return nil
		})
	if err != nil {
		t.Fatalf("FetchSlice: %v", err)
	}

	if res.Unique != 3 {
		t.Errorf("Unique = %d, want 3; a product counted by another slice is still covered by this one", res.Unique)
	}
	if !res.Complete {
		t.Errorf("Complete = false with %d of 3 covered; this slice would veto the run's prune", res.Unique)
	}
	// The point of `seen` survives: the duplicate is not stored twice.
	if len(stored) != 2 || stored[0] != "1" || stored[1] != "3" {
		t.Errorf("stored %v, want [1 3]; fn must run at most once per product per sync", stored)
	}
}

// Within one slice, repeats across passes must not inflate coverage -- that is
// the whole reason the count is of distinct ids rather than rows.
func TestCoverageDoesNotDoubleCountAcrossPasses(t *testing.T) {
	// Pass 1 returns two of three; pass 2 returns an overlapping set.
	api := &fakeAPI{pages: [][]string{{"1", "2"}, {"2", "3"}}}
	f := fetcherWith(api)

	res, err := f.FetchSlice(context.Background(), Slice{Cat1: "Vin", Est: 3},
		time.Now(), map[string]struct{}{}, func(normalize.Product) error { return nil })
	if err != nil {
		t.Fatalf("FetchSlice: %v", err)
	}

	if res.Unique != 3 {
		t.Errorf("Unique = %d, want 3 distinct across two passes", res.Unique)
	}
	if res.Rows != 4 {
		t.Errorf("Rows = %d, want 4; rows count everything returned, duplicates included", res.Rows)
	}
	if res.Passes != 2 {
		t.Errorf("Passes = %d, want 2", res.Passes)
	}
}

// A slice that genuinely cannot be covered must still report itself incomplete.
// The guard exists because pruning after a partial run deletes good products.
func TestGenuinelyShortSliceStaysIncomplete(t *testing.T) {
	api := &fakeAPI{pages: [][]string{{"1", "2"}}}
	f := fetcherWith(api)

	res, err := f.FetchSlice(context.Background(), Slice{Cat1: "Vin", Est: 5},
		time.Now(), map[string]struct{}{}, func(normalize.Product) error { return nil })
	if err != nil {
		t.Fatalf("FetchSlice: %v", err)
	}
	if res.Complete {
		t.Error("Complete = true with 2 of 5 covered; a real shortfall must still stop the prune")
	}
}
