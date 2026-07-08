package main

import (
	"encoding/json"
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

// eventRingCapacity bounds the per-exec progress-event ring in poll mode. A
// chatty exec between polls must not grow the table without limit; on overflow
// the oldest event is dropped and a sticky `truncated` marker is set so a poll
// response can signal that earlier events were shed. Sized generously: progress
// events are coalesced on-change, so an exec rarely emits hundreds between two
// polls even at the host's slowest poll cadence, and the terminal result — not
// the event stream — is the authoritative outcome.
const eventRingCapacity = 256

type execResult struct {
	ExitCode   int    `json:"exitCode"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

// ringEvent is one buffered progress event: the exact event-payload bytes plus
// the monotonic per-exec sequence number that serves as the poll cursor.
type ringEvent struct {
	Seq     int64           `json:"seq"`
	Payload json.RawMessage `json:"payload"`
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
	// Poll-mode event ring: bounded, drop-oldest. `eventSeq` is the high-water
	// sequence (also the poll cursor); `truncated` latches once the ring sheds
	// an event.
	events    []ringEvent
	eventSeq  int64
	truncated bool
}

// pollSnapshot is the atomic view `GET /exec/{execId}?since={cursor}` serves in
// poll mode: the exec status, the events newer than the caller's cursor, the new
// high-water cursor, whether events were ever shed, and the terminal completion
// body (nil while running).
type pollSnapshot struct {
	status    execStatus
	events    []ringEvent
	cursor    int64
	truncated bool
	body      []byte
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

// appendEvent buffers one progress-event payload in the exec's ring (poll
// mode), assigning it the next sequence number. On overflow it drops the oldest
// event and latches `truncated`. A copy of the payload is retained so the
// caller may reuse its buffer.
func (t *execTable) appendEvent(execID string, payload []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.entries[execID]
	if !ok {
		return
	}
	st.eventSeq++
	buf := make(json.RawMessage, len(payload))
	copy(buf, payload)
	st.events = append(st.events, ringEvent{Seq: st.eventSeq, Payload: buf})
	if len(st.events) > eventRingCapacity {
		st.events = st.events[len(st.events)-eventRingCapacity:]
		st.truncated = true
	}
}

// pollSnapshotFor copies out the poll view for execID: events with Seq > since,
// the high-water cursor, the sticky truncated flag, and the terminal completion
// body (nil while running). Copying under the lock keeps the handler off the
// live entry, which the exec's own goroutine mutates.
func (t *execTable) pollSnapshotFor(execID string, since int64) (pollSnapshot, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, found := t.entries[execID]
	if !found {
		return pollSnapshot{}, false
	}
	snap := pollSnapshot{status: st.Status, cursor: st.eventSeq, truncated: st.truncated}
	for _, ev := range st.events {
		if ev.Seq <= since {
			continue
		}
		buf := make(json.RawMessage, len(ev.Payload))
		copy(buf, ev.Payload)
		snap.events = append(snap.events, ringEvent{Seq: ev.Seq, Payload: buf})
	}
	if st.CompletionBody != nil {
		out := make([]byte, len(st.CompletionBody))
		copy(out, st.CompletionBody)
		snap.body = out
	}
	return snap, true
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
