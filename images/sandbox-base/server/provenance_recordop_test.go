package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The watch dir as provenanceWatchDirs builds it: absolute, trailing slash.
const testWatchDir = "/019f6a20-1a3b-7000-a942-ae871e5de040/"

// The watch-dir cases assert what the bound does, so they answer every presence
// probe with true: none of their paths exists on the machine running the test,
// and a tracker on the real filesystem would drop them for being absent — the
// guard under test would then pass while doing nothing.
func newTestTracker() *ProvenanceTracker {
	return &ProvenanceTracker{
		watchDirs:  []string{testWatchDir},
		ops:        make(map[string]map[string]map[string]bool),
		pathExists: func(string) bool { return true },
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

// realTracker watches a temp dir and probes the real filesystem, so the
// presence rule is exercised against actual files rather than a stub.
func realTracker(t *testing.T) (*ProvenanceTracker, string) {
	t.Helper()
	root := t.TempDir()
	return &ProvenanceTracker{
		watchDirs: []string{root + string(filepath.Separator)},
		ops:       make(map[string]map[string]map[string]bool),
	}, root
}

func TestRecordOp_DropsReadOfAbsentPath(t *testing.T) {
	// The reported failure: a step's script died with an uncaught pandas
	// KeyError, and CPython's traceback printer looked for the Cython source of
	// the frame by probing "<entry>/hashtable_class_helper.pxi" for every
	// sys.path entry. The script's own directory is sys.path[0] and lives in the
	// analysis tree, so the audit hook — which fires before the open, not after
	// — reported an in-tree read of a file that never existed. The host then
	// failed the step trying to hash it.
	pt, root := realTracker(t)
	phantom := filepath.Join(root, "runs", "r1", "T1S1", "scripts", "hashtable_class_helper.pxi")
	pt.recordOp("read", phantom, "python")

	if got := recordedPaths(pt, "read"); len(got) != 0 {
		t.Fatalf("a read of a path that is not there must not be recorded; got %v", got)
	}
}

func TestRecordOp_KeepsReadOfPresentPath(t *testing.T) {
	pt, root := realTracker(t)
	want := filepath.Join(root, "counts.csv")
	if err := os.WriteFile(want, []byte("gene,count\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	pt.recordOp("read", want, "python")

	got := recordedPaths(pt, "read")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("a read of a file that is there must survive; want [%s], got %v", want, got)
	}
}

func TestRecordOp_ProbesEachReadPathOnce(t *testing.T) {
	// inotify reports every open of every file in the tree, so a script reading
	// one file in a loop reaches here thousands of times for one frame entry.
	// The probe belongs to the entry, not to the report.
	probes := 0
	pt := &ProvenanceTracker{
		watchDirs: []string{testWatchDir},
		ops:       make(map[string]map[string]map[string]bool),
		pathExists: func(string) bool {
			probes++
			return true
		},
	}
	path := testWatchDir + "data/inputs/f1/counts.csv"
	pt.recordOp("read", path, "python")
	pt.recordOp("read", path, "preload")
	pt.recordOp("read", path, "inotify")

	if probes != 1 {
		t.Fatalf("a path already in the frame must not be re-probed; got %d probes", probes)
	}
	if layers := pt.ops["read"][path]; len(layers) != 3 {
		t.Fatalf("every layer must still be attributed; got %v", layers)
	}
}

func TestRecordOp_DropsReadOfBrokenSymlink(t *testing.T) {
	// A link whose target is gone fails the open exactly as a name that never
	// existed does, and the layer reporting it fired before finding that out.
	pt, root := realTracker(t)
	link := filepath.Join(root, "counts.csv")
	if err := os.Symlink(filepath.Join(root, "gone.csv"), link); err != nil {
		t.Fatalf("symlink fixture: %v", err)
	}
	pt.recordOp("read", link, "python")

	if got := recordedPaths(pt, "read"); len(got) != 0 {
		t.Fatalf("a read through a broken symlink must not be recorded; got %v", got)
	}
}

func TestRecordOp_KeepsReadThroughSymlink(t *testing.T) {
	pt, root := realTracker(t)
	target := filepath.Join(root, "counts.csv")
	if err := os.WriteFile(target, []byte("gene,count\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	link := filepath.Join(root, "latest.csv")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink fixture: %v", err)
	}
	pt.recordOp("read", link, "python")

	// Under the name the workload used: the layers report names, not inodes.
	got := recordedPaths(pt, "read")
	if len(got) != 1 || got[0] != link {
		t.Fatalf("a read through a live symlink must survive; want [%s], got %v", link, got)
	}
}

func TestRecordOp_KeepsWriteOfAbsentPath(t *testing.T) {
	// A write is reported before the file it creates exists — the presence rule
	// is about reads only. Phantom writes are dropped host-side at reconcile,
	// where the file has had its chance to appear.
	pt, root := realTracker(t)
	want := filepath.Join(root, "runs", "r1", "T1S2", "output", "de.csv")
	pt.recordOp("write", want, "python")

	got := recordedPaths(pt, "write")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("a write must survive an absent path; want [%s], got %v", want, got)
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
