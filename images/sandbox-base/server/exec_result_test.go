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

// newResultServer returns the handler plus a getter that signs each GET with
// `secret`, mirroring what the harness attaches to a pull.
func newResultServer(t *testing.T, secret []byte) (*execTable, func(execID string) *httptest.ResponseRecorder) {
	t.Helper()
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	get := func(execID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/exec/"+execID, nil)
		signInbound(req, execID, nil, secret)
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}
	return table, get
}

func TestExecResult_UnknownExecIdIs404(t *testing.T) {
	_, get := newResultServer(t, []byte("s"))
	if rec := get("never-submitted"); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown execId, got %d", rec.Code)
	}
}

func TestExecResult_RunningExecReportsRunningWithoutSignature(t *testing.T) {
	table, get := newResultServer(t, []byte("s"))
	table.reserve(testExecID)

	rec := get(testExecID)
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
	table, get := newResultServer(t, []byte("s"))
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{ExitCode: 0})

	rec := get(testExecID)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"running"`) {
		t.Fatalf("expected running, got %d %s", rec.Code, rec.Body.String())
	}
}

// The pulled bytes must be the exact bytes the push callback carries. Anything
// re-marshalled here would drop the provenance frame, which `execResult` does
// not model — and provenance is the whole point of observing the exec.
func TestExecResult_ServesCompletionBodyVerbatimWithFreshSignature(t *testing.T) {
	secret := []byte("topsecret")
	table, get := newResultServer(t, secret)

	body := []byte(`{"execId":"wf-1:step-a:3","exitCode":0,"provenance":{"reads":[{"path":"/in.csv"}]}}`)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{ExitCode: 0})
	table.setCompletionBody(testExecID, body)

	before := time.Now().Unix()
	rec := get(testExecID)
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
	table, get := newResultServer(t, secret)

	body := []byte(`{"execId":"wf-1:step-a:3","exitCode":0}`)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, body)

	first := get(testExecID)
	time.Sleep(1100 * time.Millisecond)
	second := get(testExecID)

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
	table, _ := newResultServer(t, []byte("s"))
	table.reserve(testExecID)
	h := execResultHandler(table, newInboundAuth([]byte("s")))

	req := httptest.NewRequest(http.MethodPut, "/exec/"+testExecID, nil)
	signInbound(req, testExecID, nil, []byte("s"))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// The `/exec/{pid}/kill` route was retired; a colon-bearing execId reaches the
// result route, and any path with an extra slash is an unroutable 400.
func TestExecResult_RoutesExecIdAndRejectsExtraSegments(t *testing.T) {
	secret := []byte("s")
	table, get := newResultServer(t, secret)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, []byte(`{"exitCode":0}`))

	h := execResultHandler(table, newInboundAuth(secret))

	// Two segments + GET → the result route, colons and all.
	if rec := get(testExecID); rec.Code != http.StatusOK || rec.Header().Get(headerSignature) == "" {
		t.Fatalf("colon-bearing execId did not reach the result route: %d", rec.Code)
	}

	// A slash-bearing path (an old `/exec/{pid}/kill`, or anything nested) is not
	// a valid execId → 400, before any auth or table lookup.
	for _, path := range []string{"/exec/99999/kill", "/exec/a/b/c/d"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for unroutable path %q, got %d", path, rec.Code)
		}
	}
}

// The result discloses the command's stdout/stderr, so an unauthenticated fetch
// must be refused — before the table is even consulted.
func TestExecResult_RejectsUnsignedAndForgedRequests(t *testing.T) {
	secret := []byte("topsecret")
	table, _ := newResultServer(t, secret)
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, []byte(`{"execId":"wf-1:step-a:3","exitCode":0}`))
	h := execResultHandler(table, newInboundAuth(secret))

	call := func(mut func(r *http.Request)) int {
		req := httptest.NewRequest(http.MethodGet, "/exec/"+testExecID, nil)
		mut(req)
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}

	if code := call(func(*http.Request) {}); code != http.StatusUnauthorized {
		t.Fatalf("unsigned request: expected 401, got %d", code)
	}
	if code := call(func(r *http.Request) { signInbound(r, testExecID, nil, []byte("wrong-secret")) }); code != http.StatusUnauthorized {
		t.Fatalf("wrong-secret signature: expected 401, got %d", code)
	}
	// A stale timestamp is as unacceptable as a bad signature.
	if code := call(func(r *http.Request) {
		staleTs := time.Now().Unix() - (inboundFreshnessSeconds + 60)
		r.Header.Set(headerSignature, signCallback(secret, testExecID, staleTs, nil))
		r.Header.Set(headerTimestamp, strconv.FormatInt(staleTs, 10))
	}); code != http.StatusUnauthorized {
		t.Fatalf("stale timestamp: expected 401, got %d", code)
	}
	// A signature minted for a different execId must not authorise this one.
	if code := call(func(r *http.Request) { signInbound(r, "some-other-exec", nil, secret) }); code != http.StatusUnauthorized {
		t.Fatalf("cross-execId signature: expected 401, got %d", code)
	}
	// Sanity: the correctly-signed request still succeeds.
	if code := call(func(r *http.Request) { signInbound(r, testExecID, nil, secret) }); code != http.StatusOK {
		t.Fatalf("valid signature: expected 200, got %d", code)
	}
}
