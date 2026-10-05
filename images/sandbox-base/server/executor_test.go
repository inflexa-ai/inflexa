package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func newTestExecutor(t *testing.T) *executor {
	t.Helper()
	return newExecutor(newExecTable(), newProcessTable())
}

func submit(t *testing.T, exe *executor, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal the submit body: %v", err)
	}
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

// waitForCompletion waits until the exec table holds the completion of execID,
// and returns the poll snapshot that carries it.
func waitForCompletion(t *testing.T, exe *executor, execID string, timeout time.Duration) pollSnapshot {
	t.Helper()
	var snap pollSnapshot
	waitFor(t, func() bool {
		s, ok := exe.table.pollSnapshotFor(execID, 0)
		snap = s
		return ok && s.body != nil
	}, timeout)
	return snap
}

func completionOf(t *testing.T, snap pollSnapshot) completionPayload {
	t.Helper()
	var p completionPayload
	if err := json.Unmarshal(snap.body, &p); err != nil {
		t.Fatalf("completion did not parse: %v", err)
	}
	return p
}

func TestExecHandler_RejectsMissingExecID(t *testing.T) {
	exe := newTestExecutor(t)

	rw := submit(t, exe, map[string]any{"command": []string{"echo", "hi"}})
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_RejectsMissingCommand(t *testing.T) {
	exe := newTestExecutor(t)

	rw := submit(t, exe, map[string]any{"execId": "x1"})
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_RejectsMalformedJSON(t *testing.T) {
	exe := newTestExecutor(t)

	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader([]byte("{not json")))
	rw := httptest.NewRecorder()
	exe.handle(rw, req)
	if rw.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rw.Code)
	}
}

func TestExecHandler_SubmitReturns202BeforeExit(t *testing.T) {
	exe := newTestExecutor(t)

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
	waitForCompletion(t, exe, "x1", 3*time.Second)
}

func TestExecHandler_DedupReturns202WithExistingStateNoDoubleSpawn(t *testing.T) {
	exe := newTestExecutor(t)

	marker := filepath.Join(t.TempDir(), "runs")
	command := []string{"sh", "-c", "echo run >> '" + marker + "'; sleep 0.3"}
	rw1 := submit(t, exe, map[string]any{"command": command, "execId": "dup"})
	rw2 := submit(t, exe, map[string]any{"command": command, "execId": "dup"})

	if rw1.Code != http.StatusAccepted || rw2.Code != http.StatusAccepted {
		t.Fatalf("expected both 202, got %d / %d", rw1.Code, rw2.Code)
	}
	waitForCompletion(t, exe, "dup", 3*time.Second)
	time.Sleep(100 * time.Millisecond) // allow any second run to write its marker

	runs, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the run marker: %v", err)
	}
	if got := strings.Count(string(runs), "run\n"); got != 1 {
		t.Fatalf("expected exactly 1 run (dedup), got %d", got)
	}
}

func TestExecHandler_CompletionCarriesExitCodeAndOutput(t *testing.T) {
	exe := newTestExecutor(t)

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "echo out; echo err 1>&2; exit 0"},
		"execId":  "ok",
	})
	p := completionOf(t, waitForCompletion(t, exe, "ok", 3*time.Second))
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
	exe := newTestExecutor(t)

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "exit 7"},
		"execId":  "fail",
	})
	p := completionOf(t, waitForCompletion(t, exe, "fail", 3*time.Second))
	if p.ExitCode != 7 {
		t.Fatalf("expected exitCode=7, got %d", p.ExitCode)
	}
}

func TestExecHandler_SpawnFailureProducesCompletion127(t *testing.T) {
	exe := newTestExecutor(t)

	submit(t, exe, map[string]any{
		"command": []string{"this-binary-does-not-exist-xyz"},
		"execId":  "missing",
	})
	p := completionOf(t, waitForCompletion(t, exe, "missing", 3*time.Second))
	if p.ExitCode != 127 {
		t.Fatalf("expected exitCode=127, got %d", p.ExitCode)
	}
}

func TestExecHandler_TreeDiffEmitsEventOnFileCreate(t *testing.T) {
	exe := newTestExecutor(t)

	t.Setenv(envTreeDiffInterval, "50")
	cwd := t.TempDir()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "sleep 0.4; touch newfile.txt; sleep 0.4"},
		"execId":  "tree",
		"cwd":     cwd,
	})
	snap := waitForCompletion(t, exe, "tree", 5*time.Second)

	if len(snap.events) == 0 {
		t.Fatalf("expected at least one tree-diff event, got 0")
	}
	first := snap.events[0].Payload
	if !bytes.Contains(first, []byte("newfile.txt")) {
		t.Fatalf("expected event body to mention newfile.txt; got %s", first)
	}
	if !bytes.Contains(first, []byte(`"kind":"file-tree"`)) {
		t.Fatalf("expected event kind=file-tree; got %s", first)
	}
}

