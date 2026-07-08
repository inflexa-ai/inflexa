package main

import (
	"testing"
	"time"
)

func TestExecTable_ReserveInsertsRunningEntry(t *testing.T) {
	tbl := newExecTable()
	status, isNew := tbl.reserve("x1")
	if !isNew {
		t.Fatalf("expected isNew=true on first reserve")
	}
	if status != execStatusRunning {
		t.Fatalf("expected status running, got %q", status)
	}
	if tbl.size() != 1 {
		t.Fatalf("expected size=1, got %d", tbl.size())
	}
}

func TestExecTable_ReserveDuplicateReturnsRunningStatus(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	status, isNew := tbl.reserve("x1")
	if isNew {
		t.Fatalf("expected isNew=false on duplicate reserve")
	}
	if status != execStatusRunning {
		t.Fatalf("expected duplicate reserve to return running, got %q", status)
	}
	if tbl.size() != 1 {
		t.Fatalf("expected size=1, got %d", tbl.size())
	}
}

func TestExecTable_ReserveDuplicateAfterCompletionReturnsCompletedStatus(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	tbl.complete("x1", execStatusCompleted, &execResult{ExitCode: 0})
	status, isNew := tbl.reserve("x1")
	if isNew {
		t.Fatalf("expected isNew=false on duplicate reserve")
	}
	if status != execStatusCompleted {
		t.Fatalf("expected completed status, got %q", status)
	}
}

func TestExecTable_GetReturnsRunningState(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	st, ok := tbl.get("x1")
	if !ok {
		t.Fatalf("expected get to find x1")
	}
	if st.Status != execStatusRunning {
		t.Fatalf("expected running, got %q", st.Status)
	}
}

func TestExecTable_CompleteTransitions(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	if !tbl.complete("x1", execStatusCompleted, &execResult{ExitCode: 0}) {
		t.Fatalf("expected complete to succeed")
	}
	st, _ := tbl.get("x1")
	if st.Status != execStatusCompleted {
		t.Fatalf("expected completed, got %q", st.Status)
	}
	if st.Result == nil || st.Result.ExitCode != 0 {
		t.Fatalf("expected stored result exitCode=0")
	}
}

func TestExecTable_CompletionPostClaimedOnlyOnce(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	tbl.complete("x1", execStatusCompleted, &execResult{})
	if !tbl.claimCompletionPost("x1") {
		t.Fatalf("expected first claimCompletionPost to return true")
	}
	if tbl.claimCompletionPost("x1") {
		t.Fatalf("expected second claimCompletionPost to return false")
	}
}

// A claim released after a failed delivery must be re-claimable: latching it
// permanently would mark the completion delivered when it never was.
func TestExecTable_ReleasedCompletionClaimIsReclaimable(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	tbl.complete("x1", execStatusCompleted, &execResult{})

	if !tbl.claimCompletionPost("x1") {
		t.Fatalf("expected first claim to succeed")
	}
	tbl.releaseCompletionPost("x1")
	if !tbl.claimCompletionPost("x1") {
		t.Fatalf("expected claim to succeed again after release")
	}
}

func TestExecTable_CompletionSnapshot(t *testing.T) {
	tbl := newExecTable()

	if _, _, ok := tbl.completionSnapshot("missing"); ok {
		t.Fatalf("expected unknown execId to report not-found")
	}

	tbl.reserve("x1")
	status, body, ok := tbl.completionSnapshot("x1")
	if !ok || status != execStatusRunning || body != nil {
		t.Fatalf("expected running entry with no body, got ok=%v status=%q body=%v", ok, status, body)
	}

	tbl.complete("x1", execStatusCompleted, &execResult{ExitCode: 0})
	tbl.setCompletionBody("x1", []byte(`{"execId":"x1","exitCode":0}`))

	status, body, ok = tbl.completionSnapshot("x1")
	if !ok || status != execStatusCompleted {
		t.Fatalf("expected completed entry, got ok=%v status=%q", ok, status)
	}
	if string(body) != `{"execId":"x1","exitCode":0}` {
		t.Fatalf("completion body not served verbatim: %s", body)
	}

	// The snapshot must be a copy — a caller mutating it cannot corrupt the entry
	// that later pulls will serve.
	body[0] = 'X'
	_, again, _ := tbl.completionSnapshot("x1")
	if string(again) != `{"execId":"x1","exitCode":0}` {
		t.Fatalf("snapshot aliased the stored body: %s", again)
	}
}

func TestExecTable_TTLEvictionRemovesTerminalEntries(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	tbl := &execTable{entries: map[string]*execState{}, now: func() time.Time { return base }}

	tbl.reserve("done")
	tbl.complete("done", execStatusCompleted, &execResult{})

	tbl.reserve("running")

	tbl.now = func() time.Time { return base.Add(2 * time.Hour) }
	removed := tbl.evictExpired(time.Hour)
	if removed != 1 {
		t.Fatalf("expected 1 eviction, got %d", removed)
	}
	if _, ok := tbl.get("done"); ok {
		t.Fatalf("expected done entry evicted")
	}
	if _, ok := tbl.get("running"); !ok {
		t.Fatalf("expected running entry preserved")
	}
}
