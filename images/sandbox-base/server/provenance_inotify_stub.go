//go:build !linux

package main

// stubInotifyWatcher is a no-op for non-Linux platforms (macOS dev).
type stubInotifyWatcher struct{}

func newInotifyWatcher(_ *ProvenanceTracker) inotifyWatcher {
	return &stubInotifyWatcher{}
}

func (w *stubInotifyWatcher) start(_ []string)           {}
func (w *stubInotifyWatcher) stop()                      {}
func (w *stubInotifyWatcher) budget() *watchBudgetSignal { return nil }
