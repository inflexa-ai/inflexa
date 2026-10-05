// sandbox-server is an HTTP server embedded in Inflexa sandbox containers.
// It exposes a submit-and-poll command-execution protocol: POST /exec
// accepts {command, execId, ...}, spawns the command in the background, and
// returns HTTP 202 immediately. A repeated execId returns the existing entry
// and runs nothing. Progress events (on-change tree-diffs) accumulate in a
// bounded per-exec ring, and the host polls both the events and the terminal
// result from GET /exec/{execId}?since={cursor}. The server never dials out.
//
// The endpoints carry no credential. The network is the boundary: Docker
// publishes the port on 127.0.0.1 only and the entrypoint denies egress
// (SANDBOX_EGRESS_FIREWALL=1); K8s admits the host through a NetworkPolicy.
//
// Exec entries live in memory for the life of the process.
//
// Endpoints:
//
//	GET  /health          → readiness probe
//	POST /exec            → submit a command (returns 202)
//	GET  /exec/{execId}   → `{status, events, cursor, truncated?, result?}` with
//	                        the events past `?since={cursor}` (absent reads as 0)
//	GET  /preview/...     → static file preview (inert unless PREVIEW_ROOT is
//	                        set — the shipped image never sets it)
//
// Env:
//
//	SANDBOX_SERVER_PORT            listen port (default 8765)
//	SANDBOX_EGRESS_FIREWALL        `1` when the entrypoint installed the egress
//	                               firewall; the server then refuses to run as root
//	SANDBOX_TREE_DIFF_ROOT         snapshot root for an exec that gives no cwd
//	SANDBOX_TREE_DIFF_INTERVAL_MS  tree-diff tick interval
//	SANDBOX_LOG_LEVEL              `info` (default) | `debug`
//	PROVENANCE_WATCH_DIRS          comma-separated directories that provenance watches
//	PREVIEW_ROOT                   root of the static preview
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultPort        = "8765"
	killEscalationWait = 5 * time.Second
	shutdownGrace      = 10 * time.Second
	readHeaderTimeout  = 30 * time.Second
	timeoutExitCode    = 124
	stderrTailLines    = 20
	stderrTailMaxBytes = 2048
	commandMaxLen      = 200
)

// ── Log level ─────────────────────────────────────────────────────

type logLevel int

const (
	logLevelInfo logLevel = iota
	logLevelDebug
)

var sandboxLogLevel logLevel

func initLogLevel() {
	v := os.Getenv("SANDBOX_LOG_LEVEL")
	switch v {
	case "", "info":
		sandboxLogLevel = logLevelInfo
	case "debug":
		sandboxLogLevel = logLevelDebug
	default:
		sandboxLogLevel = logLevelInfo
		log.Printf("WARNING: invalid SANDBOX_LOG_LEVEL=%q, falling back to info", v) //nolint:gosec // G706: %q quotes the value, thus it cannot inject a log line
	}
}

// ── Trace context ───────────────────────────────────────────────────

// extractTraceID parses the W3C traceparent header and returns the 32-char
// hex trace ID. Returns "" if the header is absent or malformed.
func extractTraceID(r *http.Request) string {
	tp := r.Header.Get("traceparent")
	if tp == "" {
		return ""
	}
	parts := strings.Split(tp, "-")
	if len(parts) < 4 || len(parts[1]) != 32 {
		return ""
	}
	return parts[1]
}

// truncateCommand joins a command slice and truncates to maxLen chars.
func truncateCommand(cmd []string, maxLen int) string {
	joined := strings.Join(cmd, " ")
	if len(joined) > maxLen {
		return joined[:maxLen] + "..."
	}
	return joined
}

// ── Process tracking (graceful-shutdown child reaping) ──────────────

type processEntry struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

type processTable struct {
	mu      sync.Mutex
	entries map[int]*processEntry
}

func newProcessTable() *processTable {
	return &processTable{entries: make(map[int]*processEntry)}
}

func (pt *processTable) add(pid int, entry *processEntry) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	pt.entries[pid] = entry
}

func (pt *processTable) remove(pid int) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	delete(pt.entries, pid)
}

func (pt *processTable) killAll() {
	pt.mu.Lock()
	entries := make(map[int]*processEntry, len(pt.entries))
	maps.Copy(entries, pt.entries)
	pt.mu.Unlock()

	for _, entry := range entries {
		// SAFETY: Signal fails only for a process that already exited, which needs no signal.
		_ = entry.cmd.Process.Signal(syscall.SIGTERM)
	}

	time.AfterFunc(killEscalationWait, func() {
		pt.mu.Lock()
		defer pt.mu.Unlock()
		for _, entry := range pt.entries {
			// SAFETY: Signal fails only for a process that already exited, which needs no signal.
			_ = entry.cmd.Process.Signal(syscall.SIGKILL)
		}
	})
}

