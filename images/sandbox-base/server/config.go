package main

import (
	"errors"
)

const (
	envTreeDiffRoot     = "SANDBOX_TREE_DIFF_ROOT"
	envTreeDiffInterval = "SANDBOX_TREE_DIFF_INTERVAL_MS"
	envEgressFirewall   = "SANDBOX_EGRESS_FIREWALL"
)

// verifyPrivilegeDrop fails closed on a broken egress-confinement chain.
// SANDBOX_EGRESS_FIREWALL=1 promises the image's root entrypoint installed
// the egress firewall and dropped to the workload uid before exec'ing this
// server; euid 0 under that flag proves the chain did not run, leaving the
// container root, CAP_NET_ADMIN-holding, and unconfined while looking healthy
// from the host. Refusing to start makes that a loud create-time failure.
// Without the flag (K8s) the uid is not this check's concern.
func verifyPrivilegeDrop(firewallFlag string, euid int) error {
	if firewallFlag == "1" && euid == 0 {
		return errors.New("SANDBOX_EGRESS_FIREWALL=1 but the server is running as root: the entrypoint's firewall+privilege-drop did not run (does the image override ENTRYPOINT?)")
	}
	return nil
}
