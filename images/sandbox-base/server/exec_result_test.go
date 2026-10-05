package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testExecID = "wf-1:step-a:3"

func TestExecResult_RejectsNonGet(t *testing.T) {
	table := newExecTable()
	table.reserve(testExecID)
	h := execResultHandler(table)

	req := httptest.NewRequest(http.MethodPut, "/exec/"+testExecID, nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

// A colon-bearing execId reaches the result route, and any path with an extra
// slash is an unroutable 400.
func TestExecResult_RoutesExecIdAndRejectsExtraSegments(t *testing.T) {
	table := newExecTable()
	table.reserve(testExecID)
	table.complete(testExecID, execStatusCompleted, &execResult{})
	table.setCompletionBody(testExecID, []byte(`{"exitCode":0}`))

	h := execResultHandler(table)

	// Two segments + GET → the result route, colons and all.
	req := httptest.NewRequest(http.MethodGet, "/exec/"+testExecID+"?since=0", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("colon-bearing execId did not reach the result route: %d", rec.Code)
	}

	// A slash-bearing path (`/exec/{pid}/kill`, or anything nested) is not
	// a valid execId → 400, before any table lookup.
	for _, path := range []string{"/exec/99999/kill", "/exec/a/b/c/d"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for unroutable path %q, got %d", path, rec.Code)
		}
	}
}
