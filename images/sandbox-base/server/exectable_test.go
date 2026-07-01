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

func TestExecTable_MarkCompletionPostedOnlyOnce(t *testing.T) {
	tbl := newExecTable()
	tbl.reserve("x1")
	tbl.complete("x1", execStatusCompleted, &execResult{})
	if !tbl.markCompletionPosted("x1") {
		t.Fatalf("expected first markCompletionPosted to return true")
	}
	if tbl.markCompletionPosted("x1") {
		t.Fatalf("expected second markCompletionPosted to return false")
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
