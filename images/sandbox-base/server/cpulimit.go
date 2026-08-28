package main

// CPU-quota visibility for spawned commands.
//
// The harness gives each container a hard CPU quota (`NanoCpus` on Docker,
// `limits.cpu` on K8s). A cgroup quota is invisible to the runtimes inside it:
// `/proc` and `/sys` still describe the machine, so `nproc`, `os.cpu_count()`,
// and `parallel::detectCores()` all report the cores of the host. A thread pool
// or a worker pool that sizes itself from that number oversubscribes the quota,
// and a forked pool exhausts the memory limit of the container long before the
// CPU limit throttles it.
//
// This file reads the quota that the container itself is under, and publishes
// it to each command. The value comes from the cgroup, not from the request
// that made the container, thus it can never disagree with what the kernel
// enforces. A container with no quota publishes nothing and keeps the defaults
// of the machine.

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

const (
	cgroupV2CPUMax    = "/sys/fs/cgroup/cpu.max"
	cgroupV1CPUQuota  = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
	cgroupV1CPUPeriod = "/sys/fs/cgroup/cpu/cpu.cfs_period_us"

	// R profile that makes `parallel::detectCores()` report the quota. R reads
	// /sys/devices/system/cpu/online, which no quota and no cpuset changes, so
	// R is the one runtime that an environment value alone cannot reach.
	cpuLimitRProfilePath = "/opt/cpu-limit.R"

	envCPULimit     = "INFLEXA_CPU_LIMIT"
	envRProfileUser = "R_PROFILE_USER"
)

// cpuLimitVars are the thread-pool controls whose own default comes from the
// core count of the machine. Each one is a ceiling, thus a value at the quota
// never oversubscribes.
//
// MC_CORES is deliberately absent. R defaults `mclapply` to 2 workers, not to
// the core count, so a value here would raise the fork count instead of lowering
// it — and the forks are what exhaust the memory of the container.
var cpuLimitVars = []string{
	"OMP_NUM_THREADS",
	"OPENBLAS_NUM_THREADS",
	"MKL_NUM_THREADS",
	"NUMEXPR_NUM_THREADS",
	"NUMBA_NUM_THREADS",
	"POLARS_MAX_THREADS",
	"RAYON_NUM_THREADS",
	"R_DATATABLE_NUM_THREADS",
}

// cpuQuota is the whole-core ceiling of this container, or 0 when it has none.
// Read once: the quota of a running container does not change. It is a variable
// so that a test can state a quota that the machine it runs on does not have.
var cpuQuota func() int = sync.OnceValue(readCPUQuota)

// readCPUQuota reads the CPU quota of this container from its cgroup. It
// returns 0 when there is no quota, which is also what a host with neither
// cgroup layout gives.
func readCPUQuota() int {
	if n, ok := cpuQuotaV2(cgroupV2CPUMax); ok {
		return n
	}
	if n, ok := cpuQuotaV1(cgroupV1CPUQuota, cgroupV1CPUPeriod); ok {
		return n
	}
	return 0
}

// cpuQuotaV2 parses the cgroup v2 `cpu.max` file, whose two fields are the
// quota and the period in microseconds. An unlimited container writes `max` in
// the first field.
func cpuQuotaV2(path string) (int, bool) {
	fields := strings.Fields(readTrimmed(path))
	if len(fields) < 2 || fields[0] == "max" {
		return 0, false
	}
	return quotaCores(fields[0], fields[1])
}

// cpuQuotaV1 parses the two cgroup v1 files. An unlimited container writes -1
// as its quota.
func cpuQuotaV1(quotaPath, periodPath string) (int, bool) {
	return quotaCores(readTrimmed(quotaPath), readTrimmed(periodPath))
}

// quotaCores converts a quota and a period in microseconds into whole cores. It
// rounds up: a fractional quota still keeps one thread busy, and a pool of zero
// is not representable.
func quotaCores(quota, period string) (int, bool) {
	q, err := strconv.Atoi(quota)
	if err != nil || q <= 0 {
		return 0, false
	}
	p, err := strconv.Atoi(period)
	if err != nil || p <= 0 {
		return 0, false
	}
	return (q + p - 1) / p, true
}

func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// cpuLimitEnv returns the environment entries that publish the quota to one
// command. It sets a name only when base leaves it unset, thus a value that the
// embedder put on the container, and a value that the request carries, both keep
// the last word over this default.
func cpuLimitEnv(base []string, quota int) []string {
	if quota < 1 {
		return nil
	}
	set := make(map[string]struct{}, len(base))
	for _, kv := range base {
		if name, _, ok := strings.Cut(kv, "="); ok {
			set[name] = struct{}{}
		}
	}
	value := strconv.Itoa(quota)
	out := make([]string, 0, len(cpuLimitVars)+2)
	add := func(name, v string) {
		if _, ok := set[name]; !ok {
			out = append(out, name+"="+v)
		}
	}
	for _, name := range cpuLimitVars {
		add(name, value)
	}
	// The R profile reads this name. Nothing else in the image derives the
	// quota, so the two can not disagree.
	add(envCPULimit, value)
	if fileExists(cpuLimitRProfilePath) {
		add(envRProfileUser, cpuLimitRProfilePath)
	}
	return out
}