// ── Structured log line types ───────────────────────────────────────

type execSubmittedLog struct {
	Level    string `json:"level"`
	Time     string `json:"time"`
	Event    string `json:"event"`
	ExecID   string `json:"exec_id"`
	DedupHit bool   `json:"dedup_hit"`
}

type execStartLog struct {
	Level   string `json:"level"`
	Time    string `json:"time"`
	Event   string `json:"event"`
	TraceID string `json:"trace_id"`
	ExecID  string `json:"exec_id"`
	Command string `json:"command"`
	Cwd     string `json:"cwd,omitempty"`
	PID     int    `json:"pid"`
}

type execEndLog struct {
	Level      string `json:"level"`
	Time       string `json:"time"`
	Event      string `json:"event"`
	TraceID    string `json:"trace_id"`
	ExecID     string `json:"exec_id"`
	PID        int    `json:"pid"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
}

type execFailLog struct {
	Level      string `json:"level"`
	Time       string `json:"time"`
	Event      string `json:"event"`
	TraceID    string `json:"trace_id"`
	ExecID     string `json:"exec_id"`
	PID        int    `json:"pid"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out,omitempty"`
	StderrTail string `json:"stderr_tail,omitempty"`
}

type execOutputLog struct {
	Level   string `json:"level"`
	Time    string `json:"time"`
	Event   string `json:"event"`
	TraceID string `json:"trace_id"`
	ExecID  string `json:"exec_id"`
	PID     int    `json:"pid"`
	Data    string `json:"data"`
}

type logEntry struct {
	Time       string `json:"time"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	DurationMs int64  `json:"duration_ms"`
	TraceID    string `json:"trace_id"`
}

// emitLog marshals v to JSON and writes it to stdout.
func emitLog(v any) {
	// SAFETY: each caller passes a log struct of string, number, and bool
	// fields, which json.Marshal always encodes.
	data, _ := json.Marshal(v)
	// SAFETY: stdout is the log stream, thus a failed log write has no other place to go.
	_, _ = fmt.Fprintln(os.Stdout, string(data))
}

// ── Stderr ring buffer ──────────────────────────────────────────────

type stderrRingBuffer struct {
	lines    []string
	maxLines int
	maxBytes int
}

func newStderrRingBuffer() *stderrRingBuffer {
	return &stderrRingBuffer{
		maxLines: stderrTailLines,
		maxBytes: stderrTailMaxBytes,
	}
}

func (rb *stderrRingBuffer) add(line string) {
	rb.lines = append(rb.lines, line)
	if len(rb.lines) > rb.maxLines {
		rb.lines = rb.lines[1:]
	}
}

func (rb *stderrRingBuffer) tail() string {
	result := strings.Join(rb.lines, "\n")
	if len(result) > rb.maxBytes {
		result = result[len(result)-rb.maxBytes:]
	}
	return result
}

// ── Preview handler ─────────────────────────────────────────────────

const previewCSP = "default-src 'self'; " +
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net/npm/@tailwindcss/ https://cdn.jsdelivr.net/npm/echarts@5.5.1/; " +
	"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/@fontsource-variable/; " +
	"connect-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' https://cdn.jsdelivr.net/npm/@fontsource-variable/"

func previewHandler(root string) http.HandlerFunc {
	fs := http.FileServer(http.Dir(root))
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		relPath := strings.TrimPrefix(r.URL.Path, "/preview/")
		if relPath == "" {
			relPath = "index.html"
		}
		if strings.Contains(relPath, "..") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			writeBody(w, []byte(`{"error":"invalid path"}`))
			return
		}
		w.Header().Set("Content-Security-Policy", previewCSP)
		r.URL.Path = "/" + relPath
		fs.ServeHTTP(w, r)
	}
}

func previewNotConfiguredHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	writeBody(w, []byte(`{"error":"preview not configured"}`))
}

// ── Handlers ────────────────────────────────────────────────────────

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	writeBody(w, []byte(`{"status":"ok"}`))
}

// pollResponseBody is the body of `GET /exec/{execId}?since={cursor}`: the
// events newer than the caller's cursor, the new high-water cursor, whether
// events were ever shed, and the terminal completion `result` (present only once
// the exec is terminal; the host reads terminality from it).
type pollResponseBody struct {
	Status    string          `json:"status"`
	Events    []ringEvent     `json:"events"`
	Cursor    int64           `json:"cursor"`
	Truncated bool            `json:"truncated,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

// execResultHandler serves the poll of an exec at `GET /exec/{execId}`.
func execResultHandler(table *execTable) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONResponse(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		execID := strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "exec/")
		if execID == "" || strings.Contains(execID, "/") {
			// An execId never contains a slash, so any remaining path separator is
			// an unroutable request.
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
			return
		}
		servePollResult(w, r, table, execID)
	}
}

