# Sandbox Provenance Hooks — Deep Review

## Status: Complete — Findings Below

**Governing specs (verified against implementation):**
- `harness/openspec/specs/sandbox-provenance-tracking/spec.md` — formal requirements for all 4 layers, dedup caps, socket lifecycle, debug diagnostics
- `harness/openspec/specs/exec-provenance-lineage/spec.md` — how frames flow into the ProvenanceCollector and registration

**Additional file reviewed:** `images/sandbox-base/server/treediff.go` (126 lines) — periodic directory differ that snapshots a root dir and reports added/modified/removed files. NOT a provenance system — it's a UI progress mechanism for showing file changes during command execution. Unrelated to the provenance hooks.

## 1. Architecture Summary

Four observation layers, all reporting to the Go sandbox-server via Unix datagram socket (or R log file):

```
Command exec (python3 script.py)
  ├─ Layer 1: Python audit hook (sitecustomize.py)
  │    └─ sys.addaudithook → intercepts PEP 578 "open" events
  │    └─ Sends JSON datagrams to Unix socket
  │
  ├─ Layer 2: C LD_PRELOAD (provtrack.c → provtrack.so)
  │    └─ Intercepts open/openat/fopen/unlink at libc level
  │    └─ Sends JSON datagrams to Unix socket
  │
  ├─ Layer 3: R trace hooks (Rprofile.site)
  │    └─ Wraps read.csv/writeLines/save etc. via trace()
  │    └─ Writes to sidecar file ($PROVENANCE_SOCKET.rlog)
  │
  └─ Layer 4: inotify verification (provenance_inotify_linux.go)
       └─ Watches data dirs recursively
       └─ Records IN_OPEN/IN_CREATE/IN_DELETE/IN_MOVED_*

All → ProvenanceTracker.Stop() → merged {reads, writes, deletes} with per-path layer attribution
  → ExecResult.provenance → harness feedExecFrame() → ProvenanceCollector
```

## 2. Python Hook — `sitecustomize.py` (89 lines)

### What it does well
- C-level audit hook via PEP 578 — cannot be removed once installed
- Classifies by mode: `w/a/x` → write, else → read
- Handles both mode-string opens (`open(path, "r")`) and flags-based opens (`os.open(path, O_RDONLY)`)
- Dedup by `(abspath, op)` with 32K cap
- Silent failure — socket send errors never crash the user's script
- Prefix filtering — only tracks files under `PROVENANCE_DATA_PREFIXES`

### Findings

**Finding 1 (minor): `os.open` flags detection uses `args[2]` but audit hook provides `args[1]` for flags.**

At `sitecustomize.py:74-78`:
```python
elif len(args) > 2:
    # flags-based open (os.open)
    flags = args[2] if isinstance(args[2], int) else 0
```

The PEP 578 `open` audit event provides `(path, mode, flags)` as args. For `os.open()`, the audit event is `open(path_str, None, flags_int)` — so `mode` is `args[1]` (None) and `flags` is `args[2]`. The code checks `len(args) > 2` then reads `args[2]`, which IS correct for `os.open()`.

However, there's a subtlety: if `args[1]` is None (as in `os.open`), the code falls through past the `isinstance(args[1], str)` check at line 70-73, into the `elif len(args) > 2` branch at line 74. This works correctly because None is not a string. **No bug here — the fallthrough is intentional.**

**Finding 2 (coverage gap): `os.rename` and `shutil` operations are not tracked.**

The hook only intercepts `open`, `os.remove`, and `os.unlink` audit events. It does NOT track:
- `os.rename(src, dst)` — moves a file (the source disappears, destination appears)
- `shutil.copy/copy2/move` — copies or moves files
- `os.link` — creates hard links
- `os.symlink` — creates symbolic links

For the provenance use case (tracking what a bioinformatics script reads and writes), the `open` event covers the vast majority of I/O. `rename` and `shutil` are edge cases. The inotify layer catches `IN_MOVED_FROM`/`IN_MOVED_TO` which covers renames at the filesystem level.

