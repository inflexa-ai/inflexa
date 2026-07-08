package main

import (
	"encoding/base64"
	"errors"
	"log"
	"os"
	"strings"
)

const (
	envCortexBaseURL    = "CORTEX_BASE_URL"
	envCallbackSecret   = "SANDBOX_CALLBACK_SECRET"
	envTreeDiffRoot     = "SANDBOX_TREE_DIFF_ROOT"
	envTreeDiffInterval = "SANDBOX_TREE_DIFF_INTERVAL_MS"
	envTransport        = "SANDBOX_TRANSPORT"
	envEgressFirewall   = "SANDBOX_EGRESS_FIREWALL"
)

// transportMode selects how a command's progress events and terminal result
// reach the host. It changes nothing about command execution, idempotency,
// provenance, or inbound request authentication.
type transportMode string

const (
	// transportPoll is the default: the server never dials out. Progress events
	// accumulate in a bounded per-exec ring, and both events and the terminal
	// result are served — signed — from GET /exec/{execId}?since={cursor}. The
	// host asks; the sandbox initiates nothing.
	transportPoll transportMode = "poll"
	// transportCallback is the push path: the server POSTs signed event and
	// completion callbacks to CORTEX_BASE_URL.
	transportCallback transportMode = "callback"
)

type serverConfig struct {
	transport      transportMode
	cortexBaseURL  string
	callbackSecret []byte
	treeDiffRoot   string
}

func loadServerConfig() (*serverConfig, error) {
	transport := loadTransport()

	// The callback secret is required in BOTH modes. Poll mode signs the bodies
	// it serves and verifies inbound request signatures with it; callback mode
	// signs its outbound POSTs with it.
	raw := os.Getenv(envCallbackSecret)
	if raw == "" {
		return nil, errors.New("SANDBOX_CALLBACK_SECRET is required")
	}
	secret, err := decodeSecret(raw)
	if err != nil {
		return nil, err
	}

	// CORTEX_BASE_URL is mandatory only in callback mode — poll mode never dials
	// out, so it neither reads nor requires it.
	base := strings.TrimRight(strings.TrimSpace(os.Getenv(envCortexBaseURL)), "/")
	if transport == transportCallback && base == "" {
		return nil, errors.New("CORTEX_BASE_URL is required in callback transport mode")
	}

	return &serverConfig{
		transport:      transport,
		cortexBaseURL:  base,
		callbackSecret: secret,
		treeDiffRoot:   strings.TrimSpace(os.Getenv(envTreeDiffRoot)),
	}, nil
}

// loadTransport reads SANDBOX_TRANSPORT, defaulting to poll and falling back to
// poll (with a warning) on an unrecognised value.
func loadTransport() transportMode {
	raw := strings.TrimSpace(os.Getenv(envTransport))
	switch raw {
	case "", string(transportPoll):
		return transportPoll
	case string(transportCallback):
		return transportCallback
	default:
		log.Printf("WARNING: invalid SANDBOX_TRANSPORT=%q, falling back to poll", raw)
		return transportPoll
	}
}

// verifyPrivilegeDrop fails closed on a broken egress-confinement chain.
//
// SANDBOX_EGRESS_FIREWALL=1 is a promise that the image's root entrypoint
// installed the egress firewall and `setpriv`-dropped to the workload uid
// before exec'ing this server. If the server still holds euid 0, that chain
// did not run — an image that overrides the entrypoint, say — and the
// container is root, holds CAP_NET_ADMIN, and has unconfined egress while
// looking perfectly healthy from the host. Refusing to start turns that
// silent degradation into a loud create-time failure.
//
// Without the flag (callback mode, K8s) the uid is not this check's concern.
func verifyPrivilegeDrop(firewallFlag string, euid int) error {
	if firewallFlag == "1" && euid == 0 {
		return errors.New("SANDBOX_EGRESS_FIREWALL=1 but the server is running as root: the entrypoint's firewall+privilege-drop did not run (does the image override ENTRYPOINT?)")
	}
	return nil
}

func decodeSecret(raw string) ([]byte, error) {
	if strings.HasPrefix(raw, "base64:") {
		b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, "base64:"))
		if err != nil {
			return nil, errors.New("SANDBOX_CALLBACK_SECRET base64 decode failed")
		}
		if len(b) == 0 {
			return nil, errors.New("SANDBOX_CALLBACK_SECRET decoded to empty bytes")
		}
		return b, nil
	}
	return []byte(raw), nil
}
