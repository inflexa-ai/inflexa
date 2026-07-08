package main

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSignCallback_Deterministic(t *testing.T) {
	secret := []byte("topsecret")
	body := []byte(`{"hello":"world"}`)
	s1 := signCallback(secret, "exec1", 123, body)
	s2 := signCallback(secret, "exec1", 123, body)
	if s1 != s2 {
		t.Fatalf("same inputs produced different signatures: %s vs %s", s1, s2)
	}
	if _, err := hex.DecodeString(s1); err != nil {
		t.Fatalf("signature is not hex: %s", s1)
	}
}

func TestSignCallback_ChangesWithInputs(t *testing.T) {
	secret := []byte("topsecret")
	body := []byte(`{"x":1}`)
	s1 := signCallback(secret, "exec1", 123, body)
	if s := signCallback(secret, "exec2", 123, body); s == s1 {
		t.Fatalf("execId change did not alter signature")
	}
	if s := signCallback(secret, "exec1", 124, body); s == s1 {
		t.Fatalf("timestamp change did not alter signature")
	}
	if s := signCallback([]byte("other"), "exec1", 123, body); s == s1 {
		t.Fatalf("secret change did not alter signature")
	}
}

func TestCallbackClient_HappyPath(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(context.Context, time.Duration) {}
	if err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("expected 1 attempt, got %d", got)
	}
}

// Cortex rejects a stale timestamp as a HARD CANCEL, not as a retryable
// condition (harness/src/sandbox/await-exec.ts). A retry loop that reused one
// timestamp would therefore become permanently un-acceptable once the delivery
// exceeded the freshness window — retrying forever against a verdict that can
// never change. Each attempt must carry its own timestamp and signature.
func TestCallbackClient_ReSignsEveryAttempt(t *testing.T) {
	var attempts int32
	var firstSig, firstTs string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			firstSig = r.Header.Get(headerSignature)
			firstTs = r.Header.Get(headerTimestamp)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.Header.Get(headerTimestamp) == firstTs {
			t.Errorf("timestamp was reused across retries: %s", firstTs)
		}
		if r.Header.Get(headerSignature) == firstSig {
			t.Errorf("signature was reused across retries")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Advance the clock a second per call so the retry lands on a later timestamp
	// exactly as it would in a real backoff.
	var ticks int64
	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(context.Context, time.Duration) {}
	c.now = func() time.Time {
		ticks++
		return time.Unix(1_700_000_000+ticks, 0)
	}

	if err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
	}
}

// The signature must stay valid for the body it carries, on every attempt —
// re-signing must not mean signing something else.
func TestCallbackClient_EachAttemptSignatureVerifies(t *testing.T) {
	secret := []byte("topsecret")
	body := []byte(`{"exitCode":0}`)

	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		got, _ := io.ReadAll(r.Body)
		ts, err := strconv.ParseInt(r.Header.Get(headerTimestamp), 10, 64)
		if err != nil {
			t.Errorf("attempt %d: unparseable timestamp: %v", n, err)
		}
		if want := signCallback(secret, "x1", ts, got); r.Header.Get(headerSignature) != want {
			t.Errorf("attempt %d: signature does not verify against (execId, ts, body)", n)
		}
		if n < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, secret)
	c.sleep = func(context.Context, time.Duration) {}
	if err := c.post(context.Background(), callbackKindComplete, "x1", body); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

// A completion whose delivery outlasts Cortex's freshness window must still be
// acceptable when it finally lands: the timestamp ages with the attempt, not
// with the result. This is the regression that made the recovery wedge (#41)
// unfixable by a stable callback address alone.
func TestCallbackClient_DeliveryAfterFreshnessWindowCarriesFreshTimestamp(t *testing.T) {
	const freshnessSec = 300

	// A stand-in for Cortex: rejects anything older than its freshness window,
	// exactly as `verifyCallback` does.
	var attempts int32
	var accepted bool
	clock := time.Unix(1_700_000_000, 0)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		ts, _ := strconv.ParseInt(r.Header.Get(headerTimestamp), 10, 64)
		if age := clock.Unix() - ts; age > freshnessSec {
			t.Errorf("attempt %d arrived with a stale timestamp (age %ds) — Cortex would hard-cancel the run", n, age)
		}
		// The ingress is down for the first ten attempts; by then far more than
		// the freshness window has elapsed.
		if n <= 10 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		accepted = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	// Each backoff advances the shared clock by a full minute, so by attempt 11
	// the exec finished ~10 minutes ago — twice the freshness window.
	c.sleep = func(context.Context, time.Duration) { clock = clock.Add(time.Minute) }
	c.now = func() time.Time { return clock }

	if err := c.post(context.Background(), callbackKindComplete, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if !accepted {
		t.Fatalf("completion never accepted")
	}
	if elapsed := clock.Unix() - 1_700_000_000; elapsed <= freshnessSec {
		t.Fatalf("test did not actually cross the freshness window (elapsed %ds)", elapsed)
	}
}

func TestCallbackClient_GivesUpOn4xx(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(context.Context, time.Duration) {}
	err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`))
	if err == nil || !strings.Contains(err.Error(), "giveup") {
		t.Fatalf("expected giveup error, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("expected 1 attempt on 4xx, got %d", got)
	}
}

func TestCallbackClient_RetriesOnNetworkError(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(context.Context, time.Duration) {}
	if err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("expected success after network retry, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
}

func TestCallbackClient_SecretNotInRequest(t *testing.T) {
	secret := []byte("topsecret-do-not-leak")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), string(secret)) {
			t.Errorf("secret leaked in request body")
		}
		for k, vals := range r.Header {
			for _, v := range vals {
				if strings.Contains(v, string(secret)) {
					t.Errorf("secret leaked in header %s", k)
				}
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, secret)
	c.sleep = func(context.Context, time.Duration) {}
	if err := c.post(context.Background(), callbackKindComplete, "x1", []byte(`{"exitCode":0}`)); err != nil {
		t.Fatalf("post failed: %v", err)
	}
}

func TestCallbackClient_BackoffGrows(t *testing.T) {
	var sleeps []time.Duration
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(_ context.Context, d time.Duration) { sleeps = append(sleeps, d) }
	if err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if len(sleeps) < 2 {
		t.Fatalf("expected at least 2 sleeps, got %d", len(sleeps))
	}
	if sleeps[0] != callbackBackoffBase {
		t.Fatalf("expected first sleep %v, got %v", callbackBackoffBase, sleeps[0])
	}
	if sleeps[1] != callbackBackoffBase*2 {
		t.Fatalf("expected second sleep %v, got %v", callbackBackoffBase*2, sleeps[1])
	}
}