**Verdict: Acceptable — inotify provides backup coverage for moves/renames.**

**Finding 3 (no issue): Socket creation per send is wasteful but correct.**

At `sitecustomize.py:35-43`, a new `SOCK_DGRAM` socket is created for every `_send()` call. This is valid for datagrams (connectionless) and avoids stale socket state. The overhead is negligible compared to the I/O operations being tracked.

## 3. C LD_PRELOAD Hook — `provtrack.c` (345 lines)

### What it does well
- Intercepts at libc level — catches C extensions (h5py, numpy, BLAS) that bypass Python
- Thread-safe: `pthread_mutex_t` protects dedup table and init
- Double-checked locking on init (line 63-101)
- Handles `openat` with explicit `dirfd` resolution via `/proc/self/fd/{dirfd}` (line 259-269)
- JSON path escaping for backslashes and double-quotes (line 156-162)
- Buffer overflow safe: `ei < (int)sizeof(escaped) - 3` check on escape buffer
- `MSG_DONTWAIT` on socket send — non-blocking

### Findings

**Finding 4 (potential issue): `open()` with `O_CREAT` but no mode argument is undefined behavior.**

At `provtrack.c:217-222`:
```c
int open(const char *path, int flags, ...) {
    init();
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
```

This correctly reads the mode only when `O_CREAT` is set. If a caller passes `O_CREAT` without a mode argument, reading `va_arg` is UB — but that's the caller's bug, not ours. The real libc `open()` has the same contract. **No bug in the hook.**

**Finding 5 (minor gap): `realpath()` failure silently drops the event.**

At `provtrack.c:138`:
```c
if (!realpath(path, abspath)) return;
```

If a relative path can't be resolved (e.g., the file doesn't exist yet on a write), `realpath()` fails and the provenance event is silently dropped. For writes to NEW files, `realpath` will fail because the file doesn't exist at `open()` time.

**This means writes to new files via relative paths are NOT tracked by the C hook.** The Python hook uses `os.path.abspath()` instead, which doesn't require the file to exist.

