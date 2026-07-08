package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ── Event ring ──────────────────────────────────────────────────────

func TestEventRing_AppendAssignsIncreasingSeq(t *testing.T) {
	table := newExecTable()
	table.reserve(testExecID)
	table.appendEvent(testExecID, []byte(`{"kind":"file-tree","n":1}`))
	table.appendEvent(testExecID, []byte(`{"kind":"file-tree","n":2}`))

	snap, ok := table.pollSnapshotFor(testExecID, 0)
	if !ok {
		t.Fatal("exec missing from table")
	}
	if len(snap.events) != 2 {
		t.Fatalf("want 2 events, got %d", len(snap.events))
	}
	if snap.events[0].Seq != 1 || snap.events[1].Seq != 2 {
		t.Fatalf("sequence numbers not monotonic: %d, %d", snap.events[0].Seq, snap.events[1].Seq)
	}
	if snap.cursor != 2 {
		t.Fatalf("want high-water cursor 2, got %d", snap.cursor)
	}
	if snap.truncated {
		t.Fatal("ring should not be truncated below capacity")
	}
}

func TestEventRing_SinceReturnsOnlyNewer(t *testing.T) {
	table := newExecTable()
	table.reserve(testExecID)
	for i := 0; i < 5; i++ {
		table.appendEvent(testExecID, []byte(`{"n":`+strconv.Itoa(i)+`}`))
	}

	snap, _ := table.pollSnapshotFor(testExecID, 3)
	if len(snap.events) != 2 {
		t.Fatalf("since=3 should yield seq 4 and 5 → 2 events, got %d", len(snap.events))
	}
	if snap.events[0].Seq != 4 {
		t.Fatalf("want first returned seq 4, got %d", snap.events[0].Seq)
	}
	if snap.cursor != 5 {
		t.Fatalf("want cursor 5, got %d", snap.cursor)
	}
}

func TestEventRing_OverflowDropsOldestAndMarksTruncated(t *testing.T) {
	table := newExecTable()
	table.reserve(testExecID)
	total := eventRingCapacity + 10
	for i := 0; i < total; i++ {
		table.appendEvent(testExecID, []byte(`{}`))
	}

	snap, _ := table.pollSnapshotFor(testExecID, 0)
	if len(snap.events) != eventRingCapacity {
		t.Fatalf("ring should cap at %d events, got %d", eventRingCapacity, len(snap.events))
	}
	if !snap.truncated {
		t.Fatal("expected truncated marker after overflow")
	}
	if snap.cursor != int64(total) {
		t.Fatalf("cursor should track the high-water seq %d, got %d", total, snap.cursor)
	}
	if want := int64(total - eventRingCapacity + 1); snap.events[0].Seq != want {
		t.Fatalf("oldest retained seq should be %d, got %d", want, snap.events[0].Seq)
	}
}

// ── ?since poll handler ─────────────────────────────────────────────

func getPoll(t *testing.T, h http.HandlerFunc, execID, since string, secret []byte) *httptest.ResponseRecorder {
	t.Helper()
	// The query string is not part of the signature — only (execId, empty body).
	req := httptest.NewRequest(http.MethodGet, "/exec/"+execID+"?since="+since, nil)
	signInbound(req, execID, nil, secret)
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func decodePoll(t *testing.T, rec *httptest.ResponseRecorder, secret []byte, execID string) pollResponseBody {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body := rec.Body.Bytes()
	// A poll response is ALWAYS signed — even while running — because the host
	// verifies every poll before trusting its events.
	ts, err := strconv.ParseInt(rec.Header().Get(headerTimestamp), 10, 64)
	if err != nil {
		t.Fatalf("unparseable timestamp header: %v", err)
	}
	if want := signCallback(secret, execID, ts, body); rec.Header().Get(headerSignature) != want {
		t.Fatalf("poll body signature does not verify over (execId, ts, body)")
	}
	var resp pollResponseBody
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("poll body not valid JSON: %v", err)
	}
	return resp
}

func TestPollResult_RunningIsSignedWithEventsAndNoResult(t *testing.T) {
	secret := []byte("topsecret")
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	table.reserve(testExecID)
	table.appendEvent(testExecID, []byte(`{"kind":"file-tree","seq":1}`))
	table.appendEvent(testExecID, []byte(`{"kind":"file-tree","seq":2}`))

	resp := decodePoll(t, getPoll(t, h, testExecID, "0", secret), secret, testExecID)
	if resp.Status != string(execStatusRunning) {
		t.Fatalf("want running, got %q", resp.Status)
	}
	if len(resp.Events) != 2 {
		t.Fatalf("want 2 events, got %d", len(resp.Events))
	}
	if resp.Cursor != 2 {
		t.Fatalf("want cursor 2, got %d", resp.Cursor)
	}
	if resp.Result != nil {
		t.Fatalf("a running poll must carry no result, got %s", resp.Result)
	}
}

