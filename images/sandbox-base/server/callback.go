package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

type callbackKind string

const (
	callbackKindEvent    callbackKind = "event"
	callbackKindComplete callbackKind = "complete"
)

const (
	headerSignature = "X-Sandbox-Signature"
	headerTimestamp = "X-Sandbox-Timestamp"

	callbackBackoffBase = 250 * time.Millisecond
	callbackBackoffCap  = 30 * time.Second
	callbackHTTPTimeout = 15 * time.Second
)

type callbackClient struct {
	baseURL string
	secret  []byte
	httpClient *http.Client
	now     func() time.Time
	sleep   func(context.Context, time.Duration)
}

func newCallbackClient(baseURL string, secret []byte) *callbackClient {
	return &callbackClient{
		baseURL: baseURL,
		secret:  secret,
		httpClient: &http.Client{Timeout: callbackHTTPTimeout},
		now:     time.Now,
		sleep:   sleepCtx,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// signCallback returns the X-Sandbox-Signature value for the (execId, ts, body) tuple.
func signCallback(secret []byte, execID string, ts int64, body []byte) string {
	bodyHash := sha256.Sum256(body)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(fmt.Sprintf("%s:%d:%s", execID, ts, hex.EncodeToString(bodyHash[:]))))
	return hex.EncodeToString(mac.Sum(nil))
}

// errCallbackGiveup signals a non-retryable 4xx response.
var errCallbackGiveup = errors.New("callback giveup (4xx)")

// post sends a signed callback with exponential backoff retry until 2xx or
// context cancellation.
//
// Every attempt is signed afresh. Cortex verifies the timestamp against a
// symmetric freshness window (`DEFAULT_FRESHNESS_SECONDS`, 300s, in
// harness/src/sandbox/await-exec.ts) and treats a stale timestamp as a hard
// cancel, not a retryable condition. Minting the timestamp once outside this
// loop would therefore mean that any delivery delayed past that window — an
// ingress that was down for six minutes, say — could never be accepted again,
// no matter how long the retries continued. The signature must age with the
// attempt, not with the result.
func (c *callbackClient) post(ctx context.Context, kind callbackKind, execID string, body []byte) error {
	url := fmt.Sprintf("%s/sandbox/%s/%s", c.baseURL, execID, kind)

	attempt := 0
	backoff := callbackBackoffBase
	for {
		attempt++
		ts := c.now().Unix()
		sig := signCallback(c.secret, execID, ts, body)
		start := c.now()
		status, err := c.send(ctx, url, body, ts, sig)
		dur := c.now().Sub(start).Milliseconds()

		if status >= 200 && status < 300 {
			emitLog(callbackLog{
				Level: "info", Time: nowRFC3339(), Event: callbackEvent(kind, true),
				ExecID: execID, Attempt: attempt, StatusCode: status, DurationMs: dur,
			})
			return nil
		}

		retryable := isRetryable(status, err)
		level := "warn"
		if !retryable {
			level = "error"
		}
		errStr := ""
		if err != nil {
			errStr = err.Error()
		}
		emitLog(callbackLog{
			Level: level, Time: nowRFC3339(), Event: callbackEvent(kind, false),
			ExecID: execID, Attempt: attempt, StatusCode: status, Error: errStr, DurationMs: dur,
		})

		if !retryable {
			return errCallbackGiveup
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}

		c.sleep(ctx, backoff)
		backoff *= 2
		if backoff > callbackBackoffCap {
			backoff = callbackBackoffCap
		}
	}
}

func isRetryable(status int, err error) bool {
	if err != nil {
		return true
	}
	if status >= 500 && status < 600 {
		return true
	}
	if status >= 400 && status < 500 {
		return false
	}
	return false
}

func (c *callbackClient) send(ctx context.Context, url string, body []byte, ts int64, sig string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerSignature, sig)
	req.Header.Set(headerTimestamp, strconv.FormatInt(ts, 10))

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// callbackLog is the per-attempt structured log line.
type callbackLog struct {
	Level      string `json:"level"`
	Time       string `json:"time"`
	Event      string `json:"event"`
	ExecID     string `json:"exec_id"`
	Attempt    int    `json:"attempt"`
	StatusCode int    `json:"status_code,omitempty"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"duration_ms"`
}

func callbackEvent(kind callbackKind, delivered bool) string {
	suffix := "attempt"
	if delivered {
		suffix = "delivered"
	}
	return fmt.Sprintf("callback.%s.%s", kind, suffix)
}
