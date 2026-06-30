// sandbox-server is an HTTP server embedded in Inflexa sandbox containers.
// It exposes a submit-and-return command-execution protocol: POST /exec
// accepts {command, execId, ...}, spawns the command in the background,
// returns HTTP 202 immediately, and emits on-change tree-diff events plus a
// completion callback to Cortex over signed callbacks.
//
// Endpoints:
//   GET  /health          → readiness probe
//   POST /exec            → submit a command (returns 202); progress + result
//                           flow to Cortex via outbound callbacks.
//   POST /exec/{pid}/kill → kill a running process
//   GET  /preview/...     → static file preview (when PREVIEW_ROOT is set)
//
// Required env:
//   CORTEX_BASE_URL          base URL Cortex listens on for callbacks
//   SANDBOX_CALLBACK_SECRET  per-sandbox HMAC secret (raw or base64:)
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
	logLevelInfo  logLevel = iota
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

// ── Process tracking (kill endpoint only) ───────────────────────────

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

func killHandler(pt *processTable) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) != 3 || parts[0] != "exec" || parts[2] != "kill" {
			http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
			return
		}
		pid, err := strconv.Atoi(parts[1])
		if err != nil {
			http.Error(w, `{"error":"invalid pid"}`, http.StatusBadRequest)
			return
		}

		entry, ok := pt.get(pid)
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"process not found"}`))
			return
		}

		_ = entry.cmd.Process.Signal(syscall.SIGTERM)
		go func() {
			time.Sleep(killEscalationWait)
			if e, exists := pt.get(pid); exists {
				_ = e.cmd.Process.Signal(syscall.SIGKILL)
			}
		}()

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"killed":true}`))
	}
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

	log.Printf("sandbox-server config: cortex=%s callback_secret_bytes=%d", cfg.cortexBaseURL, len(cfg.callbackSecret))

	port := os.Getenv("SANDBOX_SERVER_PORT")
	if port == "" {
		port = defaultPort
	}

	pt := newProcessTable()
	table := newExecTable()
	stopSweeper := table.startTTLSweeper(5*time.Minute, completedEntryTTL)
	defer stopSweeper()

	callback := newCallbackClient(cfg.cortexBaseURL, cfg.callbackSecret)
	exe := newExecutor(table, callback, pt)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/exec", http.HandlerFunc(exe.handle))
	mux.Handle("/exec/", killHandler(pt))

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
