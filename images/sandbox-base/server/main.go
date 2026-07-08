// sandbox-server is an HTTP server embedded in Inflexa sandbox containers.
// It exposes a submit-and-return command-execution protocol: POST /exec
// accepts {command, execId, ...}, spawns the command in the background, and
// returns HTTP 202 immediately. Progress events (on-change tree-diffs) and the
// terminal result reach the host by one of two transports, selected by
// SANDBOX_TRANSPORT:
//
//   - poll (default): the server never dials out. Events accumulate in a
//     bounded per-exec ring and both events and the terminal result are served,
//     signed, from GET /exec/{execId}?since={cursor}. The host asks; the sandbox
//     initiates nothing and needs no egress.
//   - callback: the server POSTs signed event and completion callbacks to
//     CORTEX_BASE_URL (the push path). The completion bytes are still recorded
//     in the exec table first, so GET /exec/{execId} remains the recovery
//     backstop for a push that never lands.
//
// The exec endpoints are signature-authenticated in BOTH modes: the caller signs
// `HMAC-SHA256(SANDBOX_CALLBACK_SECRET, "${execId}:${timestamp}:${sha256Hex(body)}")`
// into `X-Sandbox-Signature` / `X-Sandbox-Timestamp` — the same construction the
// served/pushed bodies use — and the server verifies it against a freshness
// window. It is a request signature, not a bearer, so any cleartext hop can drop
// a request but never mint another — see inbound_auth.go.
//
// Endpoints:
//
//	GET  /health          → readiness probe (unauthenticated)
//	POST /exec            → submit a command (returns 202); signed.
//	GET  /exec/{execId}   → terminal result, fresh-signed (or `{"status":"running"}`
//	                        while executing); signed. With `?since={cursor}` (poll
//	                        mode) returns `{status, events, cursor, truncated?, result?}`,
//	                        always signed.
//	GET  /preview/...     → static file preview (unauthenticated, and inert unless
//	                        PREVIEW_ROOT is set — the shipped image never sets it).
//
// Env:
//
//	SANDBOX_TRANSPORT        `poll` (default) | `callback`
//	SANDBOX_CALLBACK_SECRET  per-sandbox HMAC secret (raw or base64:); required in both modes
//	CORTEX_BASE_URL          base URL Cortex listens on for callbacks; required in callback mode only
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
		log.Printf("WARNING: invalid SANDBOX_LOG_LEVEL=%q, falling back to info", v)
	}
}

// ── Trace context ───────────────────────────────────────────────────

// extractTraceId parses the W3C traceparent header and returns the 32-char
// hex trace ID. Returns "" if the header is absent or malformed.
func extractTraceId(r *http.Request) string {
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

func (pt *processTable) get(pid int) (*processEntry, bool) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	e, ok := pt.entries[pid]
	return e, ok
}

