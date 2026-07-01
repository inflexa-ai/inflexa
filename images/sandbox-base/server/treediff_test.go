package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTreeDiff_FirstTickEstablishesBaseline(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := newTreeDiffer(root)
	delta, changed := d.tick()
	if changed {
		t.Fatalf("first tick should not report changes; got %+v", delta)
	}
}

func TestTreeDiff_DetectsAddedFile(t *testing.T) {
	root := t.TempDir()
	d := newTreeDiffer(root)
	d.tick() // baseline (empty)
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	delta, changed := d.tick()
	if !changed {
		t.Fatalf("expected change detected")
	}
	if len(delta.Added) != 1 || delta.Added[0] != "new.txt" {
		t.Fatalf("expected Added=[new.txt], got %+v", delta.Added)
	}
}

func TestTreeDiff_DetectsModifiedFile(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "a.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := newTreeDiffer(root)
	d.tick()
	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(p, []byte("hello world"), 0o644); err != nil {
		t.Fatal(err)
	}
	delta, changed := d.tick()
	if !changed {
		t.Fatalf("expected modification detected")
	}
	if len(delta.Modified) != 1 || delta.Modified[0] != "a.txt" {
		t.Fatalf("expected Modified=[a.txt], got %+v", delta.Modified)
	}
}

func TestTreeDiff_DetectsRemovedFile(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "a.txt")
	os.WriteFile(p, []byte("x"), 0o644)
	d := newTreeDiffer(root)
	d.tick()
	os.Remove(p)
	delta, changed := d.tick()
	if !changed {
		t.Fatalf("expected removal detected")
	}
	if len(delta.Removed) != 1 || delta.Removed[0] != "a.txt" {
		t.Fatalf("expected Removed=[a.txt], got %+v", delta.Removed)
	}
}

func TestTreeDiff_NoEventOnUnchangedTree(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644)
	d := newTreeDiffer(root)
	d.tick() // baseline
	for i := 0; i < 5; i++ {
		_, changed := d.tick()
		if changed {
			t.Fatalf("expected no change on identical tree (iteration %d)", i)
		}
	}
}

func TestTreeDiff_CoalescesMultipleChanges(t *testing.T) {
	root := t.TempDir()
	d := newTreeDiffer(root)
	d.tick()
	for _, name := range []string{"a", "b", "c"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	delta, changed := d.tick()
	if !changed {
		t.Fatalf("expected change")
	}
	if len(delta.Added) != 3 {
		t.Fatalf("expected 3 adds coalesced into one event, got %+v", delta.Added)
	}
}
