package main

import (
	"strings"
	"testing"
)

// The analysis mount root as provenanceDataPrefixes builds it: absolute,
// trailing slash.
const testDataPrefix = "/019f6a20-1a3b-7000-a942-ae871e5de040/"

func newTestTracker() *ProvenanceTracker {
	return &ProvenanceTracker{
		// The step's own tree alone, as the harness configures it — deliberately
		// narrower than the prefix bound: what a hook may report is not what
		// inotify watches.
		watchDirs:    []string{testDataPrefix + "runs/r1/T3S1/"},
		dataPrefixes: []string{testDataPrefix},
		ops:          make(map[string]map[string]map[string]bool),
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

func TestRecordOp_KeepsAReadOutsideTheWatchDirs(t *testing.T) {
	// A hook intercepts its own process's open, so a read under a tree no
	// watcher covers — a sibling's output, `data/`, a prior run — is still the
	// command's own read. Whether it may assert lineage is the host's decision
	// at classification; dropping it here would make it undecidable.
	pt := newTestTracker()
	want := "/019f6a20-1a3b-7000-a942-ae871e5de040/runs/r1/norm/output/norm.csv"
	pt.recordOp("read", want, "ld_preload")

	got := recordedPaths(pt, "read")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("a hook-reported read outside the watch dirs must survive; want [%s], got %v", want, got)
	}
}

func TestEnv_DataPrefixesAreNotDerivedFromWatchDirs(t *testing.T) {
	pt := newTestTracker()

	var got string
	for _, kv := range pt.Env() {
		if strings.HasPrefix(kv, "PROVENANCE_DATA_PREFIXES=") {
			got = strings.TrimPrefix(kv, "PROVENANCE_DATA_PREFIXES=")
		}
	}

	if got != testDataPrefix {
		t.Fatalf("hooks must filter on the mount root, not the watch dirs; want %q, got %q", testDataPrefix, got)
	}
}

func TestProvenanceWatchDirs_SkipsAConfiguredDirThatDoesNotExist(t *testing.T) {
	// A step tree the host has not pre-created yet is ordinary — capture is
	// best-effort and never fails a command.
	present := t.TempDir()
	t.Setenv("PROVENANCE_WATCH_DIRS", present+","+present+"/never-created")

	got := provenanceWatchDirs()

	if len(got) != 1 || got[0] != present+"/" {
		t.Fatalf("only the existing dir must be watched; got %v", got)
	}
}

func TestProvenanceDataPrefixes_ReadsItsOwnVariable(t *testing.T) {
	t.Setenv("PROVENANCE_WATCH_DIRS", "/an-1/runs/r1/T3S1")
	t.Setenv("PROVENANCE_DATA_PREFIXES", "/an-1")

	got := provenanceDataPrefixes()

	if len(got) != 1 || got[0] != "/an-1/" {
		t.Fatalf("data prefixes must come from PROVENANCE_DATA_PREFIXES with a trailing slash; got %v", got)
	}
}

func TestInotifyWatchLimit_DefaultsWhenUnset(t *testing.T) {
	t.Setenv(envInotifyWatchLimit, "")

	if got := inotifyWatchLimit(); got != defaultInotifyWatchLimit {
		t.Fatalf("an unset cap must ship the default; want %d, got %d", defaultInotifyWatchLimit, got)
	}
}

func TestInotifyWatchLimit_HonorsTheEnvironment(t *testing.T) {
	// The knob exists so a deployment whose step trees outgrow the default can
	// raise it without waiting on a rebuilt image.
	t.Setenv(envInotifyWatchLimit, "25000")

	if got := inotifyWatchLimit(); got != 25000 {
		t.Fatalf("the configured cap must win over the default; want 25000, got %d", got)
	}
}

func TestInotifyWatchLimit_FallsBackOnAnUnusableValue(t *testing.T) {
	// Provenance never fails a command, so neither may a typo in its config.
	for _, raw := range []string{"not-a-number", "0", "-5"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv(envInotifyWatchLimit, raw)

			if got := inotifyWatchLimit(); got != defaultInotifyWatchLimit {
				t.Fatalf("%q must fall back to the default; got %d", raw, got)
			}
		})
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