// servePollResult answers the `?since={cursor}` poll: an atomic snapshot of the
// events past the cursor plus the terminal result if the exec has finished.
// The result bytes are the exact completion bytes, provenance frame included.
func servePollResult(w http.ResponseWriter, r *http.Request, table *execTable, execID string) {
	// SAFETY: an absent, empty, or unparseable `since` reads as 0 — serve from the start
	// of the ring rather than erroring on a cursor the host controls.
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if since < 0 {
		since = 0
	}

	snap, ok := table.pollSnapshotFor(execID, since)
	if !ok {
		writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "unknown execId"})
		return
	}

	events := snap.events
	if events == nil {
		events = []ringEvent{}
	}
	body, err := json.Marshal(pollResponseBody{
		Status:    string(snap.status),
		Events:    events,
		Cursor:    snap.cursor,
		Truncated: snap.truncated,
		Result:    json.RawMessage(snap.body),
	})
	if err != nil {
		writeJSONResponse(w, http.StatusInternalServerError, map[string]string{"error": "marshal failed"})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	writeBody(w, body)
}

// ── Logging middleware ──────────────────────────────────────────────

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rw, r)
		if r.URL.Path == "/health" {
			return
		}
		entry := logEntry{
			Time:       time.Now().UTC().Format(time.RFC3339),
			Method:     r.Method,
			Path:       r.URL.Path,
			Status:     rw.statusCode,
			DurationMs: time.Since(start).Milliseconds(),
			TraceID:    extractTraceID(r),
		}
		emitLog(entry)
	})
}

type responseWriter struct {
	http.ResponseWriter
	statusCode  int
	wroteHeader bool
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.wroteHeader {
		rw.statusCode = code
		rw.wroteHeader = true
	}
	rw.ResponseWriter.WriteHeader(code)
}

// ── Helpers ─────────────────────────────────────────────────────────

func writeJSONResponse(w http.ResponseWriter, status int, v any) {
	// SAFETY: each caller passes a string map or a struct of plain fields,
	// which json.Marshal always encodes.
	data, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeBody(w, append(data, '\n'))
}

func writeBody(w http.ResponseWriter, body []byte) {
	// SAFETY: the status line is already sent, thus a failed write (a peer that
	// went away) has no other channel to the peer.
	_, _ = w.Write(body)
}

// ── Main ────────────────────────────────────────────────────────────

func main() {
	initLogLevel()

	if err := verifyPrivilegeDrop(os.Getenv(envEgressFirewall), os.Geteuid()); err != nil {
		log.Fatalf("startup confinement error: %v", err)
	}

	port := os.Getenv("SANDBOX_SERVER_PORT")
	if port == "" {
		port = defaultPort
	}

	pt := newProcessTable()
	table := newExecTable()
	exe := newExecutor(table, pt)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/exec", http.HandlerFunc(exe.handle))
	mux.Handle("/exec/", execResultHandler(table))

	previewRoot := os.Getenv("PREVIEW_ROOT")
	if previewRoot != "" {
		mux.Handle("/preview/", previewHandler(previewRoot))
	} else {
		mux.HandleFunc("/preview/", previewNotConfiguredHandler)
	}

	handler := loggingMiddleware(mux)

	srv := &http.Server{Addr: "0.0.0.0:" + port, Handler: handler, ReadHeaderTimeout: readHeaderTimeout}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	var serveWG sync.WaitGroup
	serveWG.Go(func() {
		if previewRoot != "" {
			log.Printf("sandbox-server listening on :%s (preview: %s)", port, previewRoot) //nolint:gosec // G706: the image sets the port and the preview root, not a request
		} else {
			log.Printf("sandbox-server listening on :%s (preview: disabled)", port) //nolint:gosec // G706: the image sets the port, not a request
		}
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	})

	<-stop
	log.Println("shutting down...")

	pt.killAll()

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace) //nolint:forbidigo // main starts the process, thus no caller context exists
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	serveWG.Wait()
	log.Println("shutdown complete")
}
