package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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
	// Watches the inotify walk may register before it stops descending, unless
	// PROVENANCE_MAX_INOTIFY_WATCHES says otherwise.
	defaultInotifyWatchLimit = 1000
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
	// Directories inotify walks. Narrow, and the only layer that needs to be:
	// inotify is the sole layer watching the shared filesystem, so it is the
	// sole layer that can observe another container's writes.
	watchDirs []string
	// Prefixes bounding what any layer may report — the analysis mount root.
	// Configured independently of watchDirs and never derived from them: the
	// in-container hooks intercept only their own process's opens, so a
	// command's own read of a path no watcher covers still reaches the frame.
	dataPrefixes []string

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
func NewProvenanceTracker(id string, watchDirs, dataPrefixes []string) *ProvenanceTracker {
	socketPath := fmt.Sprintf("/tmp/prov-%s.sock", id)
	pt := &ProvenanceTracker{
		socketPath:   socketPath,
		rlogPath:     socketPath + ".rlog",
		watchDirs:    watchDirs,
		dataPrefixes: dataPrefixes,
		stopCh:       make(chan struct{}),
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

// provenanceResult holds the three operation arrays and, when the inotify walk
// ran out of watch budget, the signal that capture was partial.
type provenanceResult struct {
	Reads       []ProvenanceEntry
	Writes      []ProvenanceEntry
	Deletes     []ProvenanceEntry
	WatchBudget *watchBudgetSignal
}

// watchBudgetSignal reports that the inotify walk left directories unobserved,
// whether because it hit its own cap or because the kernel refused a
// registration. It rides the exec's provenance frame because the watcher's own
// log line never leaves the container: without it, degraded capture is
// indistinguishable from a step that touched nothing. Never a failure —
// capture is best-effort and this accompanies a normal exec.
//
// The two shortfalls are counted separately because they have different
// remedies: the cap is this server declining to watch more and is raised with
// PROVENANCE_MAX_INOTIFY_WATCHES, while a refused registration is the host
// refusing and is relieved only on the host.
type watchBudgetSignal struct {
	// The cap the walk stopped at.
	Limit int `json:"limit"`
	// Watches added before the cap was reached.
	Watched int `json:"watched"`
	// Directories the walk reached and refused. A floor, not an exact count:
	// each refusal also skips that directory's subtree, which is never walked.
	UnwatchedDirs int `json:"unwatchedDirs"`
	// Directories inotify_add_watch rejected, the cap notwithstanding. ENOSPC
	// here means the kernel's per-uid ceiling
	// (/proc/sys/fs/inotify/max_user_watches) is exhausted by this host's
	// processes, which no setting inside the container can relieve.
	FailedWatches int `json:"failedWatches"`
}

// inotifyWatchLimit returns the cap on watches the walk may register (env
// override, else the shipped default).
//
// Configurable because the value bounds a walk over a tree whose shape is the
// workload's: a step that writes per-entity output directories can exceed any
// number chosen at build time, and the deployment that hits it must be able to
// raise the bound without waiting on a rebuilt image. An absent or unusable
// value falls back to the default rather than failing — provenance never fails
// a command, so a typo in an env var must not either.
func inotifyWatchLimit() int {
	raw := strings.TrimSpace(os.Getenv(envInotifyWatchLimit))
	if raw == "" {
		return defaultInotifyWatchLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		log.Printf("WARNING: invalid %s=%q, falling back to %d", envInotifyWatchLimit, raw, defaultInotifyWatchLimit)
		return defaultInotifyWatchLimit
	}
	return n
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
		Reads:       buildList(pt.ops["read"]),
		Writes:      buildList(pt.ops["write"]),
		Deletes:     buildList(pt.ops["delete"]),
		WatchBudget: pt.inotify.budget(),
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

	// The hooks filter by prefix on the paths their own process opens, so they
	// carry the mount root rather than the watch dirs: an LD_PRELOAD interposer
	// and interpreter-level hooks cannot see another container's writes, and
	// narrowing them would drop a legitimate cross-step or prior-run read the
	// command itself performed. Whether such a read may assert lineage is the
	// host's decision at classification, not this filter's.
	if len(pt.dataPrefixes) > 0 {
		env = append(env, "PROVENANCE_DATA_PREFIXES="+strings.Join(pt.dataPrefixes, ":"))
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

// underDataPrefix reports whether a cleaned absolute path lies within one of
// the configured data prefixes. Entries carry a trailing slash, so this also
// excludes a prefix root itself — a read of the mount root is a directory,
// never an attestable file.
func underDataPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

func (pt *ProvenanceTracker) recordOp(op, path, layer string) {
	// Canonicalize and re-check here, the one point every layer converges on:
	// each hook filters by string prefix on whatever path its caller passed,
	// which need not be canonical. "/{id}/.." literally starts with the prefix
	// "/{id}/" yet names its parent, so it survives the hook's filter and
	// reaches the host as a tracked read that resolves above the mount root —
	// which the host cannot attest, and fails the step over. Filtering on the
	// cleaned path makes each hook's own check an optimization and this the
	// boundary. The bound is the data prefixes, not the watch dirs: a report
	// from a hook is admissible anywhere under the mount, and only inotify is
	// confined to the watched trees — by what it is able to observe at all.
	path = filepath.Clean(path)
	if !underDataPrefix(path, pt.dataPrefixes) {
		// A dropped report never reaches the host, so nothing over there can
		// account for it — this line is the only trace of a hook-filter leak.
		if sandboxLogLevel == logLevelDebug {
			log.Printf("[provenance] dropping out-of-tree report op=%s layer=%s path=%q", op, layer, path)
		}
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
	// budget reports exhaustion of the watch cap, or nil when the walk fit
	// inside it. Read after stop(), so the walk has finished writing it.
	budget() *watchBudgetSignal
}

// ── Helpers ────────────────────────────────────────────────────

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// provenanceWatchDirs returns the directories inotify walks, from
// PROVENANCE_WATCH_DIRS (comma-separated absolute paths, default /data). The
// host enumerates the trees that cannot change under the running command — the
// analysis data tree, this step's own tree, and the tree of every step already
// completed — so a directory a concurrent step is still writing is absent by
// construction.
//
// A configured dir that does not exist is skipped, not an error: a completed
// step that produced no tree and a read-only sandbox with no step tree are both
// ordinary, and provenance never fails a command.
func provenanceWatchDirs() []string {
	raw := os.Getenv("PROVENANCE_WATCH_DIRS")
	if raw == "" {
		raw = "/data"
	}
	var result []string
	for _, d := range normalizePathList(raw, ",") {
		if info, err := os.Stat(strings.TrimSuffix(d, "/")); err == nil && info.IsDir() {
			result = append(result, d)
		}
	}
	return result
}

// provenanceDataPrefixes returns the prefixes bounding what any layer may
// report, from PROVENANCE_DATA_PREFIXES (colon-separated, matching the form the
// hooks themselves parse; default /data).
//
// Read from its own variable rather than derived from the watch dirs, and
// deliberately not existence-filtered: the prefixes are the mount root, and a
// stat that failed would silently discard every report the layers send.
func provenanceDataPrefixes() []string {
	raw := os.Getenv("PROVENANCE_DATA_PREFIXES")
	if raw == "" {
		raw = "/data"
	}
	return normalizePathList(raw, ":")
}

// normalizePathList splits a separated list of absolute paths and gives each a
// trailing slash, which is what makes a prefix comparison exclude the directory
// itself and refuse a sibling whose name merely starts the same.
func normalizePathList(raw, sep string) []string {
	var result []string
	for _, p := range strings.Split(raw, sep) {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.HasSuffix(p, "/") {
			p += "/"
		}
		result = append(result, p)
	}
	return result
}
