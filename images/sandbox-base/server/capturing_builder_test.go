package main

import (
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestCapturingBuilderUnboundedWhenCapZero(t *testing.T) {
	b := &capturingBuilder{}
	if _, err := b.Write([]byte(strings.Repeat("x", 5000))); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := len(b.String()); got != 5000 {
		t.Fatalf("retained %d bytes, want 5000", got)
	}
	if b.truncated() {
		t.Fatal("uncapped builder reported truncation")
	}
	if got := b.totalBytes(); got != 5000 {
		t.Fatalf("totalBytes = %d, want 5000", got)
	}
}

func TestCapturingBuilderRetainsOnlyUpToCap(t *testing.T) {
	b := &capturingBuilder{byteCap: 100}
	for i := 0; i < 10; i++ {
		if _, err := b.Write([]byte(strings.Repeat("y", 50))); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if got := len(b.String()); got != 100 {
		t.Fatalf("retained %d bytes, want 100", got)
	}
	if !b.truncated() {
		t.Fatal("expected truncation")
	}
	// The true size survives even though the bytes did not — that is what tells a
	// caller the command printed 500 bytes rather than 100.
	if got := b.totalBytes(); got != 500 {
		t.Fatalf("totalBytes = %d, want 500", got)
	}
}

// A short write must not be reported as truncated just because a cap is set.
func TestCapturingBuilderUnderCapIsNotTruncated(t *testing.T) {
	b := &capturingBuilder{byteCap: 100}
	if _, err := b.Write([]byte("short")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if b.truncated() {
		t.Fatal("under-cap write reported truncation")
	}
	if got := b.String(); got != "short" {
		t.Fatalf("String() = %q, want %q", got, "short")
	}
}

// Write reports the full length as accepted so the pipe reader never sees a
// short write once the retention budget is spent.
func TestCapturingBuilderWriteReportsFullLength(t *testing.T) {
	b := &capturingBuilder{byteCap: 4}
	n, err := b.Write([]byte("abcdefgh"))
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if n != 8 {
		t.Fatalf("Write returned %d, want 8", n)
	}
}

// Capping lands on a byte boundary, which can fall mid-rune. The retained string
// must still be valid UTF-8 rather than ending in a replacement character.
func TestCapturingBuilderTrimsPartialRune(t *testing.T) {
	// "☃" is 3 bytes; a cap of 4 keeps one whole snowman plus one stray byte.
	b := &capturingBuilder{byteCap: 4}
	if _, err := b.Write([]byte("☃☃")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := b.String()
	if !utf8.ValidString(got) {
		t.Fatalf("String() = %q, which is not valid UTF-8", got)
	}
	if got != "☃" {
		t.Fatalf("String() = %q, want %q", got, "☃")
	}
}

func TestCapturingBuilderConcurrentWrites(t *testing.T) {
	b := &capturingBuilder{byteCap: 256}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 64; j++ {
				_, _ = b.Write([]byte("z"))
			}
		}()
	}
	wg.Wait()
	if got := b.totalBytes(); got != 16*64 {
		t.Fatalf("totalBytes = %d, want %d", got, 16*64)
	}
	if got := len(b.String()); got != 256 {
		t.Fatalf("retained %d bytes, want 256", got)
	}
}
