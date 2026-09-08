//go:build !linux

package main

import "os"

// execResourceUsage reports nothing off Linux. `ru_maxrss` carries a different
// unit on every other platform, and the shipped sandbox image is Linux-only, so
// a developer machine omits the frame rather than reporting a wrong number. The
// host treats an omitted frame as absent telemetry.
func execResourceUsage(_ *os.ProcessState) *resourceUsage {
	return nil
}