func TestExecHandler_NoEventsOnIdleTree(t *testing.T) {
	exe := newTestExecutor(t)

	t.Setenv(envTreeDiffInterval, "50")
	cwd := t.TempDir()

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "sleep 0.5"},
		"execId":  "idle",
		"cwd":     cwd,
	})
	snap := waitForCompletion(t, exe, "idle", 3*time.Second)

	if got := len(snap.events); got != 0 {
		t.Fatalf("expected 0 events on idle tree, got %d", got)
	}
}

func TestExecHandler_SubmittedLogDedupHitFlag(t *testing.T) {
	exe := newTestExecutor(t)

	rw1 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.2"}, "execId": "log-dup"})
	rw2 := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "sleep 0.2"}, "execId": "log-dup"})
	if rw1.Code != http.StatusAccepted || rw2.Code != http.StatusAccepted {
		t.Fatalf("expected 202 on both, got %d / %d", rw1.Code, rw2.Code)
	}
	waitForCompletion(t, exe, "log-dup", 3*time.Second)
}

// The body is buffered in full before it is parsed, so the read cap is what
// bounds a peer's memory cost. An oversized submit must be refused without
// spawning anything.
func TestExecHandler_OversizedBodyRejected(t *testing.T) {
	exe := newTestExecutor(t)

	pad := strings.Repeat("a", maxExecBodyBytes)
	body, err := json.Marshal(map[string]any{
		"command": []string{"true"},
		"execId":  "oversized",
		"env":     map[string]string{"PAD": pad},
	})
	if err != nil {
		t.Fatalf("marshal the submit body: %v", err)
	}
	if len(body) <= maxExecBodyBytes {
		t.Fatalf("test body does not exceed the cap: %d <= %d", len(body), maxExecBodyBytes)
	}
	req := httptest.NewRequest(http.MethodPost, "/exec", bytes.NewReader(body))
	rw := httptest.NewRecorder()
	exe.handle(rw, req)

	if rw.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for an oversized submit, got %d", rw.Code)
	}
	if _, ok := exe.table.pollSnapshotFor("oversized", 0); ok {
		t.Fatalf("an oversized submit still reached the exec table")
	}
}

// The completion payload of a real exec must carry the kernel accounting the
// host sizes its sandboxes from. A peak of zero, or an absent frame, means the
// `wait4` rusage did not reach the executor and the whole measurement is dead.
func TestExecCompletion_CarriesResourceUsage(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the server reports a resource-usage frame only on Linux")
	}
	exe := newTestExecutor(t)

	// A shell arithmetic loop burns CPU the accounting can see, and the shell
	// itself holds a resident set, so both members must come back positive.
	submit(t, exe, map[string]any{
		"command": []string{"i=0; while [ $i -lt 50000 ]; do i=$((i+1)); done"},
		"execId":  "usage-1",
	})
	payload := completionOf(t, waitForCompletion(t, exe, "usage-1", 30*time.Second))
	if payload.Usage == nil {
		t.Fatalf("completion carries no usage frame")
	}
	if payload.Usage.PeakMemoryBytes <= 0 {
		t.Errorf("peak memory is %d bytes; the rusage high-water mark did not reach the payload", payload.Usage.PeakMemoryBytes)
	}
	if payload.Usage.CPUMillis <= 0 {
		t.Errorf("cpu time is %d ms; a 50000-iteration shell loop must burn more than that", payload.Usage.CPUMillis)
	}
}

// A command that never spawns has no accounting. The frame must be absent
// rather than a zeroed frame, which the host would record as a real
// measurement of a sandbox that ran nothing.
func TestExecCompletion_OmitsResourceUsageWhenNothingSpawned(t *testing.T) {
	exe := newTestExecutor(t)

	submit(t, exe, map[string]any{
		// Multi-element, thus `execve` runs directly and `Start` fails; a
		// single-element command would go through `sh -c` and the shell itself
		// would spawn.
		"command": []string{"/nonexistent/binary", "--x"},
		"execId":  "usage-2",
	})
	body := waitForCompletion(t, exe, "usage-2", 30*time.Second).body
	if strings.Contains(string(body), `"usage"`) {
		t.Fatalf("a failed spawn reported a usage frame: %s", body)
	}
}
