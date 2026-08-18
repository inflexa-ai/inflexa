package main

import (
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
)

// sunPathMax is the size of sun_path in struct sockaddr_un (include/uapi/linux/un.h).
// A pathname socket needs room for the terminating NUL, so the usable ceiling is
// one less. Go enforces this client-side and returns a bare EINVAL, so an
// over-long path never reaches the kernel and never names itself in the error.
const sunPathMax = 108

// The id the production data profiler passes: sanitizeForFilename over the exec
// id `dataprofile:{analysisUUID}:{nonceUUID}:profile:{fnId}`, plus the "-" and
// 19-digit nanosecond stamp executor.go appends. 118 bytes.
const realDataProfileID = "dataprofile_01a01372-a1bd-73d6-8dd2-9dc7cb84aa2e_0f3c1d2e-4b5a-6c7d-8e9f-a0b1c2d3e4f5_profile_fn-t-1787044333668000000"

func TestNewProvenanceTrackerSocketPathFitsSunPath(t *testing.T) {
	// A step id is a plan-authored slug and an analysis id is a UUID: neither is
	// bounded on this side, so the constructor may not pass either through into
	// the path. Includes the id that broke production.
	for name, id := range map[string]string{
		"production data profile": realDataProfileID,
		"analysis step":           "019efa6f-1234-7abc-8def-0123456789ab-3_differential-expression-analysis_fn-t-1787044333668000000",
		"pathological":            strings.Repeat("x", 4096),
		"empty":                   "",
	} {
		pt := NewProvenanceTracker(id, nil)
		if len(pt.socketPath) >= sunPathMax {
			t.Errorf("%s: socket path is %d bytes, sun_path holds %d: %s", name, len(pt.socketPath), sunPathMax-1, pt.socketPath)
		}
		// The rlog sits beside it and is a regular file, but keep it inside the
		// same ceiling so neither can be the thing that overflows.
		if len(pt.rlogPath) >= sunPathMax {
			t.Errorf("%s: rlog path is %d bytes: %s", name, len(pt.rlogPath), pt.rlogPath)
		}
	}
}

func TestNewProvenanceTrackerSocketPathIsDistinctPerID(t *testing.T) {
	a := NewProvenanceTracker(realDataProfileID, nil)
	b := NewProvenanceTracker(realDataProfileID+"1", nil)
	if a.socketPath == b.socketPath {
		t.Fatalf("distinct ids collided on %s", a.socketPath)
	}
	if NewProvenanceTracker(realDataProfileID, nil).socketPath != a.socketPath {
		t.Fatal("same id produced two different socket paths")
	}
}

// The constructor's whole job is producing a path that binds. Asserting the
// length alone would still pass if the path were malformed some other way.
func TestNewProvenanceTrackerSocketPathBinds(t *testing.T) {
	pt := NewProvenanceTracker(realDataProfileID, nil)
	if err := pt.Start(); err != nil {
		t.Fatalf("Start() on a production-shaped id: %v", err)
	}
	defer func() {
		pt.Stop()
		os.Remove(pt.socketPath)
	}()

	conn, err := net.Dial("unixgram", pt.socketPath)
	if err != nil {
		t.Fatalf("dial %s: %v", pt.socketPath, err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte(fmt.Sprintf(`{"t":1,"p":"/x","pid":1,"layer":"test","op":"read"}`))); err != nil {
		t.Fatalf("write to %s: %v", pt.socketPath, err)
	}
}