**Mitigated by:** inotify catches `IN_CREATE` for new files. Also, absolute paths (which don't go through `realpath`) are tracked correctly. And the Python audit hook runs in the same process and catches the same `open` call.

**Severity: Low** — redundant coverage from Python hook + inotify. But worth noting.

**Finding 6 (minor): Linear scan dedup is O(n²) in the worst case.**

At `provtrack.c:115-121`:
```c
static int already_seen(const char *key) {
    if (seen_count >= MAX_SEEN) return 0;
    for (int i = 0; i < seen_count; i++) {
        if (strcmp(seen_keys[i], key) == 0) return 1;
    }
    return 0;
}
```

With up to 32768 entries, the worst-case dedup check is O(32768) string comparisons. Under the mutex. For a typical bioinformatics script reading hundreds of files, this is fine. For a script that opens 32K+ distinct files, the mutex contention could become noticeable. **Not a practical concern for the use case.**

**Finding 7 (no issue): `strncpy` for `sun_path` is correct.**

At `provtrack.c:181`:
```c
strncpy(addr.sun_path, prov_socket_path, sizeof(addr.sun_path) - 1);
```

This is the correct pattern for `sockaddr_un.sun_path` — no null-termination issue because `memset` zeroed the struct.

## 4. R Hooks — `Rprofile.site` (201 lines)

### What it does well
- Uses R's `trace()` mechanism — hooks into function entry, not exit
- Handles both named args and `...` args (e.g., `file.remove(...)`)
- Package-level hooks via `setHook(packageEvent())` — instruments readr/data.table/readxl/arrow/vroom/haven at load time
- Manual JSON construction — no dependency on jsonlite
- Writes to sidecar file (`$PROVENANCE_SOCKET.rlog`) because R has no Unix socket support
- Dedup via environment with 32K cap
- All tryCatch-wrapped — hook failures never crash user code

### Findings

**Finding 8 (coverage gap): `con` argument may be a connection object, not a string.**

At `Rprofile.site:96-98`:
```r
"readLines"   = list(pkg = "base", arg = "con"),
"readBin"     = list(pkg = "base", arg = "con"),
"readChar"    = list(pkg = "base", arg = "con"),
```

The `con` parameter in `readLines()`, `readBin()`, `readChar()` can be either a filename (string) or a connection object (from `file()`, `url()`, `gzfile()`, etc.). The tracer at line 72-77 checks `is.character(.prov_val)` which correctly skips connection objects. But this means reads via connection objects are NOT tracked by the R hook.

Example not tracked:
```r
con <- gzfile("data/big.csv.gz", "r")
readLines(con)  # → .prov_val is a connection, not a string
```

**Mitigated by:** The `file()` function IS hooked (line 98: `"file" = list(pkg = "base", arg = "description")`), so `file("data/big.csv.gz")` would be tracked. But `gzfile()`, `bzfile()`, `xzfile()`, `pipe()`, and `url()` are NOT hooked.

**Severity: Medium** — common R pattern for compressed files. LD_PRELOAD and inotify provide backup coverage for the actual file open.

**Finding 9 (coverage gap): Write hooks don't cover `pdf()`, `png()`, `jpeg()`, etc.**

Graphics device functions like `pdf("plot.pdf")`, `png("plot.png")`, `svg("plot.svg")` are major file-writing operations in R bioinformatics scripts. They're not in the `write_map` or `pkg_hooks`. These create files in the output directory.

**Mitigated by:** inotify catches `IN_CREATE` for these files. LD_PRELOAD catches the underlying `fopen()` call.

**Severity: Low** — inotify provides coverage. But the R hook won't attribute these writes with the `"r"` layer label.

**Finding 10 (no issue): `normalizePath(mustWork = FALSE)` is correct.**

At line 32: `normalizePath(path, mustWork = FALSE)` — this correctly resolves relative paths without requiring the file to exist (unlike C's `realpath`). **Good — avoids the C hook's Finding 5 issue.**

## 5. Go Aggregator — `provenance.go` (327 lines)

### What it does well
- Per-exec lifecycle: create tracker → inject env → run command → stop → merge results
- 3-way merge: socket datagrams + R log file + inotify events
- Layer attribution: each path carries which layers observed it (`["python", "inotify"]`)
- Sorted, deterministic output
- Graceful degradation: if tracker start fails, `provenanceDisabled = true` is carried in the result

### Findings

**Finding 11 (potential race): `readLoop` `select` with `default` branch.**

At `provenance.go:208-233`:
```go
select {
case <-pt.stopCh:
    // drain with fresh deadline
    pt.listener.SetReadDeadline(time.Now().Add(provenanceDrainTimeout))
    for { ... }
default:
    pt.listener.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
    n, _, err := pt.listener.ReadFrom(buf)
    ...
}
```

The `default` branch means the loop polls every 100ms. When `stopCh` closes, the next iteration picks it up. But there's a window: if the `default` branch is in the middle of `ReadFrom` when `stopCh` closes, it will finish the current read (up to 100ms timeout), then the next iteration enters the `case <-pt.stopCh` branch.

**This is correct but slightly suboptimal** — the 100ms polling interval means up to 100ms latency between command exit and final drain start. Combined with the 200ms drain timeout, the total overhead is up to 300ms per exec. For bioinformatics scripts that run for seconds to minutes, this is negligible.

**No bug, but worth noting for latency-sensitive use cases.**

**Finding 12 (minor): `PROVENANCE_DATA_PREFIXES` vs `PROVENANCE_WATCH_DIRS` divergence.**

Two different env vars control two different things:
- `PROVENANCE_DATA_PREFIXES` (colon-separated) — controls prefix filtering in Python/C/R hooks
- `PROVENANCE_WATCH_DIRS` (comma-separated) — controls inotify watch directories

At `provenance.go:196-198`, the tracker passes `watchDirs` as `PROVENANCE_DATA_PREFIXES`:
```go
env = append(env, "PROVENANCE_DATA_PREFIXES="+strings.Join(pt.watchDirs, ":"))
```

And at `provenance.go:304-326`, `provenanceWatchDirs()` reads `PROVENANCE_WATCH_DIRS` (comma-separated).

**The two vars use different separators** (`:` for prefixes, `,` for watch dirs) which is intentional — prefixes follow the PATH convention, watch dirs follow a simpler format. But the hooks and inotify may watch different sets of paths if the env vars are configured independently.

In practice, the executor creates the tracker with `provenanceWatchDirs()` and the tracker injects `PROVENANCE_DATA_PREFIXES` from those same dirs. So they're always in sync. **No bug.**

**Finding 13 (potential issue): R log file read happens after inotify stop.**

At `provenance.go:138-142`:
```go
pt.inotify.stop()
pt.readRlog()
os.Remove(pt.rlogPath)
```

If the R script is still flushing its last log line when `inotify.stop()` runs, the stop call waits (drain with 200ms timeout). But `readRlog()` opens the file after inotify stops, so any R writes that happen during inotify's drain window would still be captured — the file is read after all watchers are done.

**No bug — ordering is correct: socket drain → inotify drain → R log read.**

## 6. inotify Watcher — `provenance_inotify_linux.go` (168 lines)

### Findings

**Finding 14 (by design): inotify only watches directories, not files.**

Inotify watches are added per-directory (`InotifyAddWatch(fd, path, ...)` where `path` is a directory). This means:
- `IN_OPEN` fires for any file opened in the directory
- `IN_CREATE` fires for any new file created
- But subdirectories created AFTER the initial walk are NOT watched

**This is a known limitation:** if a script creates a new subdirectory and writes files into it, inotify won't see those writes. The walk at `start()` time is static.

**Mitigated by:** Python/C/R hooks track the actual `open()` calls regardless of directory creation order.

**Finding 15 (minor): `IN_MODIFY` is not watched.**

The inotify mask at line 59-60:
```go
unix.IN_OPEN|unix.IN_CREATE|unix.IN_DELETE|unix.IN_MOVED_FROM|unix.IN_MOVED_TO
```

`IN_MODIFY` is NOT included. This means inotify doesn't track writes to existing files (only creation of new files via `IN_CREATE`). If a script opens an existing file for writing (append), inotify sees the `IN_OPEN` and classifies it as `"read"` (line 152: default case).

**This is intentional:** the inotify layer is a verification channel, not the primary source. The Python/C hooks correctly classify opens by mode/flags. inotify's `IN_OPEN` without `IN_MODIFY` can't distinguish reads from writes, so it defaults to `"read"`. The per-file layer attribution lets the consumer see that Python said "write" while inotify said "read" — the Python/C classification wins.

## 7. Is Anything Extra or Bad Happening?

### Nothing malicious or unnecessary

The hooks only:
1. Observe file operations (they don't modify them)
2. Filter to configured data prefixes (they ignore non-data files)
3. Send reports via a local Unix socket or file (no network, no external service)
4. Dedup to limit volume (32K cap per layer per process)
5. Fail silently (user code is never affected by hook failures)

### Overhead assessment

- **Python hook:** One `sendto()` per unique (path, op) — negligible vs I/O
- **C hook:** Same, plus mutex acquisition — negligible for typical workloads
- **R hook:** File append per unique (path, op) — negligible
- **inotify:** Kernel-level, passive — near-zero overhead
- **Go aggregator:** One socket reader goroutine + one inotify reader goroutine per exec
- **Drain window:** Up to 300ms per exec (100ms poll + 200ms drain)

### Will everything be reported?

**Yes, with caveats:**

| Scenario | Reported? | By which layer(s) |
|----------|-----------|-------------------|
| Python reads a CSV | Yes | python + preload + inotify |
| Python writes a CSV | Yes | python + preload + inotify(IN_CREATE for new files) |
| R reads via `read.csv()` | Yes | r + preload + inotify |
| R writes via `write.csv()` | Yes | r + preload + inotify |
| R reads via `gzfile()` connection | Partial | preload + inotify (R hook misses it) |
| R creates a plot via `pdf()` | Partial | preload + inotify (R hook misses it) |
| C extension reads (h5py) | Yes | preload + inotify |
| New file via relative path in C | Partial | python + inotify (C hook's `realpath` fails for new files) |
| `os.rename()` | Partial | inotify only (IN_MOVED_FROM + IN_MOVED_TO) |
| File in newly-created subdirectory | Partial | python + preload (inotify misses new subdirs) |
| Shell commands (bash/awk/sed) | Partial | preload + inotify (no shell-level hook) |

## 8. Recommendations

### No action needed (solid implementation)

1. The 4-layer design provides excellent redundancy — no single layer failure loses all tracking
2. Silent failure mode is correct — provenance is best-effort, must never crash user code
3. Dedup with 32K cap is pragmatic — prevents unbounded memory growth
4. Layer attribution lets consumers reason about confidence (3 layers saw it = high confidence)

### Nice-to-have improvements (not blocking)

1. **R hook:** Add `gzfile`, `bzfile`, `xzfile` to the base function map (these create connections that reference file paths)
2. **R hook:** Add `pdf`, `png`, `jpeg`, `svg`, `tiff`, `bmp` to `write_map` (graphics device opens)
3. **C hook:** For relative paths on write, use `getcwd()` + path concatenation instead of `realpath()` to avoid dropping new-file writes
4. **inotify:** Consider `IN_MODIFY` if write-to-existing-file detection matters (would increase event volume)

## 9. Spec Conformance

Verified the implementation against the two governing OpenSpec specs:

### `sandbox-provenance-tracking` spec — all requirements met

| Requirement | Status | Notes |
|-------------|--------|-------|
| Python audit hook tracks file I/O | Met | `sitecustomize.py` implements all scenarios |
| R trace hooks track file I/O | Met | `Rprofile.site` with base + package hooks |
| LD_PRELOAD intercepts C-level operations | Met | `provtrack.c` covers all interceptors |
| LD_PRELOAD escapes file paths in JSON | Met | Buffer-overflow-safe escape loop (Finding 7) |
| LD_PRELOAD is thread-safe | Met | `pthread_mutex_t` on dedup table |
| inotify provides verification channel | Met | `provenance_inotify_linux.go` with recursive watch |
| Debug diagnostics when PROVENANCE_DEBUG=1 | Met | All 3 layers + Go server respect the flag |
| Dedup sets capped at 32,768 | Met | Identical cap in all 3 layers |
| Socket lifecycle per command | Met | `NewProvenanceTracker` → `Start()` → `Stop()` |
| sandbox-server activates layers per command | Met | `Env()` injects PYTHONPATH, R_PROFILE, LD_PRELOAD, PROVENANCE_SOCKET, PROVENANCE_DATA_PREFIXES |

### `exec-provenance-lineage` spec — all requirements met

| Requirement | Status | Notes |
|-------------|--------|-------|
| Each exec frame threaded into step-scoped collector | Met | `feedExecFrame()` at `exec-frame.ts:44` |
| Post-step registration consumes runtime-derived lineage | Met | `reconcileAndRegisterStepArtifacts` passes collector |
| Provenance capture scoped to analysis resource mount | Met | `PROVENANCE_WATCH_DIRS` set to `/{resourceId}` |

### Spec gap: `python -S` known limitation

The spec at lines 89-94 explicitly documents that `python -S` (skipping the site module) bypasses the Python audit hook. LD_PRELOAD still catches these reads. This is accepted and documented — not a spec violation.

### treediff.go — not a provenance system

`images/sandbox-base/server/treediff.go` (126 lines) implements a periodic directory differ that snapshots a root dir every 2 seconds and reports added/modified/removed files. This is used for UI progress feedback during command execution — it is NOT part of the provenance system and does not affect lineage tracking.
