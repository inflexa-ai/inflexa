package main

import (
	"errors"
	"testing"
)

func TestVerifyPrivilegeDrop_FirewallFlagAsRootRefused(t *testing.T) {
	// Root under the firewall flag proves the entrypoint's drop never ran —
	// the container would be privileged and unconfined while appearing healthy.
	if err := verifyPrivilegeDrop("1", 0, 1000, nil); err == nil {
		t.Fatalf("expected refusal when the firewall flag is set but the server runs as root")
	}
}

func TestVerifyPrivilegeDrop_FirewallFlagDroppedUidOk(t *testing.T) {
	if err := verifyPrivilegeDrop("1", 1000, 1000, []int{1000, 65534}); err != nil {
		t.Fatalf("unexpected error after a completed privilege drop: %v", err)
	}
}

func TestVerifyPrivilegeDrop_NoFirewallFlagIgnoresUid(t *testing.T) {
	// K8s never sets the flag; who the workload runs as is the image's/cluster's
	// concern there, not this check's.
	for _, flag := range []string{"", "0"} {
		if err := verifyPrivilegeDrop(flag, 0, 0, []int{0}); err != nil {
			t.Fatalf("unexpected error with flag %q as root: %v", flag, err)
		}
	}
}

func TestVerifyPrivilegeDrop_FirewallFlagGroupRootRefused(t *testing.T) {
	// A drop that kept the groups of the container root leaves the workload in
	// gid 0, which reads and writes each file of the root group in the image.
	cases := map[string]struct {
		egid   int
		groups []int
	}{
		"primary gid 0":       {0, []int{1000}},
		"supplementary gid 0": {1000, []int{1000, 0}},
	}
	for name, c := range cases {
		err := verifyPrivilegeDrop("1", 1000, c.egid, c.groups)
		if !errors.Is(err, errRootGroup) {
			t.Fatalf("%s: expected the gid 0 refusal, got %v", name, err)
		}
	}
}
