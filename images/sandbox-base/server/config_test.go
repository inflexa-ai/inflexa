package main

import (
	"encoding/base64"
	"testing"
)

func TestLoadServerConfig_MissingCortexBaseURL(t *testing.T) {
	t.Setenv(envCortexBaseURL, "")
	t.Setenv(envCallbackSecret, "topsecret")
	_, err := loadServerConfig()
	if err == nil {
		t.Fatalf("expected error for missing CORTEX_BASE_URL")
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
