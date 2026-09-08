package fetch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"
)

// Retry policy. Deliberately patient rather than quick: when Systembolaget
// rate-limits, it refuses everything for a while rather than briefly, so a
// retry a second later is just another refusal.
const (
	retryAttempts = 5
	retryBaseWait = 5 * time.Second
	retryMaxWait  = 60 * time.Second
)

// RetryingClient wraps an HTTP client so that a transient upstream failure does
// not throw away a twenty-minute sync.
//
// This is an undocumented API and it rate-limits hard. A single 429 used to
// abort the whole run: on 2026-09-08 one arrived twelve minutes in and took
// six slices, all four enrichment passes and both store assortments with it in
// under half a second. Nothing was published -- the guards saw to that -- but
// the cost of one refused request was a week of staleness until the next
// scheduled run.
//
// Retrying in the transport covers every request the upstream library makes,
// including the API-key fetch, without touching a single call site.
//
// Only safe conditions are retried: 429, the transient 5xx family, and network
// errors. A context that was cancelled or ran out of time is the caller's
// decision and is passed straight back.
func RetryingClient(base *http.Client, log *slog.Logger) *http.Client {
	if base == nil {
		base = http.DefaultClient
	}
	inner := base.Transport
	if inner == nil {
		inner = http.DefaultTransport
	}
	c := *base
	c.Transport = &retryTransport{
		base:     inner,
		log:      log,
		attempts: retryAttempts,
		baseWait: retryBaseWait,
		maxWait:  retryMaxWait,
	}
	return &c
}

// The waits are fields rather than constants so a test can exercise the retry
// loop without sleeping for the better part of a minute.
type retryTransport struct {
	base     http.RoundTripper
	log      *slog.Logger
	attempts int
	baseWait time.Duration
	maxWait  time.Duration
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// A body that cannot be rewound cannot be replayed. Every call the upstream
	// library makes is a bodyless GET, so this is a guard, not a case we meet.
	if req.Body != nil && req.GetBody == nil {
		return t.base.RoundTrip(req)
	}

	for attempt := 1; ; attempt++ {
		if attempt > 1 && req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			req.Body = body
		}

		resp, err := t.base.RoundTrip(req)
		if !shouldRetry(resp, err) || attempt >= t.attempts {
			return resp, err
		}

		wait := t.backoff(attempt, resp)
		t.logRetry(req, resp, err, attempt, wait)

		// The body must be drained and closed before another attempt, or the
		// connection is not returned to the pool and the run leaks one per retry.
		if resp != nil {
			io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
			resp.Body.Close()
		}

		select {
		case <-req.Context().Done():
			return nil, req.Context().Err()
		case <-time.After(wait):
		}
	}
}

func (t *retryTransport) logRetry(req *http.Request, resp *http.Response, err error, attempt int, wait time.Duration) {
	if t.log == nil {
		return
	}
	attrs := []any{
		slog.String("url", req.URL.Path),
		slog.Int("attempt", attempt),
		slog.Int("of", t.attempts),
		slog.Duration("waiting", wait),
	}
	if resp != nil {
		attrs = append(attrs, slog.Int("status", resp.StatusCode))
	}
	if err != nil {
		attrs = append(attrs, slog.Any("error", err))
	}
	t.log.Warn("upstream refused the request; backing off", attrs...)
}

func shouldRetry(resp *http.Response, err error) bool {
	if err != nil {
		// Cancellation and deadlines come from the caller, not the server.
		return !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
	}
	switch resp.StatusCode {
	case http.StatusTooManyRequests,
		http.StatusInternalServerError,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	}
	return false
}

// backoff grows exponentially from retryBaseWait, with a little jitter so that
// a burst of refusals does not come back in lockstep. A Retry-After header is
// the server saying how long it wants, and is preferred over anything computed.
func (t *retryTransport) backoff(attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if d, ok := retryAfter(resp.Header.Get("Retry-After")); ok {
			return min(d, t.maxWait)
		}
	}
	wait := min(t.baseWait<<(attempt-1), t.maxWait)
	if j := int64(wait) / 4; j > 0 {
		wait += time.Duration(rand.Int64N(j))
	}
	return wait
}

// retryAfter reads the header in both of its forms: delay-seconds, and an
// HTTP-date. A date already in the past means "now".
func retryAfter(v string) (time.Duration, bool) {
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second, true
	}
	if at, err := http.ParseTime(v); err == nil {
		if d := time.Until(at); d > 0 {
			return d, true
		}
		return 0, true
	}
	return 0, false
}
