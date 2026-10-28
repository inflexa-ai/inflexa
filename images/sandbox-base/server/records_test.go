package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// restartedExecutor is a new process of the same machine, or a replacement
// machine of the same lease: a fresh table restored from the record directory.
func restartedExecutor(t *testing.T, dir string) *executor {
	t.Helper()
	store := newTestRecordStore(t, dir)
	restored, err := store.load()
	if err != nil {
		t.Fatalf("load the records: %v", err)
	}
	table := newExecTable()
	table.restore(restored)
	return newExecutor(table, newProcessTable(), store)
}

func readRecordFile(t *testing.T, dir, execID string) persistedRecord {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(dir, recordFileName(execID)))
	if err != nil {
		t.Fatalf("read the record file of %s: %v", execID, err)
	}
	var rec persistedRecord
	if err := json.Unmarshal(body, &rec); err != nil {
		t.Fatalf("parse the record file of %s: %v", execID, err)
	}
	return rec
}

func lostOf(t *testing.T, body []byte) lostCompletion {
	t.Helper()
	var lost lostCompletion
	if err := json.Unmarshal(body, &lost); err != nil {
		t.Fatalf("parse the lost completion: %v", err)
	}
	return lost
}

func TestRecordStore_RefusesAnEmptyDirectory(t *testing.T) {
	if _, err := openRecordStore(""); err == nil {
		t.Fatal("expected a refusal with no record directory")
	}
}

func TestRecords_ACompletedRecordSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	first := newExecutor(newExecTable(), newProcessTable(), newTestRecordStore(t, dir))
	marker := filepath.Join(t.TempDir(), "runs")
	command := []string{"sh", "-c", "echo run >> '" + marker + "'; echo out"}

	submit(t, first, map[string]any{"command": command, "execId": "wf-1:4"})
	served := waitForCompletion(t, first, "wf-1:4", 3*time.Second)
	if rec := readRecordFile(t, dir, "wf-1:4"); rec.Status != execStatusCompleted || string(rec.Completion) != string(served.body) {
		t.Fatalf("the record is not on the volume when the result is visible: %+v", rec)
	}

	second := restartedExecutor(t, dir)
	rw := submit(t, second, map[string]any{"command": command, "execId": "wf-1:4"})
	if rw.Code != http.StatusAccepted || !strings.Contains(rw.Body.String(), `"completed"`) {
		t.Fatalf("expected 202 with the completed status, got %d %s", rw.Code, rw.Body.String())
	}
	snap, ok := second.table.pollSnapshotFor("wf-1:4", 0)
	if !ok || string(snap.body) != string(served.body) {
		t.Fatalf("the restored result differs:\n got %s\nwant %s", snap.body, served.body)
	}
	time.Sleep(100 * time.Millisecond) // a second run would write its marker now
	runs, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("read the run marker: %v", err)
	}
	if got := strings.Count(string(runs), "run\n"); got != 1 {
		t.Fatalf("expected exactly 1 run across the restart, got %d", got)
	}
}

func TestRecords_ARunningRecordBecomesLostAtStart(t *testing.T) {
	dir := t.TempDir()
	store := newTestRecordStore(t, dir)
	startedAt := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	if err := store.write(persistedRecord{ExecID: "wf-1:7", Status: execStatusRunning, StartedAt: startedAt}); err != nil {
		t.Fatalf("write the running record: %v", err)
	}

	second := restartedExecutor(t, dir)
	snap, ok := second.table.pollSnapshotFor("wf-1:7", 0)
	if !ok {
		t.Fatal("the running record was not restored")
	}
	if snap.status != execStatusFailed {
		t.Fatalf("expected the status failed, got %q", snap.status)
	}
	lost := lostOf(t, snap.body)
	if lost.Lost.Reason != lostReplaced || lost.ExitCode != nil || lost.DurationMs != nil || lost.ExecID != "wf-1:7" {
		t.Fatalf("unexpected lost completion: %s", snap.body)
	}
	if !strings.Contains(string(snap.body), `"exitCode":null`) {
		t.Fatalf("the lost completion must carry a null exit code: %s", snap.body)
	}
	if rec := readRecordFile(t, dir, "wf-1:7"); rec.Status != execStatusFailed || !rec.StartedAt.Equal(startedAt) {
		t.Fatalf("the lost record was not written back: %+v", rec)
	}
}

