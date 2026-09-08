package fetch

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// testTransport is the production one with waits short enough to test.
func testTransport(base http.RoundTripper) *retryTransport {
	return &retryTransport{
		base:     base,
		attempts: retryAttempts,
		baseWait: time.Millisecond,
		maxWait:  5 * time.Millisecond,
	}
}

// serve counts requests and answers each with the next status in the list,
// repeating the last one once the list is exhausted.
func serve(t *testing.T, statuses ...int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(n.Add(1)) - 1
		if i >= len(statuses) {
			i = len(statuses) - 1
		}
		w.WriteHeader(statuses[i])
		w.Write([]byte("body"))
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func get(t *testing.T, rt http.RoundTripper, url string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return rt.RoundTrip(req)
}

// The failure this exists for: a 429 twelve minutes into a twenty-minute sync
// used to take the rest of the run with it.
func TestRetriesPastRateLimit(t *testing.T) {
	srv, n := serve(t, http.StatusTooManyRequests, http.StatusTooManyRequests, http.StatusOK)

	resp, err := get(t, testTransport(http.DefaultTransport), srv.URL)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	if got := n.Load(); got != 3 {
		t.Errorf("server saw %d requests, want 3 (two refusals then success)", got)
	}
}

// Retrying a 404 would turn one wrong URL into five.
func TestDoesNotRetryClientErrors(t *testing.T) {
	srv, n := serve(t, http.StatusNotFound)

	resp, err := get(t, testTransport(http.DefaultTransport), srv.URL)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	defer resp.Body.Close()

	if got := n.Load(); got != 1 {
		t.Errorf("server saw %d requests, want 1; a 404 is not transient", got)
	}
}

// When the upstream never relents, the caller must get the real response back
// rather than a synthetic error -- the sync's own guards decide what to do with
// a failed slice, and they need the status.
func TestGivesUpAndReturnsTheLastResponse(t *testing.T) {
	srv, n := serve(t, http.StatusTooManyRequests)

	resp, err := get(t, testTransport(http.DefaultTransport), srv.URL)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", resp.StatusCode)
	}
	if got := int(n.Load()); got != retryAttempts {
		t.Errorf("server saw %d requests, want %d", got, retryAttempts)
	}
}

func TestRetriesTransientServerErrors(t *testing.T) {
	srv, n := serve(t, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusOK)

	resp, err := get(t, testTransport(http.DefaultTransport), srv.URL)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	defer resp.Body.Close()

	if got := n.Load(); got != 3 {
		t.Errorf("server saw %d requests, want 3", got)
	}
}

// closeCounter reports whether the bodies of abandoned attempts were closed.
// Leaking one connection per retry would be invisible until a long sync ran out
// of file descriptors.
type closeCounter struct {
	base   http.RoundTripper
	closed atomic.Int32
}

type countingBody struct {
	rc     interface{ Read([]byte) (int, error) }
	onced  bool
	parent *closeCounter
}

func (b *countingBody) Read(p []byte) (int, error) { return b.rc.Read(p) }
func (b *countingBody) Close() error {
	if !b.onced {
		b.onced = true
		b.parent.closed.Add(1)
	}
	return nil
}

func (c *closeCounter) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := c.base.RoundTrip(req)
	if resp != nil {
		resp.Body = &countingBody{rc: resp.Body, parent: c}
	}
	return resp, err
}

func TestAbandonedResponsesAreClosed(t *testing.T) {
	srv, _ := serve(t, http.StatusTooManyRequests, http.StatusTooManyRequests, http.StatusOK)
	counter := &closeCounter{base: http.DefaultTransport}

	resp, err := get(t, testTransport(counter), srv.URL)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	defer resp.Body.Close()

	// The two refused attempts; the successful one belongs to the caller.
	if got := counter.closed.Load(); got != 2 {
		t.Errorf("%d abandoned bodies closed, want 2", got)
	}
}

// A cancelled sync must stop during a backoff, not sleep out the full wait.
func TestStopsWhenTheContextIsCancelled(t *testing.T) {
	srv, _ := serve(t, http.StatusTooManyRequests)

	rt := testTransport(http.DefaultTransport)
	rt.baseWait = 10 * time.Second
	rt.maxWait = 10 * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	if _, err := rt.RoundTrip(req); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("took %s to notice cancellation; it slept through the backoff", elapsed)
	}
}

func TestShouldRetryClassification(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		want bool
	}{
		{"rate limited", http.StatusTooManyRequests, true},
		{"bad gateway", http.StatusBadGateway, true},
		{"unavailable", http.StatusServiceUnavailable, true},
		{"gateway timeout", http.StatusGatewayTimeout, true},
		{"internal", http.StatusInternalServerError, true},
		{"ok", http.StatusOK, false},
		{"not found", http.StatusNotFound, false},
		{"forbidden", http.StatusForbidden, false},
		{"bad request", http.StatusBadRequest, false},
	} {
		if got := shouldRetry(&http.Response{StatusCode: tc.code}, nil); got != tc.want {
			t.Errorf("%s (%d): shouldRetry = %v, want %v", tc.name, tc.code, got, tc.want)
		}
	}

	if shouldRetry(nil, context.Canceled) {
		t.Error("a cancelled context is the caller's decision, not a transient failure")
	}
	if shouldRetry(nil, context.DeadlineExceeded) {
		t.Error("an expired deadline is the caller's decision, not a transient failure")
	}
	if !shouldRetry(nil, errors.New("connection reset by peer")) {
		t.Error("a network error should be retried")
	}
}

func TestRetryAfterHeader(t *testing.T) {
	if d, ok := retryAfter("30"); !ok || d != 30*time.Second {
		t.Errorf("delay-seconds: got %v %v, want 30s true", d, ok)
	}
	past := time.Now().Add(-time.Hour).UTC().Format(http.TimeFormat)
	if d, ok := retryAfter(past); !ok || d != 0 {
		t.Errorf("a date in the past should mean now: got %v %v", d, ok)
	}
	if _, ok := retryAfter(""); ok {
		t.Error("an absent header is not a delay")
	}
	if _, ok := retryAfter("soon"); ok {
		t.Error("an unparseable header is not a delay")
	}
}

// Retry-After is the server saying how long it wants, and outranks the
// exponential schedule -- but must not be able to stall a sync indefinitely.
func TestBackoffPrefersRetryAfterButCapsIt(t *testing.T) {
	rt := testTransport(http.DefaultTransport)
	rt.baseWait = time.Second
	rt.maxWait = 30 * time.Second

	resp := &http.Response{Header: http.Header{"Retry-After": []string{"7"}}}
	if got := rt.backoff(1, resp); got != 7*time.Second {
		t.Errorf("backoff = %v, want 7s from the header", got)
	}

	resp.Header.Set("Retry-After", "3600")
	if got := rt.backoff(1, resp); got != rt.maxWait {
		t.Errorf("backoff = %v, want it capped at %v", got, rt.maxWait)
	}

	// Without the header, the wait grows and stays within its cap.
	prev := time.Duration(0)
	for attempt := 1; attempt <= 6; attempt++ {
		got := rt.backoff(attempt, nil)
		if got > rt.maxWait+rt.maxWait/4 {
			t.Errorf("attempt %d waited %v, beyond the cap", attempt, got)
		}
		if attempt <= 4 && got <= prev {
			t.Errorf("attempt %d waited %v, not longer than the previous %v", attempt, got, prev)
		}
		prev = got
	}
}
