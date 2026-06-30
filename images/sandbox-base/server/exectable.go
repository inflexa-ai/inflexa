package main

import (
	"sync"
	"time"
)

type execStatus string

const (
	execStatusRunning   execStatus = "running"
	execStatusCompleted execStatus = "completed"
	execStatusFailed    execStatus = "failed"
)

const completedEntryTTL = time.Hour

type execResult struct {
	ExitCode   int    `json:"exitCode"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

type execState struct {
	ExecID            string
	Status            execStatus
	PID               int
	StartedAt         time.Time
	TerminalAt        time.Time
	Result            *execResult
	CompletionPosted  bool
}

type execTable struct {
	mu      sync.RWMutex
	entries map[string]*execState
	now     func() time.Time
}

func newExecTable() *execTable {
	return &execTable{
		entries: make(map[string]*execState),
		now:     time.Now,
	}
}

// reserve inserts a new running entry for execId. Returns (statusSnapshot, isNew).
// On dedup the snapshot reflects the existing entry's status at call time.
func (t *execTable) reserve(execID string) (execStatus, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if existing, ok := t.entries[execID]; ok {
		return existing.Status, false
	}
	st := &execState{
		ExecID:    execID,
		Status:    execStatusRunning,
		StartedAt: t.now(),
	}
	t.entries[execID] = st
	return execStatusRunning, true
}

func (t *execTable) get(execID string) (*execState, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, ok := t.entries[execID]
	return st, ok
}

// setPID records the spawned PID for a running entry.
func (t *execTable) setPID(execID string, pid int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.entries[execID]; ok {
		st.PID = pid
	}
}

// complete transitions the entry to a terminal status with the final result.
// Returns false if execId is unknown.
func (t *execTable) complete(execID string, status execStatus, result *execResult) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.entries[execID]
	if !ok {
		return false
	}
	st.Status = status
	st.Result = result
	st.TerminalAt = t.now()
	return true
}

// markCompletionPosted sets the at-most-once completion flag. Returns true if
// the caller is the first to set it (i.e., should post); false if already set.
func (t *execTable) markCompletionPosted(execID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.entries[execID]
	if !ok {
		return false
	}
	if st.CompletionPosted {
		return false
	}
	st.CompletionPosted = true
	return true
}

// evictExpired removes terminal entries older than ttl.
func (t *execTable) evictExpired(ttl time.Duration) int {
	cutoff := t.now().Add(-ttl)
	t.mu.Lock()
	defer t.mu.Unlock()
	removed := 0
	for id, st := range t.entries {
		if st.Status == execStatusRunning {
			continue
		}
		if st.TerminalAt.Before(cutoff) {
			delete(t.entries, id)
			removed++
		}
	}
	return removed
}

func (t *execTable) size() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.entries)
}

// startTTLSweeper runs a background goroutine that evicts terminal entries
// every `interval`. Returns a stop function.
func (t *execTable) startTTLSweeper(interval, ttl time.Duration) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				t.evictExpired(ttl)
			}
		}
	}()
	return func() { close(stop) }
}
