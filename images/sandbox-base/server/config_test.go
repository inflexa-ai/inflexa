package main

import (
	"testing"
)

func TestVerifyPrivilegeDrop_FirewallFlagAsRootRefused(t *testing.T) {
	// Root under the firewall flag proves the entrypoint's drop never ran —
	// the container would be privileged and unconfined while appearing healthy.
	if err := verifyPrivilegeDrop("1", 0); err == nil {
		t.Fatalf("expected refusal when the firewall flag is set but the server runs as root")
	}
}

func TestVerifyPrivilegeDrop_FirewallFlagDroppedUidOk(t *testing.T) {
	if err := verifyPrivilegeDrop("1", 1000); err != nil {
		t.Fatalf("unexpected error after a completed privilege drop: %v", err)
	}
}

func TestVerifyPrivilegeDrop_NoFirewallFlagIgnoresUid(t *testing.T) {
	// K8s never sets the flag; who the workload runs as is the image's/cluster's
	// concern there, not this check's.
	for _, flag := range []string{"", "0"} {
		if err := verifyPrivilegeDrop(flag, 0); err != nil {
			t.Fatalf("unexpected error with flag %q as root: %v", flag, err)
		}
	}
}
