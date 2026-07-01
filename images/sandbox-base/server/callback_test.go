package main

import (
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
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

func TestCallbackClient_RetriesOn500WithSameSignature(t *testing.T) {
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
		if r.Header.Get(headerSignature) != firstSig {
			t.Errorf("signature changed across retries")
		}
		if r.Header.Get(headerTimestamp) != firstTs {
			t.Errorf("timestamp changed across retries")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newCallbackClient(srv.URL, []byte("s"))
	c.sleep = func(context.Context, time.Duration) {}
	if err := c.post(context.Background(), callbackKindEvent, "x1", []byte(`{}`)); err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
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
