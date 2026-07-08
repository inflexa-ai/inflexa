package main

import (
	"encoding/base64"
	"testing"
)

func TestLoadServerConfig_MissingCortexBaseURL_CallbackMode(t *testing.T) {
	t.Setenv(envTransport, string(transportCallback))
	t.Setenv(envCortexBaseURL, "")
	t.Setenv(envCallbackSecret, "topsecret")
	_, err := loadServerConfig()
	if err == nil {
		t.Fatalf("expected error for missing CORTEX_BASE_URL in callback mode")
	}
}

func TestLoadServerConfig_PollModeDefaultsWithoutCortexBaseURL(t *testing.T) {
	t.Setenv(envTransport, "")
	t.Setenv(envCortexBaseURL, "")
	t.Setenv(envCallbackSecret, "topsecret")
	cfg, err := loadServerConfig()
	if err != nil {
		t.Fatalf("poll mode must start without CORTEX_BASE_URL: %v", err)
	}
	if cfg.transport != transportPoll {
		t.Fatalf("expected default transport poll, got %q", cfg.transport)
	}
}

func TestLoadServerConfig_InvalidTransportFallsBackToPoll(t *testing.T) {
	t.Setenv(envTransport, "carrier-pigeon")
	t.Setenv(envCortexBaseURL, "")
	t.Setenv(envCallbackSecret, "topsecret")
	cfg, err := loadServerConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.transport != transportPoll {
		t.Fatalf("expected fallback to poll, got %q", cfg.transport)
	}
}

func TestLoadServerConfig_MissingCallbackSecret(t *testing.T) {
	t.Setenv(envCortexBaseURL, "https://cortex.example")
	t.Setenv(envCallbackSecret, "")
	_, err := loadServerConfig()
	if err == nil {
		t.Fatalf("expected error for missing SANDBOX_CALLBACK_SECRET")
	}
}

func TestLoadServerConfig_RawSecret(t *testing.T) {
	t.Setenv(envCortexBaseURL, "https://cortex.example")
	t.Setenv(envCallbackSecret, "rawsecret")
	cfg, err := loadServerConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(cfg.callbackSecret) != "rawsecret" {
		t.Fatalf("expected raw secret bytes, got %q", string(cfg.callbackSecret))
	}
}

func TestLoadServerConfig_Base64Secret(t *testing.T) {
	original := []byte("abcdef")
	t.Setenv(envCortexBaseURL, "https://cortex.example/")
	t.Setenv(envCallbackSecret, "base64:"+base64.StdEncoding.EncodeToString(original))
	cfg, err := loadServerConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(cfg.callbackSecret) != string(original) {
		t.Fatalf("expected decoded bytes %q, got %q", string(original), string(cfg.callbackSecret))
	}
	if cfg.cortexBaseURL != "https://cortex.example" {
		t.Fatalf("expected trailing slash trimmed, got %q", cfg.cortexBaseURL)
	}
}

func TestLoadServerConfig_Base64Invalid(t *testing.T) {
	t.Setenv(envCortexBaseURL, "https://cortex.example")
	t.Setenv(envCallbackSecret, "base64:not-valid-base64-!!!")
	_, err := loadServerConfig()
	if err == nil {
		t.Fatalf("expected base64 decode error")
	}
}

func TestVerifyPrivilegeDrop_FirewallFlagAsRootRefused(t *testing.T) {
	// SANDBOX_EGRESS_FIREWALL=1 promises the entrypoint installed the egress
	// firewall and dropped to the workload uid before the server started. Still
	// being root proves the drop never happened (an image that overrode the
	// entrypoint) — the container would run privileged and unconfined while
	// appearing healthy. Refuse to start.
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
	// Callback mode and K8s never set the flag; who the workload runs as is the
	// image's/cluster's concern there, not this check's.
	for _, flag := range []string{"", "0"} {
		if err := verifyPrivilegeDrop(flag, 0); err != nil {
			t.Fatalf("unexpected error with flag %q as root: %v", flag, err)
		}
	}
}
