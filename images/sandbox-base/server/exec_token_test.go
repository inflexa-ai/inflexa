package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// routes builds the mux of the server over a fresh table, with the test token.
func routes(t *testing.T) http.Handler {
	t.Helper()
	table := newExecTable()
	exe := newExecutor(table, newProcessTable(), newTestRecordStore(t, t.TempDir()))
	return newMux(table, exe, testToken, "")
}

func serve(h http.Handler, method, path, authorization string) int {
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestExecToken_HealthStaysOpen(t *testing.T) {
	if code := serve(routes(t), http.MethodGet, "/health", ""); code != http.StatusOK {
		t.Fatalf("/health with no token: got %d, want 200", code)
	}
}

func TestExecToken_RefusesAMissingOrWrongToken(t *testing.T) {
	h := routes(t)
	for _, path := range []struct{ method, path string }{
		{http.MethodPost, "/exec"},
		{http.MethodGet, "/exec/" + testExecID},
		{http.MethodGet, "/preview/index.html"},
	} {
		for _, auth := range []string{"", "Bearer wrong", testToken, "Bearer " + testToken + "x"} {
			if code := serve(h, path.method, path.path, auth); code != http.StatusUnauthorized {
				t.Fatalf("%s %s with %q: got %d, want 401", path.method, path.path, auth, code)
			}
		}
	}
}

func TestExecToken_TheRightTokenPasses(t *testing.T) {
	// An unknown exec id answers 404 once the token passes, thus the code is not 401.
	if code := serve(routes(t), http.MethodGet, "/exec/"+testExecID, "Bearer "+testToken); code == http.StatusUnauthorized {
		t.Fatalf("the right token was refused")
	}
}

func TestTakeExecToken_RemovesTheTokenFromTheEnvOfEachCommand(t *testing.T) {
	t.Setenv(envExecToken, testToken)

	token, err := takeExecToken()
	if err != nil || token != testToken {
		t.Fatalf("takeExecToken: got %q, %v", token, err)
	}
	if _, set := os.LookupEnv(envExecToken); set {
		t.Fatalf("the token is still in the env of the process")
	}
	cmd := buildCommand(t.Context(), execSubmitRequest{Command: []string{"env"}})
	if slices.ContainsFunc(cmd.Env, func(kv string) bool { return strings.HasPrefix(kv, envExecToken+"=") }) {
		t.Fatalf("the env of a command holds the token")
	}
}

func TestTakeExecToken_NoTokenRefusesTheStart(t *testing.T) {
	t.Setenv(envExecToken, "")

	if _, err := takeExecToken(); !errors.Is(err, errNoExecToken) {
		t.Fatalf("got %v, want errNoExecToken", err)
	}
}
