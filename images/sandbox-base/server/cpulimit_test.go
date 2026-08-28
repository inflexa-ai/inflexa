package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func writeFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func TestCPUQuotaV2(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    int
		wantOK  bool
	}{
		{"two cores", "200000 100000\n", 2, true},
		{"a fraction rounds up", "150000 100000\n", 2, true},
		{"half a core still gets one thread", "50000 100000\n", 1, true},
		{"unlimited", "max 100000\n", 0, false},
		{"one field", "200000\n", 0, false},
		{"not a number", "lots 100000\n", 0, false},
		{"zero period", "200000 0\n", 0, false},
		{"empty", "", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := cpuQuotaV2(writeFile(t, "cpu.max", c.content))
			if got != c.want || ok != c.wantOK {
				t.Fatalf("got (%d, %v), want (%d, %v)", got, ok, c.want, c.wantOK)
			}
		})
	}
}

func TestCPUQuotaV1(t *testing.T) {
	period := writeFile(t, "cpu.cfs_period_us", "100000\n")

	quota := writeFile(t, "cpu.cfs_quota_us", "400000\n")
	if got, ok := cpuQuotaV1(quota, period); got != 4 || !ok {
		t.Fatalf("got (%d, %v), want (4, true)", got, ok)
	}

	unlimited := writeFile(t, "cpu.cfs_quota_us", "-1\n")
	if got, ok := cpuQuotaV1(unlimited, period); got != 0 || ok {
		t.Fatalf("got (%d, %v), want (0, false)", got, ok)
	}
}

func TestReadCPUQuotaWithoutCgroupFiles(t *testing.T) {
	// A host with neither layout is indistinguishable from an unlimited one, and
	// both must publish nothing rather than a guess.
	if got := readCPUQuota(); got < 0 {
		t.Fatalf("got %d, want 0 or a positive quota", got)
	}
}

func envMap(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, kv := range entries {
		if name, value, ok := strings.Cut(kv, "="); ok {
			out[name] = value
		}
	}
	return out
}

func TestCPULimitEnvPublishesTheQuota(t *testing.T) {
	env := envMap(cpuLimitEnv([]string{"PATH=/usr/bin"}, 3))

	for _, name := range cpuLimitVars {
		if env[name] != "3" {
			t.Fatalf("%s = %q, want \"3\"", name, env[name])
		}
	}
	if env[envCPULimit] != "3" {
		t.Fatalf("%s = %q, want \"3\"", envCPULimit, env[envCPULimit])
	}
}

func TestCPULimitEnvOmitsMCCores(t *testing.T) {
	// R defaults mclapply to 2 workers. Publishing the quota here would raise the
	// fork count, which is the opposite of what this file is for.
	if slices.Contains(cpuLimitVars, "MC_CORES") {
		t.Fatal("MC_CORES must not be published: it raises R's default fork count")
	}
	if _, found := envMap(cpuLimitEnv(nil, 8))["MC_CORES"]; found {
		t.Fatal("MC_CORES must not be published")
	}
}

func TestCPULimitEnvIsSilentWithoutAQuota(t *testing.T) {
	if got := cpuLimitEnv([]string{"PATH=/usr/bin"}, 0); got != nil {
		t.Fatalf("got %v, want nil", got)
	}
}

func TestCPULimitEnvKeepsAValueThatIsAlreadySet(t *testing.T) {
	env := envMap(cpuLimitEnv([]string{"OMP_NUM_THREADS=1", "PATH=/usr/bin"}, 4))

	if _, found := env["OMP_NUM_THREADS"]; found {
		t.Fatal("a name the container already sets must not be published again")
	}
	if env["OPENBLAS_NUM_THREADS"] != "4" {
		t.Fatalf("the other names must still be published, got %q", env["OPENBLAS_NUM_THREADS"])
	}
}

func TestBuildCommandLetsTheRequestOverrideTheQuota(t *testing.T) {
	// The machine that runs this test has its own quota, or none, so the wiring
	// is exercised against a stated one.
	restore := cpuQuota
	cpuQuota = func() int { return 4 }
	t.Cleanup(func() { cpuQuota = restore })

	cmd := buildCommand(context.Background(), execSubmitRequest{
		Command: []string{"true"},
		Env:     map[string]string{"OMP_NUM_THREADS": "1"},
	})
	env := envMap(cmd.Env)

	if env["OMP_NUM_THREADS"] != "1" {
		t.Fatalf("the request must win, got %q", env["OMP_NUM_THREADS"])
	}
	if env["OPENBLAS_NUM_THREADS"] != "4" {
		t.Fatalf("the quota must reach the names the request leaves alone, got %q", env["OPENBLAS_NUM_THREADS"])
	}
	if env[envCPULimit] != "4" {
		t.Fatalf("%s = %q, want \"4\"", envCPULimit, env[envCPULimit])
	}
}
