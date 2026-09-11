package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kekzim/sommelierskill/internal/fetch"
	"github.com/Kekzim/sommelierskill/internal/store"
	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
)

// throttlingAPI refuses the named categories until they have been asked for
// `refusals` times, then serves them -- the shape Systembolaget actually
// produced on 2026-09-11, where a window of 429s lifted a few minutes later.
type throttlingAPI struct {
	mu       sync.Mutex
	refuse   map[string]int // category -> refusals remaining
	products map[string]int // category -> how many to serve
	asked    map[string]int
}

func (a *throttlingAPI) RoundTrip(r *http.Request) (*http.Response, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	cat := r.URL.Query().Get("categoryLevel1")
	a.asked[cat]++

	if left := a.refuse[cat]; left > 0 {
		a.refuse[cat] = left - 1
		return &http.Response{
			StatusCode: http.StatusTooManyRequests,
			Body:       io.NopCloser(strings.NewReader(`{}`)),
			Header:     http.Header{},
		}, nil
	}

	n := a.products[cat]
	products := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		products = append(products, map[string]any{
			"productId":       cat + "-" + string(rune('a'+i)),
			"productNameBold": cat,
			"categoryLevel1":  cat,
		})
	}
	body, _ := json.Marshal(map[string]any{
		"metadata": map[string]any{"nextPage": -1, "docCount": n},
		"products": products,
		"filters":  []any{},
	})
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(string(body))),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
	}, nil
}

// A slice that exhausts its per-request retries inside a throttle window must
// be picked up again once the window has passed, rather than costing the run.
//
// On 2026-09-11 three slices gave up between 19:13 and 19:19 while the
// enrichment and store passes, minutes later, succeeded -- so the whole sync
// was discarded over a throttle that had already lifted.
func TestFailedSlicesAreRetriedAtTheEndOfTheRun(t *testing.T) {
	api := &throttlingAPI{
		// One refusal fails the slice outright: FetchSlice returns on the first
		// error, and the transport that would have retried is not in play here.
		refuse:   map[string]int{"Öl": 1, "Sprit": 1},
		products: map[string]int{"Vin": 3, "Öl": 2, "Sprit": 2, "Cider": 1},
		asked:    map[string]int{},
	}
	// The fake is used raw, without the production retry transport: its real
	// backoff would make this test sleep for minutes, and it has its own tests
	// in internal/fetch. What is under test here is the sweep.
	f := &fetch.Fetcher{
		Client: &systembolaget.AuthenticatedClient{APIKey: "test", Client: &http.Client{Transport: api}},
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	slices := []fetch.Slice{
		{Cat1: "Vin", Est: 3}, {Cat1: "Öl", Est: 2},
		{Cat1: "Sprit", Est: 2}, {Cat1: "Cider", Est: 1},
	}

	stored, failures, incomplete, err := syncProducts(
		context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)),
		f, db, slices, time.Now(), nil, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("syncProducts: %v", err)
	}

	if failures != 0 {
		t.Errorf("failures = %d, want 0; both throttled slices should recover on the sweep", failures)
	}
	if incomplete != 0 {
		t.Errorf("incomplete = %d, want 0", incomplete)
	}
	if stored != 8 {
		t.Errorf("stored = %d, want 8 (3+2+2+1)", stored)
	}

	var n int
	if err := db.SQL().QueryRow(`SELECT count(*) FROM product`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 8 {
		t.Errorf("%d products in the database, want 8; the retried slices were not written", n)
	}
}

// A slice that is still refusing at sweep time must count as a failure, so the
// prune guard still refuses to delete against a partial run.
func TestSlicesStillFailingAfterTheSweepCountAsFailures(t *testing.T) {
	api := &throttlingAPI{
		refuse:   map[string]int{"Öl": 1000},
		products: map[string]int{"Vin": 3, "Öl": 2},
		asked:    map[string]int{},
	}
	f := &fetch.Fetcher{
		Client: &systembolaget.AuthenticatedClient{APIKey: "test", Client: &http.Client{Transport: api}},
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	db, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	_, failures, _, err := syncProducts(
		context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)),
		f, db, []fetch.Slice{{Cat1: "Vin", Est: 3}, {Cat1: "Öl", Est: 2}},
		time.Now(), nil, 10*time.Millisecond)
	if err != nil {
		t.Fatalf("syncProducts: %v", err)
	}
	if failures != 1 {
		t.Errorf("failures = %d, want 1; a slice that never recovers must still stop the prune", failures)
	}
}
