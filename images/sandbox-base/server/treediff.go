package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

const (
	defaultTreeDiffInterval = 2 * time.Second
	treeDiffMaxFiles        = 10_000
)

type fileMeta struct {
	Size  int64
	MtimeNano int64
}

// treeDiffer snapshots a root directory and reports changes between snapshots.
type treeDiffer struct {
	root     string
	previous map[string]fileMeta
}

func newTreeDiffer(root string) *treeDiffer {
	return &treeDiffer{root: root, previous: nil}
}

// snapshot walks the root and returns (path → meta). Errors during walk cause
// problematic entries to be skipped — a partial snapshot is preferable to silence.
func (d *treeDiffer) snapshot() map[string]fileMeta {
	out := make(map[string]fileMeta)
	if d.root == "" {
		return out
	}
	count := 0
	_ = filepath.WalkDir(d.root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		info, ierr := entry.Info()
		if ierr != nil {
			return nil
		}
		rel, rerr := filepath.Rel(d.root, path)
		if rerr != nil {
			return nil
		}
		out[rel] = fileMeta{Size: info.Size(), MtimeNano: info.ModTime().UnixNano()}
		count++
		if count >= treeDiffMaxFiles {
			return filepath.SkipAll
		}
		return nil
	})
	return out
}

type treeDiff struct {
	Added    []string `json:"added,omitempty"`
	Modified []string `json:"modified,omitempty"`
	Removed  []string `json:"removed,omitempty"`
}

func (d treeDiff) empty() bool {
	return len(d.Added) == 0 && len(d.Modified) == 0 && len(d.Removed) == 0
}

// diff returns the change set from previous to current. If previous is nil, all
// files in current are reported as Added.
func diffSnapshots(prev, cur map[string]fileMeta) treeDiff {
	var d treeDiff
	for path, meta := range cur {
		old, existed := prev[path]
		if !existed {
			d.Added = append(d.Added, path)
			continue
		}
		if old.Size != meta.Size || old.MtimeNano != meta.MtimeNano {
			d.Modified = append(d.Modified, path)
		}
	}
	for path := range prev {
		if _, stillThere := cur[path]; !stillThere {
			d.Removed = append(d.Removed, path)
		}
	}
	sort.Strings(d.Added)
	sort.Strings(d.Modified)
	sort.Strings(d.Removed)
	return d
}

// tick computes the next diff against the previous snapshot and updates state.
// Returns an empty diff (and reports `changed=false`) when nothing changed.
func (d *treeDiffer) tick() (treeDiff, bool) {
	cur := d.snapshot()
	if d.previous == nil {
		d.previous = cur
		// First tick establishes the baseline — no event emitted.
		return treeDiff{}, false
	}
	delta := diffSnapshots(d.previous, cur)
	d.previous = cur
	if delta.empty() {
		return delta, false
	}
	return delta, true
}

// treeDiffInterval returns the configured debounce interval (env override or default).
func treeDiffInterval() time.Duration {
	raw := os.Getenv(envTreeDiffInterval)
	if raw == "" {
		return defaultTreeDiffInterval
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		return defaultTreeDiffInterval
	}
	return time.Duration(ms) * time.Millisecond
}
