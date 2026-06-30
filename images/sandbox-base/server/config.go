package main

import (
	"encoding/base64"
	"errors"
	"os"
	"strings"
)

const (
	envCortexBaseURL    = "CORTEX_BASE_URL"
	envCallbackSecret   = "SANDBOX_CALLBACK_SECRET"
	envTreeDiffRoot     = "SANDBOX_TREE_DIFF_ROOT"
	envTreeDiffInterval = "SANDBOX_TREE_DIFF_INTERVAL_MS"
)

type serverConfig struct {
	cortexBaseURL   string
	callbackSecret  []byte
	treeDiffRoot    string
}

func loadServerConfig() (*serverConfig, error) {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv(envCortexBaseURL)), "/")
	if base == "" {
		return nil, errors.New("CORTEX_BASE_URL is required")
	}

	raw := os.Getenv(envCallbackSecret)
	if raw == "" {
		return nil, errors.New("SANDBOX_CALLBACK_SECRET is required")
	}
	secret, err := decodeSecret(raw)
	if err != nil {
		return nil, err
	}

	return &serverConfig{
		cortexBaseURL:  base,
		callbackSecret: secret,
		treeDiffRoot:   strings.TrimSpace(os.Getenv(envTreeDiffRoot)),
	}, nil
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
