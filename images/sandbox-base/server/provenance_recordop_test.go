package main

import (
	"testing"
)

// The watch dir as provenanceWatchDirs builds it: absolute, trailing slash.
const testWatchDir = "/019f6a20-1a3b-7000-a942-ae871e5de040/"

func newTestTracker() *ProvenanceTracker {
	return &ProvenanceTracker{
		watchDirs: []string{testWatchDir},
		ops:       make(map[string]map[string]map[string]bool),
	}
}

func recordedPaths(pt *ProvenanceTracker, op string) []string {
	var out []string
	for p := range pt.ops[op] {
		out = append(out, p)
	}
	return out
}

func TestRecordOp_DropsParentOfMountRoot(t *testing.T) {
	// "/{id}/.." string-prefix-matches the watch dir but names its parent. The
	// host maps it to a host path above the workspace root, cannot attest it,
	// and fails the step with lineage_attestation.
	pt := newTestTracker()
	pt.recordOp("read", "/019f6a20-1a3b-7000-a942-ae871e5de040/..", "ld_preload")

	if got := recordedPaths(pt, "read"); len(got) != 0 {
		t.Fatalf("parent of mount root must not be recorded; got %v", got)
	}
}

func TestRecordOp_DropsTraversalOutOfTree(t *testing.T) {
	pt := newTestTracker()
	pt.recordOp("read", "/019f6a20-1a3b-7000-a942-ae871e5de040/../../../etc/passwd", "ld_preload")

	if got := recordedPaths(pt, "read"); len(got) != 0 {
		t.Fatalf("traversal outside the tree must not be recorded; got %v", got)
	}
}

func TestRecordOp_DropsMountRootItself(t *testing.T) {
	// A read of the mount root is a directory, never an attestable file.
	pt := newTestTracker()
	pt.recordOp("read", "/019f6a20-1a3b-7000-a942-ae871e5de040", "inotify")

	if got := recordedPaths(pt, "read"); len(got) != 0 {
		t.Fatalf("mount root itself must not be recorded; got %v", got)
	}
}

func TestRecordOp_KeepsInTreeRead(t *testing.T) {
	pt := newTestTracker()
	want := "/019f6a20-1a3b-7000-a942-ae871e5de040/data/inputs/f1/counts.csv"
	pt.recordOp("read", want, "python")

	got := recordedPaths(pt, "read")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("in-tree read must survive; want [%s], got %v", want, got)
	}
}

func TestRecordOp_CanonicalizesInTreePath(t *testing.T) {
	// R's normalizePath(mustWork=FALSE) leaves ".." intact whenever a component
	// does not exist yet — the common case for a write to a new output file.
	// Such a path still resolves inside the tree and must be recorded, but under
	// its canonical name so it dedups against the other layers' reports of it.
	pt := newTestTracker()
	pt.recordOp("write", "/019f6a20-1a3b-7000-a942-ae871e5de040/runs/r1/T3S1/scripts/../output/enrich.csv", "r")
	pt.recordOp("write", "/019f6a20-1a3b-7000-a942-ae871e5de040/runs/r1/T3S1/output/enrich.csv", "inotify")

	got := recordedPaths(pt, "write")
	want := "/019f6a20-1a3b-7000-a942-ae871e5de040/runs/r1/T3S1/output/enrich.csv"
	if len(got) != 1 || got[0] != want {
		t.Fatalf("both layers must fold onto the canonical path; want [%s], got %v", want, got)
	}
	if layers := pt.ops["write"][want]; !layers["r"] || !layers["inotify"] {
		t.Fatalf("both layers must be attributed; got %v", layers)
	}
}
