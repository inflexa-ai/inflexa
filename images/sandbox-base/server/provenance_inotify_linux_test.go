//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestClassifyInotifyMask_MutationsOnly(t *testing.T) {
	cases := []struct {
		name string
		mask uint32
		want string
	}{
		{"create", unix.IN_CREATE, "write"},
		{"moved_to", unix.IN_MOVED_TO, "write"},
		{"delete", unix.IN_DELETE, "delete"},
		{"moved_from", unix.IN_MOVED_FROM, "delete"},
		// An open says a descriptor was obtained, not that the command consumed
		// the file: it fires for write-opens and for unrelated processes alike.
		{"open", unix.IN_OPEN, ""},
		{"ignored", unix.IN_IGNORED, ""},
		{"queue_overflow", unix.IN_Q_OVERFLOW, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyInotifyMask(tc.mask); got != tc.want {
				t.Fatalf("mask %#x: want %q, got %q", tc.mask, tc.want, got)
			}
		})
	}
}

func TestInotifyWatchMask_ExcludesOpen(t *testing.T) {
	// The events never asked for are the ones that cannot be misread later.
	if inotifyWatchMask&unix.IN_OPEN != 0 {
		t.Fatal("the watch mask must not request IN_OPEN")
	}
	for _, want := range []uint32{unix.IN_CREATE, unix.IN_DELETE, unix.IN_MOVED_FROM, unix.IN_MOVED_TO} {
		if inotifyWatchMask&want == 0 {
			t.Fatalf("the watch mask must request %#x", want)
		}
	}
}

func TestInotifyBudget_SilentWhenTheWalkFits(t *testing.T) {
	w := &linuxInotifyWatcher{limit: defaultInotifyWatchLimit, watched: 12}

	if got := w.budget(); got != nil {
		t.Fatalf("a walk that covered everything must carry no signal; got %+v", got)
	}
}

func TestInotifyBudget_ReportsExhaustion(t *testing.T) {
	w := &linuxInotifyWatcher{limit: defaultInotifyWatchLimit, exhausted: true, watched: defaultInotifyWatchLimit, unwatchedDirs: 7}

	got := w.budget()
	if got == nil {
		t.Fatal("exhaustion must reach the frame — the container log line never leaves the sandbox")
	}
	if got.Limit != defaultInotifyWatchLimit || got.Watched != defaultInotifyWatchLimit || got.UnwatchedDirs != 7 {
		t.Fatalf("signal must carry the cap, the watches added, and the dirs refused; got %+v", got)
	}
	if got.FailedWatches != 0 {
		t.Fatalf("a cap refusal is not a registration failure; got %+v", got)
	}
}

func TestInotifyBudget_ReportsTheCapItActuallyApplied(t *testing.T) {
	// The walk holds its bound so the frame names the number that governed it,
	// not whatever the environment says by the time the exec drains.
	w := &linuxInotifyWatcher{limit: 25000, exhausted: true, watched: 25000, unwatchedDirs: 3}

	got := w.budget()
	if got == nil || got.Limit != 25000 {
		t.Fatalf("signal must carry the configured cap; got %+v", got)
	}
}

func TestInotifyStart_AppliesTheConfiguredCap(t *testing.T) {
	root := t.TempDir()
	for _, sub := range []string{"a", "b", "c"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatalf("fixture: %v", err)
		}
	}
	t.Setenv(envInotifyWatchLimit, "1")

	w := &linuxInotifyWatcher{fd: -1, wds: make(map[int]string), stopCh: make(chan struct{})}
	w.start([]string{root})
	defer w.stop()

	if w.limit != 1 {
		t.Fatalf("the walk must apply the configured cap, not the shipped default; got %d", w.limit)
	}
	got := w.budget()
	if got == nil || got.Limit != 1 || got.Watched != 1 || got.UnwatchedDirs == 0 {
		t.Fatalf("the configured cap must bound the walk and ride the frame; got %+v", got)
	}
}

func TestInotifyBudget_ReportsARegistrationFailureWithTheCapUnreached(t *testing.T) {
	// A kernel ENOSPC against /proc/sys/fs/inotify/max_user_watches leaves the
	// same blind spot as the cap while the walk is nowhere near it. Reporting
	// nothing here would tell the host a partially-blind walk was a clean one.
	w := &linuxInotifyWatcher{limit: defaultInotifyWatchLimit, watched: 4, failedWatches: 2}

	got := w.budget()
	if got == nil {
		t.Fatal("a refused registration must reach the frame even with the cap unreached")
	}
	if got.FailedWatches != 2 {
		t.Fatalf("the refusals must be counted; got %+v", got)
	}
	if got.UnwatchedDirs != 0 {
		t.Fatalf("a kernel refusal must stay distinct from a cap refusal; got %+v", got)
	}
}
