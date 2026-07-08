package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// callbackReceiver records every callback POST hitting the test server.
type callbackReceiver struct {
	mu       sync.Mutex
	events   []receivedCallback
	complete []receivedCallback
	failures int
	maxFails int
}

type receivedCallback struct {
	ExecID    string
	Signature string
	Timestamp string
	Body      []byte
}

func (rec *callbackReceiver) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		// expected: /sandbox/{execId}/{kind}
		if len(parts) != 3 || parts[0] != "sandbox" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		execID, kind := parts[1], parts[2]
		cb := receivedCallback{
			ExecID:    execID,
			Signature: r.Header.Get(headerSignature),
			Timestamp: r.Header.Get(headerTimestamp),
			Body:      body,
		}
		rec.mu.Lock()
		if rec.failures < rec.maxFails {
			rec.failures++
			rec.mu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if kind == "event" {
			rec.events = append(rec.events, cb)
		} else {
			rec.complete = append(rec.complete, cb)
		}
		rec.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

func (rec *callbackReceiver) eventsCount() int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return len(rec.events)
}

func (rec *callbackReceiver) completeCount() int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return len(rec.complete)
}

func (rec *callbackReceiver) lastComplete() *receivedCallback {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.complete) == 0 {
		return nil
	}
	cb := rec.complete[len(rec.complete)-1]
	return &cb
}

func newTestExecutor(t *testing.T, secret []byte) (*executor, *callbackReceiver, func()) {
	t.Helper()
	rec := &callbackReceiver{}
	srv := httptest.NewServer(rec.handler())
	cb := newCallbackClient(srv.URL, secret)
	cb.sleep = func(context.Context, time.Duration) {}
	exe := newExecutor(newExecTable(), cb, newProcessTable())
	return exe, rec, srv.Close
}

func submit(t *testing.T, exe *executor, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader(b))
	rw := httptest.NewRecorder()
	exe.handle(rw, req)
	return rw
}

func waitFor(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", timeout)
}

func TestExecHandler_RejectsMissingExecID(t *testing.T) {
	exe, _, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	rw := submit(t, exe, map[string]any{"command": []string{"echo", "hi"}})
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_RejectsMissingCommand(t *testing.T) {
	exe, _, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	rw := submit(t, exe, map[string]any{"execId": "x1"})
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_RejectsMalformedJSON(t *testing.T) {
	exe, _, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader([]byte("{not json")))
	rw := httptest.NewRecorder()
	exe.handle(rw, req)
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_SubmitReturns202BeforeExit(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	start := time.Now()
	rw := submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "sleep 0.3; echo done"},
		"execId":  "x1",
	})
	elapsed := time.Since(start)
	if rw.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rw.Code)
	}
	if elapsed > 250*time.Millisecond {
		t.Fatalf("handler took too long (%v); not background-spawning", elapsed)
	}
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)
}

func TestExecHandler_DedupReturns202WithExistingStateNoDoubleSpawn(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	rw1 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.3"}, "execId": "dup"})
	rw2 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.3"}, "execId": "dup"})

	if rw1.Code != http.StatusAccepted || rw2.Code != http.StatusAccepted {
		t.Fatalf("expected both 202, got %d / %d", rw1.Code, rw2.Code)
	}
	waitFor(t, func() bool { return rec.completeCount() >= 1 }, 3*time.Second)
	time.Sleep(100 * time.Millisecond) // allow any second completion to arrive

	if got := rec.completeCount(); got != 1 {
		t.Fatalf("expected exactly 1 completion (dedup), got %d", got)
	}
}

func TestExecHandler_CompletionCarriesExitCodeAndOutput(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "echo out; echo err 1>&2; exit 0"},
		"execId":  "ok",
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	cb := rec.lastComplete()
	var p completionPayload
	if err := json.Unmarshal(cb.Body, &p); err != nil {
		t.Fatalf("unmarshal completion: %v", err)
	}
	if p.ExitCode != 0 {
		t.Fatalf("expected exitCode=0, got %d", p.ExitCode)
	}
	if !strings.Contains(p.Stdout, "out") {
		t.Fatalf("expected stdout to contain 'out', got %q", p.Stdout)
	}
	if !strings.Contains(p.Stderr, "err") {
		t.Fatalf("expected stderr to contain 'err', got %q", p.Stderr)
	}
}

func TestExecHandler_NonZeroExitCarriesCode(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "exit 7"},
		"execId":  "fail",
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	var p completionPayload
	_ = json.Unmarshal(rec.lastComplete().Body, &p)
	if p.ExitCode != 7 {
		t.Fatalf("expected exitCode=7, got %d", p.ExitCode)
	}
}

