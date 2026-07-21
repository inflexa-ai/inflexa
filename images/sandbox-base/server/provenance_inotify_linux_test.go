//go:build linux

package main

import (
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
	w := &linuxInotifyWatcher{watched: 12}

	if got := w.budget(); got != nil {
		t.Fatalf("a walk inside the budget must carry no signal; got %+v", got)
	}
}

func TestInotifyBudget_ReportsExhaustion(t *testing.T) {
	w := &linuxInotifyWatcher{exhausted: true, watched: maxInotifyWatches, unwatchedDirs: 7}

	got := w.budget()
	if got == nil {
		t.Fatal("exhaustion must reach the frame — the container log line never leaves the sandbox")
	}
	if got.Limit != maxInotifyWatches || got.Watched != maxInotifyWatches || got.UnwatchedDirs != 7 {
		t.Fatalf("signal must carry the cap, the watches added, and the dirs refused; got %+v", got)
	}
}
