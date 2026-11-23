package main

import (
	"errors"
	"slices"
)

const (
	envTreeDiffRoot     = "SANDBOX_TREE_DIFF_ROOT"
	envTreeDiffInterval = "SANDBOX_TREE_DIFF_INTERVAL_MS"
	envEgressFirewall   = "SANDBOX_EGRESS_FIREWALL"
)

// errRootGroup is the refusal of a server that holds gid 0 of root under the firewall flag.
var errRootGroup = errors.New("SANDBOX_EGRESS_FIREWALL=1 but the server holds gid 0 of root: the entrypoint's privilege drop kept the groups of root")

// verifyPrivilegeDrop fails closed on a broken egress-confinement chain.
// SANDBOX_EGRESS_FIREWALL=1 promises the image's root entrypoint installed
// the egress firewall and dropped to the workload uid before exec'ing this
// server; euid 0 under that flag proves the chain did not run, leaving the
// container root, CAP_NET_ADMIN-holding, and unconfined while looking healthy
// from the host. Refusing to start makes that a loud create-time failure.
// Without the flag (K8s) the uid is not this check's concern.
//
// The gid 0 of root is refused the same way, as the primary gid and as a
// supplementary gid. A drop that kept the groups of the container root, for
// example a keep-groups drop on an engine that did not keep the groups of the
// host user, leaves the workload in the root group of the image.
func verifyPrivilegeDrop(firewallFlag string, euid, egid int, groups []int) error {
	if firewallFlag != "1" {
		return nil
	}
	if euid == 0 {
		return errors.New("SANDBOX_EGRESS_FIREWALL=1 but the server is running as root: the entrypoint's firewall+privilege-drop did not run (does the image override ENTRYPOINT?)")
	}
	if egid == 0 || slices.Contains(groups, 0) {
		return errRootGroup
	}
	return nil
}
