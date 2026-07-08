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
	ExecID     string
	Status     execStatus
	PID        int
	StartedAt  time.Time
	TerminalAt time.Time
	Result     *execResult
	// CompletionBody is the exact JSON the completion callback carries, kept so
	// `GET /exec/{execId}` can serve it verbatim. Serving the same bytes — not a
	// re-marshalled `Result` — is what lets a pulled completion carry the
	// provenance frame, which `execResult` does not model.
	CompletionBody   []byte
	CompletionPosted bool
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

// setCompletionBody records the exact bytes a completion callback would carry.
// Called before the POST is attempted, so a completion whose delivery never
// succeeds is still retrievable through `GET /exec/{execId}`.
func (t *execTable) setCompletionBody(execID string, body []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.entries[execID]; ok {
		st.CompletionBody = body
	}
}

// claimCompletionPost takes the at-most-once right to POST the completion.
// Returns true if the caller is the first to claim it; false if a claim is
// already outstanding or the execId is unknown.
//
// The claim must be released (see releaseCompletionPost) when delivery fails.
// Latching it permanently on a *failed* attempt would mark the completion
// delivered when it never was, stranding the result: the exec table would hold
// a terminal entry that nothing is allowed to send.
func (t *execTable) claimCompletionPost(execID string) bool {
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

// releaseCompletionPost surrenders a claim taken by claimCompletionPost.
func (t *execTable) releaseCompletionPost(execID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.entries[execID]; ok {
		st.CompletionPosted = false
	}
}

// completionSnapshot copies out the fields `GET /exec/{execId}` serves. Copying
// under the lock keeps the handler off the live entry, which the exec's own
// goroutine mutates.
func (t *execTable) completionSnapshot(execID string) (status execStatus, body []byte, ok bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, found := t.entries[execID]
	if !found {
		return "", nil, false
	}
	if st.CompletionBody == nil {
		return st.Status, nil, true
	}
	out := make([]byte, len(st.CompletionBody))
	copy(out, st.CompletionBody)
	return st.Status, out, true
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