func (pt *processTable) killAll() {
	pt.mu.Lock()
	entries := make(map[int]*processEntry, len(pt.entries))
	for k, v := range pt.entries {
		entries[k] = v
	}
	pt.mu.Unlock()

	for _, entry := range entries {
		_ = entry.cmd.Process.Signal(syscall.SIGTERM)
	}

	time.AfterFunc(killEscalationWait, func() {
		pt.mu.Lock()
		defer pt.mu.Unlock()
		for _, entry := range pt.entries {
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
	data, _ := json.Marshal(v)
	fmt.Fprintln(os.Stdout, string(data))
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
			_, _ = w.Write([]byte(`{"error":"invalid path"}`))
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
	_, _ = w.Write([]byte(`{"error":"preview not configured"}`))
}

// ── Handlers ────────────────────────────────────────────────────────

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// pollResponseBody is the poll-mode body for `GET /exec/{execId}?since={cursor}`:
// the events newer than the caller's cursor, the new high-water cursor, whether
// events were ever shed, and the terminal completion `result` (present only once
// the exec is terminal). The whole body is signed, so the host verifies it
// exactly as it verifies a pushed completion.
type pollResponseBody struct {
	Status    string          `json:"status"`
	Events    []ringEvent     `json:"events"`
	Cursor    int64           `json:"cursor"`
	Truncated bool            `json:"truncated,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

// execResultHandler serves an exec's result at `GET /exec/{execId}`, signed
// fresh at request time so it is accepted by the host's freshness window however
// long after the exec finished it is fetched. It has two shapes:
//
//   - `?since={cursor}` present (poll mode): the {status, events, cursor,
//     result?} body above, ALWAYS signed — the host verifies every poll and
//     reads terminality from `result`.
//   - `?since` absent (callback-mode recovery pull, and the legacy shape): the
//     raw completion body when terminal, signed; `{"status":"running"}`
//     (unsigned) while executing.
//
// Either way the served result bytes are the exact ones a completion callback
// carries, so a pulled result is indistinguishable from a pushed one —
// provenance frame included.
//
// The request itself is signature-authenticated: the disclosed result includes
// the command's stdout/stderr, so an unauthenticated caller must not read it.
func execResultHandler(table *execTable, auth inboundAuth) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONResponse(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		execID := strings.TrimPrefix(strings.Trim(r.URL.Path, "/"), "exec/")
		if execID == "" || strings.Contains(execID, "/") {
			// An execId never contains a slash, so any remaining path separator is
			// an unroutable request (e.g. the retired `/exec/{pid}/kill`).
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
			return
		}
		if !auth.authentic(r, execID, nil) {
			writeUnauthorized(w)
			return
		}

		if r.URL.Query().Has("since") {
			servePollResult(w, r, table, auth, execID)
			return
		}

		status, body, ok := table.completionSnapshot(execID)
		if !ok {
			writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "unknown execId"})
			return
		}
		// A terminal status with no recorded body means the exec finished between
		// `complete` and `setCompletionBody`. Report it as still running: the
		// caller retries, and the body lands microseconds later.
		if status == execStatusRunning || body == nil {
			writeJSONResponse(w, http.StatusOK, map[string]string{"execId": execID, "status": string(execStatusRunning)})
			return
		}

		ts := time.Now().Unix()
		w.Header().Set(headerSignature, signCallback(auth.secret, execID, ts, body))
		w.Header().Set(headerTimestamp, strconv.FormatInt(ts, 10))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}
}

// servePollResult answers the `?since={cursor}` poll: an atomic snapshot of the
// events past the cursor plus the terminal result if the exec has finished,
// signed fresh over the whole body.
func servePollResult(w http.ResponseWriter, r *http.Request, table *execTable, auth inboundAuth, execID string) {
	// An absent, empty, or unparseable `since` reads as 0 — serve from the start
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

	ts := time.Now().Unix()
	w.Header().Set(headerSignature, signCallback(auth.secret, execID, ts, body))
	w.Header().Set(headerTimestamp, strconv.FormatInt(ts, 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
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
			TraceID:    extractTraceId(r),
		}
		data, _ := json.Marshal(entry)
		fmt.Fprintln(os.Stdout, string(data))
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
	data, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
	_, _ = w.Write([]byte("\n"))
}

// ── Main ────────────────────────────────────────────────────────────

func main() {
	initLogLevel()

	cfg, err := loadServerConfig()
	if err != nil {
		log.Fatalf("startup config error: %v", err)
	}

	log.Printf("sandbox-server config: transport=%s cortex=%s callback_secret_bytes=%d", cfg.transport, cfg.cortexBaseURL, len(cfg.callbackSecret))

	port := os.Getenv("SANDBOX_SERVER_PORT")
	if port == "" {
		port = defaultPort
	}

	pt := newProcessTable()
	table := newExecTable()
	stopSweeper := table.startTTLSweeper(5*time.Minute, completedEntryTTL)
	defer stopSweeper()

	// Poll mode never initiates a connection, so it constructs no callback client;
	// the executor buffers results in the exec table for the host to pull instead.
	var callback *callbackClient
	if cfg.transport == transportCallback {
		callback = newCallbackClient(cfg.cortexBaseURL, cfg.callbackSecret)
	}
	auth := newInboundAuth(cfg.callbackSecret)
	exe := newExecutor(table, callback, pt, auth, cfg.transport)

	mux := http.NewServeMux()
	// `/health` is intentionally unauthenticated: it is a readiness probe that
	// exposes no data and performs no action. Every other endpoint is signed.
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/exec", http.HandlerFunc(exe.handle))
	mux.Handle("/exec/", execResultHandler(table, auth))

	previewRoot := os.Getenv("PREVIEW_ROOT")
	if previewRoot != "" {
		mux.Handle("/preview/", http.HandlerFunc(previewHandler(previewRoot)))
	} else {
		mux.HandleFunc("/preview/", previewNotConfiguredHandler)
	}

	handler := loggingMiddleware(mux)

	srv := &http.Server{Addr: "0.0.0.0:" + port, Handler: handler}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		if previewRoot != "" {
			log.Printf("sandbox-server listening on :%s (preview: %s)", port, previewRoot)
		} else {
			log.Printf("sandbox-server listening on :%s (preview: disabled)", port)
		}
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-stop
	log.Println("shutting down...")

	pt.killAll()

	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("shutdown complete")
}
