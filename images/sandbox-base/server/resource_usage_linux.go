//go:build linux

package main

import (
	"os"
	"syscall"
)

// execResourceUsage reads the `wait4` accounting of a reaped process.
//
// The kernel fills `struct rusage` at reap time for the child and for every
// descendant the child itself waited for, so a `sh -c` pipeline reports the
// peak of its whole tree. `ru_maxrss` is a high-water mark in kibibytes on
// Linux; `ru_utime` plus `ru_stime` is the CPU the tree burned.
//
// gVisor serves the same numbers: its `wait4` fills the rusage from
// `getrusage(RUSAGE_BOTH)` on the reaped task, and a reaped grandchild's peak
// propagates into the parent's `childMaxRSS`. This is the only accounting the
// `gvisor` RuntimeClass exposes — the sentry's own cgroupfs carries
// `memory.usage_in_bytes` but no peak file, and its `memory.limit_in_bytes` is
// a stub that never holds the pod limit.
//
// A process that never ran, or a platform that reports no rusage, gives nil.
func execResourceUsage(ps *os.ProcessState) *resourceUsage {
	if ps == nil {
		return nil
	}
	ru, ok := ps.SysUsage().(*syscall.Rusage)
	if !ok || ru == nil {
		return nil
	}
	return &resourceUsage{
		PeakMemoryBytes: ru.Maxrss * 1024,
		CPUMillis:       (ps.UserTime() + ps.SystemTime()).Milliseconds(),
	}
}
