package main

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
)

const (
	envTreeDiffRoot     = "SANDBOX_TREE_DIFF_ROOT"
	envTreeDiffInterval = "SANDBOX_TREE_DIFF_INTERVAL_MS"
	envEgressFirewall   = "SANDBOX_EGRESS_FIREWALL"
	envExecToken        = "SANDBOX_EXEC_TOKEN"
)

// errNoExecToken refuses a start with no exec token: each route but /health
// would then refuse each request.
var errNoExecToken = errors.New(envExecToken + " is not set: the harness gives each machine an exec token, and the server refuses each exec without it")

// takeExecToken reads the exec token and removes it from the env of this
// process. A command inherits the env of the server (buildCommand), thus the
// token must leave the env before the first exec.
func takeExecToken() (string, error) {
	token := os.Getenv(envExecToken)
	if err := os.Unsetenv(envExecToken); err != nil {
		return "", fmt.Errorf("remove %s from the env: %w", envExecToken, err)
	}
	if token == "" {
		return "", errNoExecToken
	}
	return token, nil
}

// requireExecToken lets a request through only with `Authorization: Bearer
// <token>`. The compare runs in constant time for a value of the right length.
func requireExecToken(token string, next http.Handler) http.Handler {
	want := []byte("Bearer " + token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			writeJSONResponse(w, http.StatusUnauthorized, map[string]string{"error": "missing or wrong exec token"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

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
