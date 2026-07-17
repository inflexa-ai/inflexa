package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── Configuration ──────────────────────────────────────────────

const (
	// Max datagram size for provenance reports
	provenanceBufSize = 65536
	// Time to wait for late-arriving datagrams after process exit
	provenanceDrainTimeout = 200 * time.Millisecond
)

// Paths to provenance hook files in the container image.
const (
	siteCustomizePath = "/opt/provenance/sitecustomize.py"
	siteCustomizeDir  = "/opt/provenance"
	rProfilePath      = "/opt/provenance/Rprofile.site"
	ldPreloadPath     = "/opt/provenance/provtrack.so"
)

// ── Types ──────────────────────────────────────────────────────

// provenanceDatagram is the JSON format sent by hooks.
type provenanceDatagram struct {
	Timestamp float64 `json:"t"`
	Path      string  `json:"p"`
	PID       int     `json:"pid"`
	Layer     string  `json:"layer"`
	Op        string  `json:"op"` // "read", "write", "delete"
}

// ProvenanceEntry is a single tracked file operation with layer attribution.
type ProvenanceEntry struct {
	Path   string   `json:"path"`
	Layers []string `json:"layers"`
}

// ProvenanceTracker collects file-read provenance from interpreter hooks,
// LD_PRELOAD, and inotify during a single command execution.
type ProvenanceTracker struct {
	socketPath string
	rlogPath   string
	watchDirs  []string

	// Socket listener
	listener net.PacketConn
	stopCh   chan struct{}
	wg       sync.WaitGroup

	// Collected operations: op → (path → set of layers)
	mu  sync.Mutex
	ops map[string]map[string]map[string]bool // op → path → layers

	// Inotify state (Linux-only, see provenance_inotify_linux.go)
	inotify inotifyWatcher
}

// ── Constructor / lifecycle ────────────────────────────────────

// NewProvenanceTracker creates a tracker with a unique socket path.
func NewProvenanceTracker(id string, watchDirs []string) *ProvenanceTracker {
	socketPath := fmt.Sprintf("/tmp/prov-%s.sock", id)
	pt := &ProvenanceTracker{
		socketPath: socketPath,
		rlogPath:   socketPath + ".rlog",
		watchDirs:  watchDirs,
		stopCh: make(chan struct{}),
		ops: map[string]map[string]map[string]bool{
			"read":   {},
			"write":  {},
			"delete": {},
		},
	}
	pt.inotify = newInotifyWatcher(pt)
	return pt
}

// Start creates the socket, starts the listener, and sets up inotify watches.
func (pt *ProvenanceTracker) Start() error {
	// Remove stale socket file
	os.Remove(pt.socketPath)
	os.Remove(pt.rlogPath)

	// Create DGRAM listener
	addr := &net.UnixAddr{Name: pt.socketPath, Net: "unixgram"}
	conn, err := net.ListenUnixgram("unixgram", addr)
	if err != nil {
		return fmt.Errorf("provenance socket: %w", err)
	}
	pt.listener = conn

	// Start socket reader goroutine
	pt.wg.Add(1)
	go pt.readLoop()

	// Start inotify watcher (Linux-only; no-op on other platforms)
	pt.inotify.start(pt.watchDirs)

	return nil
}

// provenanceResult holds the three operation arrays.
type provenanceResult struct {
	Reads   []ProvenanceEntry
	Writes  []ProvenanceEntry
	Deletes []ProvenanceEntry
}

// Stop drains remaining messages, reads the R log file, and cleans up.
func (pt *ProvenanceTracker) Stop() provenanceResult {
	// Signal stop and wait for drain
	close(pt.stopCh)

	// Give hooks a moment to send final datagrams
	if pt.listener != nil {
		pt.listener.SetReadDeadline(time.Now().Add(provenanceDrainTimeout))
	}
	pt.wg.Wait()

	// Close socket
	if pt.listener != nil {
		pt.listener.Close()
	}
	os.Remove(pt.socketPath)

	// Stop inotify
	pt.inotify.stop()

	// Read R provenance log file
	pt.readRlog()
	os.Remove(pt.rlogPath)

	// Build result
	pt.mu.Lock()
	defer pt.mu.Unlock()

	buildList := func(opMap map[string]map[string]bool) []ProvenanceEntry {
		result := make([]ProvenanceEntry, 0, len(opMap))
		for path, layers := range opMap {
			layerList := make([]string, 0, len(layers))
			for l := range layers {
				layerList = append(layerList, l)
			}
			sort.Strings(layerList)
			result = append(result, ProvenanceEntry{Path: path, Layers: layerList})
		}
		sort.Slice(result, func(i, j int) bool {
			return result[i].Path < result[j].Path
		})
		return result
	}

	return provenanceResult{
		Reads:   buildList(pt.ops["read"]),
		Writes:  buildList(pt.ops["write"]),
		Deletes: buildList(pt.ops["delete"]),
	}
}