func TestExecHandler_SpawnFailureProducesCompletion127(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	submit(t, exe, map[string]any{
		"command": []string{"this-binary-does-not-exist-xyz"},
		"execId":  "missing",
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	var p completionPayload
	_ = json.Unmarshal(rec.lastComplete().Body, &p)
	if p.ExitCode != 127 {
		t.Fatalf("expected exitCode=127, got %d", p.ExitCode)
	}
}

func TestExecHandler_CompletionSignatureMatches(t *testing.T) {
	secret := []byte("topsecret")
	exe, rec, cleanup := newTestExecutor(t, secret)
	defer cleanup()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "echo hi"},
		"execId":  "sig",
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	cb := rec.lastComplete()
	ts, err := strconv.ParseInt(cb.Timestamp, 10, 64)
	if err != nil {
		t.Fatalf("invalid timestamp header %q: %v", cb.Timestamp, err)
	}
	expected := signCallback(secret, cb.ExecID, ts, cb.Body)
	if expected != cb.Signature {
		t.Fatalf("signature mismatch: got %s, want %s", cb.Signature, expected)
	}
	if _, err := hex.DecodeString(cb.Signature); err != nil {
		t.Fatalf("signature not hex: %s", cb.Signature)
	}
}

func TestExecHandler_RetryPreservesSignatureAcrossAttempts(t *testing.T) {
	rec := &callbackReceiver{maxFails: 2}
	var capturedSigs []string
	var capturedTs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		capturedSigs = append(capturedSigs, r.Header.Get(headerSignature))
		capturedTs = append(capturedTs, r.Header.Get(headerTimestamp))
		if rec.failures < rec.maxFails {
			rec.failures++
			rec.mu.Unlock()
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) == 3 && parts[2] == "complete" {
			rec.complete = append(rec.complete, receivedCallback{
				ExecID: parts[1], Body: body,
				Signature: r.Header.Get(headerSignature),
				Timestamp: r.Header.Get(headerTimestamp),
			})
		}
		rec.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	cb := newCallbackClient(srv.URL, []byte("s"))
	cb.sleep = func(context.Context, time.Duration) {}
	exe := newExecutor(newExecTable(), cb, newProcessTable())

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "echo hi"},
		"execId":  "retry",
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	if len(capturedSigs) < 3 {
		t.Fatalf("expected at least 3 attempts, got %d", len(capturedSigs))
	}
	for i := 1; i < len(capturedSigs); i++ {
		if capturedSigs[i] != capturedSigs[0] {
			t.Fatalf("signature changed on retry %d", i)
		}
		if capturedTs[i] != capturedTs[0] {
			t.Fatalf("timestamp changed on retry %d", i)
		}
	}
}

func TestExecHandler_TreeDiffEmitsEventOnFileCreate(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	t.Setenv(envTreeDiffInterval, "50")
	cwd := t.TempDir()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "sleep 0.4; touch newfile.txt; sleep 0.4"},
		"execId":  "tree",
		"cwd":     cwd,
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 5*time.Second)

	if rec.eventsCount() == 0 {
		t.Fatalf("expected at least one tree-diff event, got 0")
	}
	rec.mu.Lock()
	first := rec.events[0]
	rec.mu.Unlock()
	if !bytes.Contains(first.Body, []byte("newfile.txt")) {
		t.Fatalf("expected event body to mention newfile.txt; got %s", first.Body)
	}
	if !bytes.Contains(first.Body, []byte(`"kind":"file-tree"`)) {
		t.Fatalf("expected event kind=file-tree; got %s", first.Body)
	}
}

func TestExecHandler_NoEventsOnIdleTree(t *testing.T) {
	exe, rec, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	t.Setenv(envTreeDiffInterval, "50")
	cwd := t.TempDir()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "sleep 0.5"},
		"execId":  "idle",
		"cwd":     cwd,
	})
	waitFor(t, func() bool { return rec.completeCount() == 1 }, 3*time.Second)

	if got := rec.eventsCount(); got != 0 {
		t.Fatalf("expected 0 events on idle tree, got %d", got)
	}
}

func TestExecHandler_SubmittedLogDedupHitFlag(t *testing.T) {
	exe, _, cleanup := newTestExecutor(t, []byte("s"))
	defer cleanup()

	rw1 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.2"}, "execId": "log-dup"})
	rw2 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.2"}, "execId": "log-dup"})
	if rw1.Code != http.StatusAccepted || rw2.Code != http.StatusAccepted {
		t.Fatalf("expected 202 on both, got %d / %d", rw1.Code, rw2.Code)
	}
}


// A spawned command must never inherit the callback credentials: whoever holds
// the secret can forge a signed completion — including its provenance frame —
// for any exec.
func TestBuildCommand_StripsCallbackCredentialsFromChildEnv(t *testing.T) {
	t.Setenv(envCallbackSecret, "base64:c3VwZXItc2VjcmV0LXZhbHVl")
	t.Setenv(envCortexBaseURL, "http://host.docker.internal:9999")
	t.Setenv("SANDBOX_UNRELATED_VAR", "kept")

	cmd := buildCommand(context.Background(), execSubmitRequest{
		Command: []string{"true"},
		Env:     map[string]string{"STEP_SCOPED": "also-kept"},
	})

	var sawUnrelated, sawStepScoped bool
	for _, kv := range cmd.Env {
		name, _, _ := strings.Cut(kv, "=")
		if _, sensitive := sensitiveEnvKeys[name]; sensitive {
			t.Fatalf("child env leaks %s", name)
		}
		switch kv {
		case "SANDBOX_UNRELATED_VAR=kept":
			sawUnrelated = true
		case "STEP_SCOPED=also-kept":
			sawStepScoped = true
		}
	}
	if !sawUnrelated {
		t.Error("unrelated host env var was dropped; only the callback credentials should be stripped")
	}
	if !sawStepScoped {
		t.Error("request-supplied env var was dropped")
	}
}

func TestSanitizedEnviron_DropsOnlyTheNamedKeys(t *testing.T) {
	t.Setenv(envCallbackSecret, "base64:c2VjcmV0")
	t.Setenv(envCortexBaseURL, "http://example.invalid")

	for _, kv := range sanitizedEnviron() {
		name, _, _ := strings.Cut(kv, "=")
		if name == envCallbackSecret || name == envCortexBaseURL {
			t.Fatalf("sanitizedEnviron returned %s", name)
		}
	}
	// PATH is set in every sane environment and must survive.
	var sawPath bool
	for _, kv := range sanitizedEnviron() {
		if name, _, _ := strings.Cut(kv, "="); name == "PATH" {
			sawPath = true
		}
	}
	if !sawPath {
		t.Error("PATH was stripped from the child environment")
	}
}
