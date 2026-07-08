package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testExecID = "wf-1:step-a:3"

func newResultServer(t *testing.T, secret []byte) (*execTable, http.HandlerFunc) {
	t.Helper()
	table := newExecTable()
	return table, execSubtreeHandler(newProcessTable(), table, secret)
}

func getResult(h http.HandlerFunc, execID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/exec/"+execID, nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestExecResult_UnknownExecIdIs404(t *testing.T) {
	_, h := newResultServer(t, []byte("s"))
	if rec := getResult(h, "never-submitted"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown execId, got %d", rec.Code)
	}
}

func TestExecResult_RunningExecReportsRunningWithoutSignature(t *testing.T) {
	table, h := newResultServer(t, []byte("s"))
	table.reserve(testExecID)

	rec := getResult(h, testExecID)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Header().Get(headerSignature) != "" {
		t.Fatalf("a running exec must not be signed — there is nothing to attest")
	}
	if body := rec.Body.String(); body == "" || !strings.Contains(body, `"status":"running"`) {
		t.Fatalf("expected running status, got %s", body)
	}
}

// The completion has landed in the table but `setCompletionBody` has not run
// yet. Reporting `completed` with no body would hand the caller nothing to
// verify; it must read as still-running so the caller retries.
func TestExecResult_TerminalWithoutBodyReportsRunning(t *testing.T) {
	table, h := newResultServer(t, []byte("s"))
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{ExitCode: 0})

	rec := getResult(h, testExecID)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"running"`) {
		t.Fatalf("expected running, got %d %s", rec.Code, rec.Body.String())
	}
}

// The pulled bytes must be the exact bytes the push callback carries. Anything
// re-marshalled here would drop the provenance frame, which `execResult` does
// not model — and provenance is the whole point of observing the exec.
func TestExecResult_ServesCompletionBodyVerbatimWithFreshSignature(t *testing.T) {
	secret := []byte("topsecret")
	table, h := newResultServer(t, secret)

	body := []byte(`{"execId":"wf-1:step-a:3","exitCode":0,"provenance":{"reads":[{"path":"/in.csv"}]}}`)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{ExitCode: 0})
	table.setCompletionBody(testExecID, body)

	before := time.Now().Unix()
	rec := getResult(h, testExecID)
	after := time.Now().Unix()

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if rec.Body.String() != string(body) {
		t.Fatalf("body not served verbatim:\n got %s\nwant %s", rec.Body.String(), body)
	}
	if !strings.Contains(rec.Body.String(), `"provenance"`) {
		t.Fatalf("provenance frame lost on the pull path")
	}

	ts, err := strconv.ParseInt(rec.Header().Get(headerTimestamp), 10, 64)
	if err != nil {
		t.Fatalf("unparseable timestamp header: %v", err)
	}
	if ts < before || ts > after {
		t.Fatalf("timestamp %d is not request-time (expected within [%d,%d])", ts, before, after)
	}
	if want := signCallback(secret, testExecID, ts, body); rec.Header().Get(headerSignature) != want {
		t.Fatalf("signature does not verify against (execId, ts, body)")
	}
}

// The signature is minted per request, so a result fetched hours after the exec
// ended still lands inside Cortex's freshness window. That is what makes the
// pull path a recovery path rather than a second way to fail.
func TestExecResult_SignatureIsFreshOnEveryFetch(t *testing.T) {
	secret := []byte("topsecret")
	table, h := newResultServer(t, secret)

	body := []byte(`{"execId":"wf-1:step-a:3","exitCode":0}`)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, body)

	first := getResult(h, testExecID)
	time.Sleep(1100 * time.Millisecond)
	second := getResult(h, testExecID)

	if first.Header().Get(headerTimestamp) == second.Header().Get(headerTimestamp) {
		t.Fatalf("timestamp did not advance between fetches")
	}
	if first.Header().Get(headerSignature) == second.Header().Get(headerSignature) {
		t.Fatalf("signature was reused across fetches — it is not request-time fresh")
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("body changed between fetches")
	}
}

func TestExecResult_RejectsNonGet(t *testing.T) {
	table, h := newResultServer(t, []byte("s"))
	table.reserve(testExecID)

	req := httptest.NewRequest(http.MethodPut, "/exec/"+testExecID, nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// `/exec/{execId}` and `/exec/{pid}/kill` share a prefix. An execId carries
// colons but never slashes, so segment count separates them.
func TestExecSubtree_RoutesKillAndResultApart(t *testing.T) {
	table, h := newResultServer(t, []byte("s"))
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, []byte(`{"exitCode":0}`))

	// Two segments + GET → the result route, colons and all.
	if rec := getResult(h, testExecID); rec.Code != http.StatusOK || rec.Header().Get(headerSignature) == "" {
		t.Fatalf("colon-bearing execId did not reach the result route: %d", rec.Code)
	}

	// Three segments ending in `kill` + POST → the kill route, which 404s on an
	// unknown pid rather than falling through to the result handler.
	req := httptest.NewRequest(http.MethodPost, "/exec/99999/kill", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected kill route (404 unknown pid), got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "process not found") {
		t.Fatalf("kill route not reached: %s", rec.Body.String())
	}

	// Anything else is a client error, not a silent match.
	req = httptest.NewRequest(http.MethodGet, "/exec/a/b/c/d", nil)
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an unroutable path, got %d", rec.Code)
	}
}