// Env returns the environment variables to inject into child processes.
func (pt *ProvenanceTracker) Env() []string {
	env := []string{
		"PROVENANCE_SOCKET=" + pt.socketPath,
	}

	// PYTHONPATH: prepend /opt/provenance to existing value
	if fileExists(siteCustomizePath) {
		existing := os.Getenv("PYTHONPATH")
		if existing != "" {
			env = append(env, "PYTHONPATH="+siteCustomizeDir+":"+existing)
		} else {
			env = append(env, "PYTHONPATH="+siteCustomizeDir)
		}
	}

	if fileExists(rProfilePath) {
		env = append(env, "R_PROFILE="+rProfilePath)
	}

	if fileExists(ldPreloadPath) {
		env = append(env, "LD_PRELOAD="+ldPreloadPath)
	}

	// Pass watch dirs to hooks for prefix matching
	if len(pt.watchDirs) > 0 {
		env = append(env, "PROVENANCE_DATA_PREFIXES="+strings.Join(pt.watchDirs, ":"))
	}

	return env
}

// ── Socket reader ──────────────────────────────────────────────

func (pt *ProvenanceTracker) readLoop() {
	defer pt.wg.Done()
	buf := make([]byte, provenanceBufSize)
	for {
		select {
		case <-pt.stopCh:
			// Set a fresh deadline — the default branch's SetReadDeadline
			// may have overwritten the one from Stop(), leaving an already-
			// expired deadline that causes ReadFrom to return immediately.
			pt.listener.SetReadDeadline(time.Now().Add(provenanceDrainTimeout))
			for {
				n, _, err := pt.listener.ReadFrom(buf)
				if err != nil {
					return
				}
				pt.parseDatagram(buf[:n])
			}
		default:
			pt.listener.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
			n, _, err := pt.listener.ReadFrom(buf)
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					continue
				}
				return
			}
			pt.parseDatagram(buf[:n])
		}
	}
}

func (pt *ProvenanceTracker) parseDatagram(data []byte) {
	var dg provenanceDatagram
	if err := json.Unmarshal(data, &dg); err != nil {
		return
	}
	if dg.Path == "" || dg.Layer == "" {
		return
	}
	op := dg.Op
	if op == "" {
		op = "read" // backward compat: no op field = read
	}
	pt.recordOp(op, dg.Path, dg.Layer)
}

// underWatchDir reports whether a cleaned absolute path lies within one of the
// watch dirs. Entries carry a trailing slash, so this also excludes a watch dir
// itself — a read of the mount root is a directory, never an attestable file.
func underWatchDir(path string, dirs []string) bool {
	for _, d := range dirs {
		if strings.HasPrefix(path, d) {
			return true
		}
	}
	return false
}

func (pt *ProvenanceTracker) recordOp(op, path, layer string) {
	// Canonicalize and re-check here, the one point every layer converges on:
	// each hook filters by string prefix on whatever path its caller passed,
	// which need not be canonical. "/{id}/.." literally starts with the watch
	// dir "/{id}/" yet names its parent, so it survives the hook's filter and
	// reaches the host as a tracked read that resolves above the mount root —
	// which the host cannot attest, and fails the step over. Filtering on the
	// cleaned path makes each hook's own check an optimization and this the
	// boundary.
	path = filepath.Clean(path)
	if !underWatchDir(path, pt.watchDirs) {
		return
	}

	pt.mu.Lock()
	defer pt.mu.Unlock()
	opMap := pt.ops[op]
	if opMap == nil {
		opMap = make(map[string]map[string]bool)
		pt.ops[op] = opMap
	}
	if opMap[path] == nil {
		opMap[path] = make(map[string]bool)
	}
	opMap[path][layer] = true
}

// ── R log file reader ──────────────────────────────────────────

func (pt *ProvenanceTracker) readRlog() {
	f, err := os.Open(pt.rlogPath)
	if err != nil {
		return // No R provenance log — R wasn't used
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		pt.parseDatagram([]byte(line))
	}
}

// ── Inotify watcher interface ──────────────────────────────────
//
// Platform-specific implementations:
//   provenance_inotify_linux.go  — real inotify via golang.org/x/sys/unix
//   provenance_inotify_stub.go   — no-op for non-Linux (macOS dev)

type inotifyWatcher interface {
	start(watchDirs []string)
	stop()
}

// ── Helpers ────────────────────────────────────────────────────

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// provenanceWatchDirs returns the list of directories to watch for file reads.
// Configured via PROVENANCE_WATCH_DIRS env var (comma-separated). Defaults to /data.
func provenanceWatchDirs() []string {
	raw := os.Getenv("PROVENANCE_WATCH_DIRS")
	if raw == "" {
		raw = "/data"
	}
	dirs := strings.Split(raw, ",")
	// Only return directories that exist
	var result []string
	for _, d := range dirs {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		// Ensure trailing slash for prefix matching
		if !strings.HasSuffix(d, "/") {
			d += "/"
		}
		if info, err := os.Stat(strings.TrimSuffix(d, "/")); err == nil && info.IsDir() {
			result = append(result, d)
		}
	}
	return result
}
