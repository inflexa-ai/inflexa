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

// eventRingCapacity bounds the per-exec progress-event ring. A
// chatty exec between polls must not grow the table without limit; on overflow
// the oldest event is dropped and a sticky `truncated` marker is set so a poll
// response can signal that earlier events were shed. Sized generously: progress
// events are coalesced on-change, so an exec rarely emits hundreds between two
// polls even at the host's slowest poll cadence, and the terminal result — not
// the event stream — is the authoritative outcome.
const eventRingCapacity = 256

type execResult struct {
	ExitCode         int    `json:"exitCode"`
	Stdout           string `json:"stdout"`
	Stderr           string `json:"stderr"`
	StdoutTruncated  bool   `json:"stdoutTruncated,omitempty"`
	StderrTruncated  bool   `json:"stderrTruncated,omitempty"`
	StdoutTotalBytes int64  `json:"stdoutTotalBytes,omitempty"`
	StderrTotalBytes int64  `json:"stderrTotalBytes,omitempty"`
	DurationMs       int64  `json:"durationMs"`
	TimedOut         bool   `json:"timedOut,omitempty"`
	// Usage is the kernel accounting of the exec. Nil when the command never
	// spawned, and on a platform that reports no rusage.
	Usage *resourceUsage `json:"usage,omitempty"`
}

// ringEvent is one buffered progress event: the exact event-payload bytes plus
// the monotonic per-exec sequence number that serves as the poll cursor.
type ringEvent struct {
	Seq     int64           `json:"seq"`
	Payload json.RawMessage `json:"payload"`
}

type execState struct {
	ExecID    string
	Status    execStatus
	PID       int
	StartedAt time.Time
	Result    *execResult
	// CompletionBody is the exact completion JSON, kept so `GET /exec/{execId}`
	// can serve it verbatim as `result`. Serving the same bytes — not a
	// re-marshalled `Result` — is what lets the served result carry the
	// provenance frame, which `execResult` does not model.
	CompletionBody []byte
	// Event ring: bounded, drop-oldest. `eventSeq` is the high-water sequence
	// (also the poll cursor); `truncated` latches once the ring sheds an event.
	events    []ringEvent
	eventSeq  int64
	truncated bool
}

// pollSnapshot is the atomic view `GET /exec/{execId}?since={cursor}` serves:
// the exec status, the events newer than the caller's cursor, the new
// high-water cursor, whether events were ever shed, and the terminal completion
// body (nil while running).
type pollSnapshot struct {
	status    execStatus
	events    []ringEvent
	cursor    int64
	truncated bool
	body      []byte
}

// execTable keeps each entry for the life of the process: a recovered host step
// submits the same execId again, and it must find the entry, not run the
// command a second time.
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
	return true
}

// setCompletionBody records the exact completion bytes that a poll serves as
// `result`.
func (t *execTable) setCompletionBody(execID string, body []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if st, ok := t.entries[execID]; ok {
		st.CompletionBody = body
	}
}

// appendEvent buffers one progress-event payload in the exec's ring,
// assigning it the next sequence number. On overflow it drops the oldest
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

func (t *execTable) size() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.entries)
}