func TestRecords_ABadFileDoesNotStopTheStart(t *testing.T) {
	dir := t.TempDir()
	store := newTestRecordStore(t, dir)
	if err := store.write(persistedRecord{ExecID: "good", Status: execStatusCompleted, Completion: json.RawMessage(`{"execId":"good","exitCode":0}`)}); err != nil {
		t.Fatalf("write the good record: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, recordFileName("wf-1:9")), []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write the bad record: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "%%%.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write the undecodable name: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, recordTempPrefix+"123"), []byte("partial"), 0o600); err != nil {
		t.Fatalf("write the temporary file: %v", err)
	}

	restored, err := store.load()
	if err != nil {
		t.Fatalf("a bad file stopped the load: %v", err)
	}
	byID := map[string]persistedRecord{}
	for _, rec := range restored {
		byID[rec.ExecID] = rec
	}
	if len(byID) != 2 {
		t.Fatalf("expected the good record and the lost record, got %v", byID)
	}
	if byID["good"].Status != execStatusCompleted {
		t.Fatalf("the good record changed: %+v", byID["good"])
	}
	if bad := byID["wf-1:9"]; bad.Status != execStatusFailed || lostOf(t, bad.Completion).Lost.Reason != lostReplaced {
		t.Fatalf("the unreadable record is not lost: %+v", bad)
	}
	if _, err := os.Stat(filepath.Join(dir, recordTempPrefix+"123")); !os.IsNotExist(err) {
		t.Fatalf("the temporary file stays: %v", err)
	}
}

func TestExec_EachExecGetsItsOwnTemporaryDirectory(t *testing.T) {
	exe := newTestExecutor(t)

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", `echo kept > "$TMPDIR/state"; echo "$TMPDIR"`},
		"execId":  "tmp-1",
		"env":     map[string]string{"TMPDIR": "/nonexistent"},
	})
	first := strings.TrimSpace(completionOf(t, waitForCompletion(t, exe, "tmp-1", 3*time.Second)).Stdout)
	if !strings.HasPrefix(first, filepath.Join(execTempRoot, "exec-")) {
		t.Fatalf("expected a TMPDIR under %s, got %q", execTempRoot, first)
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("the TMPDIR of the first exec stays after its end: %v", err)
	}

	submit(t, exe, map[string]any{
		"command": []string{"sh", "-c", `echo "$TMPDIR"; test -e "` + first + `/state" && echo found || echo absent`},
		"execId":  "tmp-2",
	})
	lines := strings.Fields(completionOf(t, waitForCompletion(t, exe, "tmp-2", 3*time.Second)).Stdout)
	if len(lines) != 2 || lines[0] == first || lines[1] != "absent" {
		t.Fatalf("the second exec saw the state of the first: %v", lines)
	}
}

func TestHealth_CountsTheRunningExecs(t *testing.T) {
	table := newExecTable()
	table.reserve("running")
	table.reserve("done")
	table.complete("done", execStatusCompleted, &execResult{})

	rw := httptest.NewRecorder()
	healthHandler(table)(rw, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rw.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rw.Code)
	}
	var body healthBody
	if err := json.Unmarshal(rw.Body.Bytes(), &body); err != nil {
		t.Fatalf("parse the health body: %v", err)
	}
	if body.Status != "ok" || body.RunningExecs != 1 {
		t.Fatalf("unexpected health body: %s", rw.Body.String())
	}
}

func TestExecHandler_AnUnwritableRecordRunsNothing(t *testing.T) {
	dir := t.TempDir()
	exe := newExecutor(newExecTable(), newProcessTable(), newTestRecordStore(t, dir))
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("make the record directory read-only: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(dir, 0o700); err != nil {
			t.Errorf("restore the record directory: %v", err)
		}
	})

	marker := filepath.Join(t.TempDir(), "ran")
	rw := submit(t, exe, map[string]any{"command": []string{"sh", "-c", "touch '" + marker + "'"}, "execId": "nowrite"})
	if rw.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rw.Code)
	}
	if _, ok := exe.table.get("nowrite"); ok {
		t.Fatal("the table keeps an exec whose record did not reach the store")
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the command ran: %v", err)
	}
}