func TestPollResult_CursorAdvancesAndDropsSeenEvents(t *testing.T) {
	secret := []byte("s")
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	table.reserve(testExecID)
	table.appendEvent(testExecID, []byte(`{"n":1}`))
	table.appendEvent(testExecID, []byte(`{"n":2}`))

	first := decodePoll(t, getPoll(t, h, testExecID, "0", secret), secret, testExecID)
	if len(first.Events) != 2 {
		t.Fatalf("first poll should see both events, got %d", len(first.Events))
	}
	// Poll again from the advanced cursor: nothing new.
	second := decodePoll(t, getPoll(t, h, testExecID, strconv.FormatInt(first.Cursor, 10), secret), secret, testExecID)
	if len(second.Events) != 0 {
		t.Fatalf("polling from the last cursor should yield no events, got %d", len(second.Events))
	}
	if second.Cursor != first.Cursor {
		t.Fatalf("cursor moved without new events: %d → %d", first.Cursor, second.Cursor)
	}
}

func TestPollResult_TerminalCarriesSignedResultWithProvenance(t *testing.T) {
	secret := []byte("topsecret")
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	table.reserve(testExecID)

	completion := []byte(`{"execId":"wf-1:step-a:3","exitCode":0,"provenance":{"reads":[{"path":"/in.csv"}]}}`)
	table.complete(testExecID, execStatusCompleted, &execResult{ExitCode: 0})
	table.setCompletionBody(testExecID, completion)

	resp := decodePoll(t, getPoll(t, h, testExecID, "0", secret), secret, testExecID)
	if resp.Status != string(execStatusCompleted) {
		t.Fatalf("want completed, got %q", resp.Status)
	}
	if resp.Result == nil {
		t.Fatal("terminal poll must carry the completion result")
	}
	// The served result bytes are the exact completion bytes — provenance included.
	if string(resp.Result) != string(completion) {
		t.Fatalf("result not served verbatim:\n got %s\nwant %s", resp.Result, completion)
	}
	if !strings.Contains(string(resp.Result), `"provenance"`) {
		t.Fatal("provenance frame lost on the poll path")
	}
}

func TestPollResult_UnknownExecIdIs404(t *testing.T) {
	secret := []byte("s")
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	if rec := getPoll(t, h, "never-submitted", "0", secret); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown execId, got %d", rec.Code)
	}
}

func TestPollResult_UnsignedRequestIsRejected(t *testing.T) {
	secret := []byte("topsecret")
	table := newExecTable()
	h := execResultHandler(table, newInboundAuth(secret))
	table.reserve(testExecID)
	table.appendEvent(testExecID, []byte(`{"n":1}`))

	req := httptest.NewRequest(http.MethodGet, "/exec/"+testExecID+"?since=0", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned poll must be 401, got %d", rec.Code)
	}
}

// ── Poll-mode executor ──────────────────────────────────────────────

// In poll mode the executor is constructed with a nil callback client: it must
// buffer the terminal result in the exec table (for the host to pull) and never
// dereference the absent callback.
func TestExecutor_PollModeBuffersCompletionWithoutCallback(t *testing.T) {
	table := newExecTable()
	exe := newExecutor(table, nil, newProcessTable(), newInboundAuth([]byte("s")), transportPoll)

	rw := submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", "echo hi"},
		"execId":  "poll-1",
	})
	if rw.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", rw.Code)
	}

	waitFor(t, func() bool {
		snap, ok := table.pollSnapshotFor("poll-1", 0)
		return ok && snap.body != nil
	}, 5*time.Second)

	snap, _ := table.pollSnapshotFor("poll-1", 0)
	if snap.status != execStatusCompleted {
		t.Fatalf("want completed, got %q", snap.status)
	}
	if snap.body == nil {
		t.Fatal("poll mode must record the completion body for the host to pull")
	}
	if !strings.Contains(string(snap.body), `"exitCode":0`) {
		t.Fatalf("completion body missing exitCode: %s", snap.body)
	}
}
