package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// execSubmitRequest is the new submit-and-return body for POST /exec.
type execSubmitRequest struct {
	Command        []string          `json:"command"`
	ExecID         string            `json:"execId"`
	Cwd            string            `json:"cwd,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
}

type execSubmitResponse struct {
	ExecID string `json:"execId"`
	Status string `json:"status"`
}

// eventPayload is the body POSTed to /sandbox/:execId/event for tree-diff and
// related on-change events. The Kind discriminator carries the event family.
type eventPayload struct {
	ExecID    string    `json:"execId"`
	Kind      string    `json:"kind"` // "file-tree" | "tool-activity" | "phase"
	Timestamp int64     `json:"timestamp"`
	Tree      *treeDiff `json:"tree,omitempty"`
}

// completionPayload is the body POSTed to /sandbox/:execId/complete.
type completionPayload struct {
	ExecID     string             `json:"execId"`
	ExitCode   int                `json:"exitCode"`
	Stdout     string             `json:"stdout"`
	Stderr     string             `json:"stderr"`
	DurationMs int64              `json:"durationMs"`
	TimedOut   bool               `json:"timedOut,omitempty"`
	Provenance *provenancePayload `json:"provenance,omitempty"`
}

type provenancePayload struct {
	Disabled bool              `json:"disabled,omitempty"`
	Reads    []ProvenanceEntry `json:"reads,omitempty"`
	Writes   []ProvenanceEntry `json:"writes,omitempty"`
	Deletes  []ProvenanceEntry `json:"deletes,omitempty"`
}

// executor wires the dedup table to the callback client. One executor per server.
type executor struct {
	table    *execTable
	callback *callbackClient
	procs    *processTable
}

func newExecutor(table *execTable, callback *callbackClient, procs *processTable) *executor {
	return &executor{table: table, callback: callback, procs: procs}
}

// handle is the POST /exec submit handler. Validates the request, dedups by
// execId, spawns the background goroutine on a fresh execId, and returns 202.
func (e *executor) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONResponse(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req execSubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if strings.TrimSpace(req.ExecID) == "" {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "execId required"})
		return
	}
	if len(req.Command) == 0 {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "command is required"})
		return
	}

	traceID := extractTraceId(r)
	status, isNew := e.table.reserve(req.ExecID)
	emitLog(execSubmittedLog{
		Level: "info", Time: nowRFC3339(), Event: "exec.submitted",
		ExecID: req.ExecID, DedupHit: !isNew,
	})

	if !isNew {
		writeJSONResponse(w, http.StatusAccepted, execSubmitResponse{ExecID: req.ExecID, Status: string(status)})
		return
	}

	go e.run(req, traceID)
	writeJSONResponse(w, http.StatusAccepted, execSubmitResponse{ExecID: req.ExecID, Status: string(execStatusRunning)})
}

// run executes the command in the background. It owns the full lifecycle:
// spawn, structured logs, tree-diff emission, completion callback.
func (e *executor) run(req execSubmitRequest, traceID string) {
	cmdStr := truncateCommand(req.Command, commandMaxLen)
	startedAt := time.Now()

	rootCtx := context.Background()
	var ctx context.Context
	var cancel context.CancelFunc
	if req.TimeoutSeconds > 0 {
		ctx, cancel = context.WithTimeout(rootCtx, time.Duration(req.TimeoutSeconds)*time.Second)
	} else {
		ctx, cancel = context.WithCancel(rootCtx)
	}
	defer cancel()

	cmd := buildCommand(ctx, req)

	provTracker := NewProvenanceTracker(
		fmt.Sprintf("%s-%d", sanitizeForFilename(req.ExecID), time.Now().UnixNano()),
		provenanceWatchDirs(),
	)
	provenanceDisabled := false
	if err := provTracker.Start(); err != nil {
		log.Printf("[provenance] tracker start failed: %v", err)
		provenanceDisabled = true
	}
	cmd.Env = append(cmd.Env, provTracker.Env()...)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		e.failBeforeSpawn(req.ExecID, traceID, cmdStr, req.Cwd, startedAt, fmt.Sprintf("stdout pipe: %s", err), provTracker, provenanceDisabled)
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		e.failBeforeSpawn(req.ExecID, traceID, cmdStr, req.Cwd, startedAt, fmt.Sprintf("stderr pipe: %s", err), provTracker, provenanceDisabled)
		return
	}

	if err := cmd.Start(); err != nil {
		e.failBeforeSpawn(req.ExecID, traceID, cmdStr, req.Cwd, startedAt, fmt.Sprintf("sandbox-server: spawn failed: %s", err), provTracker, provenanceDisabled)
		return
	}

	pid := cmd.Process.Pid
	e.table.setPID(req.ExecID, pid)
	if e.procs != nil {
		e.procs.add(pid, &processEntry{cmd: cmd, cancel: cancel})
		defer e.procs.remove(pid)
	}

	emitLog(execStartLog{
		Level: "info", Time: nowRFC3339(), Event: "exec.start",
		TraceID: traceID, ExecID: req.ExecID, Command: cmdStr, Cwd: req.Cwd, PID: pid,
	})

	stderrBuf := newStderrRingBuffer()
	var stderrBufMu sync.Mutex
	stdoutBuilder := &capturingBuilder{}
	stderrBuilder := &capturingBuilder{}

	var wg sync.WaitGroup
	wg.Add(2)
	go capturePipe(stdoutPipe, "stdout", traceID, req.ExecID, pid, stdoutBuilder, nil, nil, &wg)
	go capturePipe(stderrPipe, "stderr", traceID, req.ExecID, pid, stderrBuilder, stderrBuf, &stderrBufMu, &wg)

	diffStop := e.startTreeDiffer(ctx, req)

	wg.Wait()
	waitErr := cmd.Wait()
	durationMs := time.Since(startedAt).Milliseconds()

	if diffStop != nil {
		diffStop()
	}

	exitCode := 0
	timedOut := false
	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
		if ctx.Err() == context.DeadlineExceeded {
			exitCode = timeoutExitCode
			timedOut = true
		}
	}

	provResult := provTracker.Stop()
	prov := &provenancePayload{
		Disabled: provenanceDisabled,
		Reads:    provResult.Reads,
		Writes:   provResult.Writes,
		Deletes:  provResult.Deletes,
	}

	stdout := stdoutBuilder.String()
	stderr := stderrBuilder.String()

	status := execStatusCompleted
	if exitCode != 0 {
		status = execStatusFailed
	}
	e.table.complete(req.ExecID, status, &execResult{
		ExitCode:   exitCode,
		Stdout:     stdout,
		Stderr:     stderr,
		DurationMs: durationMs,
		TimedOut:   timedOut,
	})

	now := nowRFC3339()
	if exitCode == 0 {
		emitLog(execEndLog{
			Level: "info", Time: now, Event: "exec.end",
			TraceID: traceID, ExecID: req.ExecID, PID: pid, ExitCode: 0, DurationMs: durationMs,
		})
	} else {
		stderrBufMu.Lock()
		tail := stderrBuf.tail()
		stderrBufMu.Unlock()
		emitLog(execFailLog{
			Level: "warn", Time: now, Event: "exec.fail",
			TraceID: traceID, ExecID: req.ExecID, PID: pid, ExitCode: exitCode, DurationMs: durationMs,
			TimedOut: timedOut, StderrTail: tail,
		})
	}

	e.postCompletion(req.ExecID, completionPayload{
		ExecID:     req.ExecID,
		ExitCode:   exitCode,
		Stdout:     stdout,
		Stderr:     stderr,
		DurationMs: durationMs,
		TimedOut:   timedOut,
		Provenance: prov,
	})
}

func (e *executor) failBeforeSpawn(execID, traceID, cmdStr, cwd string, startedAt time.Time, errMsg string, tracker *ProvenanceTracker, provenanceDisabled bool) {
	durationMs := time.Since(startedAt).Milliseconds()
	now := nowRFC3339()
	emitLog(execStartLog{
		Level: "info", Time: now, Event: "exec.start",
		TraceID: traceID, ExecID: execID, Command: cmdStr, Cwd: cwd, PID: 0,
	})
	emitLog(execFailLog{
		Level: "warn", Time: now, Event: "exec.fail",
		TraceID: traceID, ExecID: execID, PID: 0, ExitCode: 127,
		DurationMs: durationMs, StderrTail: errMsg,
	})

	tracker.Stop()
	e.table.complete(execID, execStatusFailed, &execResult{
		ExitCode: 127, Stderr: errMsg, DurationMs: durationMs,
	})

	prov := &provenancePayload{Disabled: provenanceDisabled}
	e.postCompletion(execID, completionPayload{
		ExecID: execID, ExitCode: 127, Stderr: errMsg, DurationMs: durationMs, Provenance: prov,
	})
}

func (e *executor) postCompletion(execID string, payload completionPayload) {
	if !e.table.markCompletionPosted(execID) {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[completion] marshal failed for %s: %v", execID, err)
		return
	}
	if perr := e.callback.post(context.Background(), callbackKindComplete, execID, body); perr != nil {
		log.Printf("[completion] post failed for %s: %v", execID, perr)
	}
}

// startTreeDiffer launches the periodic tree-diff loop for an exec. Returns a
// stop function (nil when no diff root is configured for this exec).
func (e *executor) startTreeDiffer(ctx context.Context, req execSubmitRequest) func() {
	root := treeDiffRootForExec(req.Cwd)
	if root == "" {
		return nil
	}
	d := newTreeDiffer(root)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(treeDiffInterval())
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				delta, changed := d.tick()
				if !changed {
					continue
				}
				e.emitTreeEvent(req.ExecID, delta)
			}
		}
	}()
	return func() {
		close(stop)
		<-done
		if delta, changed := d.tick(); changed {
			e.emitTreeEvent(req.ExecID, delta)
		}
	}
}

func (e *executor) emitTreeEvent(execID string, delta treeDiff) {
	body, err := json.Marshal(eventPayload{
		ExecID:    execID,
		Kind:      "file-tree",
		Timestamp: time.Now().Unix(),
		Tree:      &delta,
	})
	if err != nil {
		log.Printf("[event] marshal failed for %s: %v", execID, err)
		return
	}
	if perr := e.callback.post(context.Background(), callbackKindEvent, execID, body); perr != nil {
		log.Printf("[event] post failed for %s: %v", execID, perr)
	}
}

// treeDiffRootForExec returns the directory to snapshot for an exec. The cwd
// from the submit takes precedence; otherwise the configured server-wide root.
func treeDiffRootForExec(cwd string) string {
	if cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			return cwd
		}
	}
	if root := os.Getenv(envTreeDiffRoot); root != "" {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			return root
		}
	}
	return ""
}

// sensitiveEnvKeys are the host-privileged variables that reach sandbox-server
// through its own environment and MUST NOT reach the commands it spawns.
//
// Possession of the callback secret is sufficient to forge a signed `/complete`
// callback for any exec — fabricating its exit code, stdout, and provenance
// frame. Leaving it in a spawned command's environment would place the integrity
// of the provenance record inside the trust domain of the very code that record
// is meant to observe.
//
// Stripping them here is safe because loadServerConfig reads both once, at
// startup, before any exec is accepted.
var sensitiveEnvKeys = map[string]struct{}{
	envCallbackSecret: {},
	envCortexBaseURL:  {},
}

// sanitizedEnviron is the server's environment with sensitiveEnvKeys removed.
func sanitizedEnviron() []string {
	src := os.Environ()
	out := make([]string, 0, len(src))
	for _, kv := range src {
		name, _, found := strings.Cut(kv, "=")
		if found {
			if _, sensitive := sensitiveEnvKeys[name]; sensitive {
				continue
			}
		}
		out = append(out, kv)
	}
	return out
}

// buildCommand wraps a single-string command in `sh -c` (matching the prior
// behavior); multi-element commands invoke execve directly.
func buildCommand(ctx context.Context, req execSubmitRequest) *exec.Cmd {
	var cmd *exec.Cmd
	if len(req.Command) == 1 {
		cmd = exec.CommandContext(ctx, "sh", "-c", req.Command[0])
	} else {
		cmd = exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)
	}
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}
	cmd.Env = sanitizedEnviron()
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	return cmd
}

// capturingBuilder is a goroutine-safe in-memory accumulator for stdout/stderr.
type capturingBuilder struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (c *capturingBuilder) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *capturingBuilder) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// capturePipe reads a sub-process pipe line-by-line into builder, emits the
// debug-level per-line log if SANDBOX_LOG_LEVEL=debug, and tees stderr lines
// into the ring buffer if provided.
func capturePipe(pipe io.ReadCloser, kind, traceID, execID string, pid int, builder *capturingBuilder, stderrBuf *stderrRingBuffer, stderrBufMu *sync.Mutex, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		builder.Write([]byte(line))
		builder.Write([]byte("\n"))
		if stderrBuf != nil {
			stderrBufMu.Lock()
			stderrBuf.add(line)
			stderrBufMu.Unlock()
		}
		if sandboxLogLevel == logLevelDebug {
			emitLog(execOutputLog{
				Level: "debug", Time: nowRFC3339(),
				Event:   "exec." + kind,
				TraceID: traceID, ExecID: execID, PID: pid, Data: line + "\n",
			})
		}
	}
	if err := scanner.Err(); err != nil {
		log.Printf("[sandbox-server] %s scanner error for exec %s pid %d: %v", kind, execID, pid, err)
	}
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// sanitizeForFilename keeps the provenance socket path filesystem-safe.
func sanitizeForFilename(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	return b.String()
}
