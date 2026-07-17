# sandbox-provenance-tracking Specification

## Purpose

Capture the file reads, writes, and deletes performed by a sandbox step's
scripts, from inside the container, so the harness can attribute lineage to each
artifact. Capture is layered: three in-container interpreter/libc hooks emit
observations, and a Go inotify watcher in the sandbox-server cross-checks them.

- **Layer 1 — interpreter audit hooks.** A Python `sitecustomize.py` (via
  `sys.addaudithook`) and an R `Rprofile.site` (via `trace()` / `setHook`)
  installed at `/opt/provenance/` report opens, reads, writes, and deletes.
- **Layer 2 — LD_PRELOAD libc interception.** `provtrack.c`, compiled to
  `/opt/provenance/provtrack.so`, intercepts libc `open`/`fopen`/`unlink` family
  calls to catch C-extension I/O the interpreter hooks miss (h5py, BLAS, etc.).
- **Layer 3 — inotify verification.** The Go sandbox-server watches the
  configured data directories during each command and treats inotify events as a
  verification channel: a read seen only by inotify (not by Layers 1-2) is logged
  as an untracked-read alert rather than silently lost.

Layers 1 and 2 report to a per-command Unix domain socket (`$PROVENANCE_SOCKET`);
R additionally writes a `.rlog` sidecar. The sandbox-server activates the
in-container layers per command by injecting `PYTHONPATH`, `R_PROFILE`,
`LD_PRELOAD`, `PROVENANCE_SOCKET`, and `PROVENANCE_DATA_PREFIXES` into the child
process environment, then drains the socket after the child exits and folds the
result into the exec frame.

**The server, not the layers, is the boundary.** Each layer filters by string
prefix on the path its caller passed, which need not be canonical — so a layer
can report a path that matches a watch dir textually while naming somewhere
else. Every report is canonicalized and re-checked against the watch dirs where
the layers converge; a layer's own filter only keeps a datagram off the socket.

This tracking is **production-wired**, not a prototype: the harness's
`buildMountPlan` sets `PROVENANCE_WATCH_DIRS` to each step's analysis resource
mount root (`/{resourceId}`), and the resulting frame is consumed by the
provenance collector and content-attested at registration (see the
exec-provenance-lineage and artifact-manifest specs). The frame is path-only — it
names files, never their bytes — so hashes are recomputed from disk downstream.

**Scope — operation lineage is advisory, not tamper-proof.** This tracking is a
lineage-capture aid, not a security boundary. Layers 1–2 run inside the observed
workload process itself (same uid, sharing the per-command collection socket), and
the whole capture path lives within the sandbox trust boundary. The operation frame
is therefore self-reported by the observed code: an adversarial workload can forge
or omit datagrams, or bypass the hooks entirely (unset `LD_PRELOAD`, static
binaries, raw syscalls). Treat the reported reads/writes/deletes as **advisory** for
a hostile workload — not a tamper-proof attestation of what untrusted code did. What
survives an adversary is artifact *content*, not lineage: hashes are recomputed
host-side from disk at registration (see the exec-provenance-lineage and
artifact-manifest specs), so content integrity holds even when the self-reported
operation frame cannot be trusted.
## Requirements
### Requirement: Python audit hook tracks file I/O via sitecustomize.py

A `sitecustomize.py` file SHALL be installed at `/opt/provenance/sitecustomize.py` in the sandbox container image. When `PYTHONPATH` includes `/opt/provenance`, the hook SHALL be loaded automatically before any user script.

The hook SHALL use `sys.addaudithook()` to intercept `open` audit events for both reads and writes within configured data directory prefixes. It SHALL classify opens by mode: read-mode (`r`, `rb`, or `O_RDONLY`) as `"op": "read"`, write-mode (`w`, `a`, `x`, or `O_WRONLY`/`O_RDWR`/`O_CREAT`) as `"op": "write"`. It SHALL also intercept `os.remove` and `os.unlink` audit events as `"op": "delete"`.

It SHALL report each unique (path, op) pair to the Unix domain socket at `$PROVENANCE_SOCKET` as a JSON datagram: `{"t": <unix_timestamp>, "p": <absolute_path>, "pid": <process_id>, "layer": "python", "op": <operation>}`.

The hook SHALL deduplicate paths within a single process (same file opened multiple times is reported once). The hook SHALL NOT block script execution — socket send failures SHALL be silently ignored.

#### Scenario: Python script reading a CSV with pandas

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script executes `pandas.read_csv("/data/inputs/counts.csv")`
- **THEN** the provenance socket receives a datagram with `"p": "/data/inputs/counts.csv"` and `"layer": "python"`

#### Scenario: Python script reading multiple files

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script reads `/data/inputs/a.csv` and `/data/inputs/b.csv`
- **THEN** the provenance socket receives exactly two datagrams, one per file

#### Scenario: Python script re-reading the same file

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script opens `/data/inputs/counts.csv` twice
- **THEN** the provenance socket receives exactly one datagram for that path

#### Scenario: Python writes are tracked

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script opens a file for writing (`open("/data/output/result.csv", "w")`)
- **THEN** a datagram is sent with `"op": "write"` for that path

#### Scenario: Python deletes are tracked

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script calls `os.remove("/data/output/temp.csv")`
- **THEN** a datagram is sent with `"op": "delete"` for that path

#### Scenario: Paths outside data directories are not tracked

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script opens `/usr/lib/python3/os.py` (stdlib)
- **THEN** no datagram is sent for that path

#### Scenario: Hook survives subprocess.run

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script spawns `subprocess.run(["python", "child.py"])` and `child.py` reads `/data/inputs/child_input.csv`
- **THEN** the provenance socket receives a datagram for `/data/inputs/child_input.csv`

#### Scenario: python -S skips hook (known limitation)

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** a Python script is invoked with `python -S script.py` (skipping site module)
- **THEN** the audit hook is NOT installed and file reads are NOT reported via Layer 1
- **AND** LD_PRELOAD (Layer 2) still captures the reads if enabled

### Requirement: R trace hooks track file I/O via Rprofile.site

An `Rprofile.site` file SHALL be installed at `/opt/provenance/Rprofile.site` in the sandbox container image. When the `R_PROFILE` environment variable points to this file, the hooks SHALL be loaded before any user R code.

The profile SHALL use `trace()` to wrap base R and utils file-reading functions (`read.csv`, `readRDS`, `readLines`, `scan`, `load`, `file`) and file-writing functions (`write.csv`, `write.table`, `writeLines`, `saveRDS`, `save`). It SHALL use `setHook(packageEvent(..., "onLoad"), ...)` to wrap package functions at load time. It SHALL also wrap `file.remove` and `unlink` for delete tracking.

Each intercepted operation SHALL report to `$PROVENANCE_SOCKET.rlog` as a JSON line: `{"t": <unix_timestamp>, "p": <absolute_path>, "pid": <process_id>, "layer": "r", "op": <operation>}`. The hook SHALL deduplicate within a process and SHALL NOT block script execution.

#### Scenario: R script reading a CSV with read.csv

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** an R script executes `read.csv("/data/inputs/counts.csv")`
- **THEN** the provenance socket receives a datagram with `"p": "/data/inputs/counts.csv"` and `"layer": "r"`

#### Scenario: R script using data.table fread

- **GIVEN** a sandbox container with provenance hooks enabled and `data.table` loaded
- **WHEN** an R script executes `data.table::fread("/data/inputs/large.csv")`
- **THEN** the provenance socket receives a datagram for `/data/inputs/large.csv`

#### Scenario: R parallel mclapply inherits hooks

- **GIVEN** a sandbox container with provenance hooks enabled
- **WHEN** an R script uses `parallel::mclapply()` and a worker reads `/data/inputs/chunk.csv`
- **THEN** the provenance socket receives a datagram for `/data/inputs/chunk.csv`

### Requirement: LD_PRELOAD intercepts C-level file operations

A shared library `provtrack.so` SHALL be compiled and installed at `/opt/provenance/provtrack.so` in the sandbox container image. When `LD_PRELOAD=/opt/provenance/provtrack.so` is set for a child process, the library SHALL intercept `open()`, `open64()`, `openat()`, `openat64()`, `fopen()`, `fopen64()`, `unlink()`, and `remove()` calls at the libc level. The `open64`/`openat64` variants are required because arm64 glibc routes file opens through these functions rather than `open`/`openat`.

The library SHALL classify operations: read-mode opens as `"op": "read"`, write-mode opens as `"op": "write"`, and unlink/remove as `"op": "delete"`. It SHALL report to `$PROVENANCE_SOCKET` as a JSON datagram: `{"t": <unix_timestamp>, "p": <absolute_path>, "pid": <process_id>, "layer": "preload", "op": <operation>}`. Socket send failures SHALL be silently ignored.

The library SHALL NOT affect the Go sandbox-server (which is statically linked and does not use libc).

#### Scenario: h5py C-extension file open is captured

- **GIVEN** a sandbox container with LD_PRELOAD enabled
- **WHEN** a Python script opens an HDF5 file via h5py (`h5py.File("/data/inputs/data.h5", "r")`)
- **THEN** the provenance socket receives a datagram with `"p": "/data/inputs/data.h5"` and `"layer": "preload"`

#### Scenario: LD_PRELOAD does not affect sandbox-server

- **GIVEN** the sandbox-server is running (statically linked Go binary)
- **WHEN** `LD_PRELOAD` is set in a child process's environment
- **THEN** the sandbox-server process itself is unaffected (no interception of its own file opens)

#### Scenario: LD_PRELOAD inherited across fork

- **GIVEN** a sandbox container with LD_PRELOAD enabled
- **WHEN** a Python script uses `multiprocessing.Pool` and a worker opens `/data/inputs/worker.csv`
- **THEN** the provenance socket receives a datagram for `/data/inputs/worker.csv`

### Requirement: LD_PRELOAD provenance hook escapes file paths in JSON datagrams

The `provtrack.c` `send_provenance` function SHALL escape backslash and double-quote characters in `abspath` before embedding in the JSON datagram. The escape loop SHALL terminate with at least 3 bytes of headroom (escape char + original char + null terminator) to prevent buffer overflow when every character requires escaping.

#### Scenario: Path with backslashes and quotes is correctly escaped

- **WHEN** a process opens a file at path `/data/inputs/file "with" quotes\and\backslashes.csv`
- **THEN** the JSON datagram contains the path with `"` escaped as `\"` and `\` escaped as `\\`
- **AND** the datagram is valid JSON parseable by Go's `json.Unmarshal`

#### Scenario: Worst-case path length does not overflow buffer

- **WHEN** a process opens a file whose absolute path is `PATH_MAX` bytes long and every character is a backslash
- **THEN** the escape loop terminates without writing past `escaped[PATH_MAX * 2]`
- **AND** the resulting JSON datagram is truncated but not corrupted

### Requirement: LD_PRELOAD provenance hook is thread-safe

The `provtrack.c` global statics (`seen_paths`, `seen_count`, `initialized`, `initializing`, `prefixes`, `prefix_count`) SHALL be protected by a `pthread_mutex_t`. The `send_provenance` function SHALL hold the mutex during the `already_seen`/`mark_seen` sequence. The `init` function SHALL hold the mutex during the `initialized`/`initializing` check and prefix parsing. Functions `already_seen` and `mark_seen` SHALL document that they must be called with `prov_mu` held.

#### Scenario: Concurrent opens from NumPy BLAS threads

- **WHEN** 8 threads call `open()` simultaneously on different files under `/data/`
- **THEN** `seen_count` is incremented exactly 8 times (no double-increment from races)
- **AND** no heap corruption occurs from concurrent `seen_paths[]` writes

### Requirement: inotify provides verification channel for all file operations

The sandbox-server SHALL use inotify to watch configured data directories during command execution for `IN_OPEN`, `IN_CREATE`, `IN_DELETE`, `IN_MOVED_FROM`, and `IN_MOVED_TO` events. Inotify operates as a **verification layer** for reads, writes, and deletes.

Since `inotify_add_watch` is per-directory (not recursive), the watcher SHALL walk the data directory tree at startup and add a watch on each subdirectory. If the directory tree is too deep or too large (> 1000 watches), the watcher SHALL log a warning and watch only the top-level directories.

The inotify watcher SHALL be started before the child process is spawned and stopped after the child process exits (with a short drain window for late events). The watcher SHALL use `golang.org/x/sys/unix` raw inotify syscalls (no CGO required).

The data directories to watch SHALL be configurable via the `PROVENANCE_WATCH_DIRS` environment variable (comma-separated list of absolute paths, default: `/data`). In production the harness's `buildMountPlan` sets `PROVENANCE_WATCH_DIRS` to each step's analysis resource mount root (`/{resourceId}`), and the sandbox-server derives the in-container layer prefixes (`PROVENANCE_DATA_PREFIXES`) from those watch dirs.

#### Scenario: inotify detects file open inside gVisor

- **GIVEN** a sandbox container running under gVisor with inotify watcher active on `/data/`
- **WHEN** a script opens `/data/inputs/counts.csv`
- **THEN** the inotify watcher receives an `IN_OPEN` event for `counts.csv`

#### Scenario: inotify watches nested subdirectories

- **GIVEN** a data directory structure `/data/inputs/mount1/subdir/`
- **WHEN** the inotify watcher starts on `/data/`
- **THEN** watches are added on `/data/`, `/data/inputs/`, `/data/inputs/mount1/`, and `/data/inputs/mount1/subdir/`
- **AND** a script opening `/data/inputs/mount1/subdir/file.csv` triggers an `IN_OPEN` event

#### Scenario: inotify detects unreported read

- **GIVEN** a command execution where Layer 1 and Layer 2 reported reads for files A and B
- **WHEN** inotify detected opens for files A, B, and C
- **THEN** the provenance frame includes A and B as confirmed reads, and file C is logged as an untracked read alert

#### Scenario: inotify works under runc

- **GIVEN** a sandbox container running under runc (no gVisor)
- **WHEN** a script opens `/data/inputs/counts.csv`
- **THEN** the inotify watcher receives an `IN_OPEN` event

### Requirement: Provenance hooks emit debug diagnostics when PROVENANCE_DEBUG is set

When `PROVENANCE_DEBUG=1` is set in the environment, all provenance layers SHALL emit diagnostic messages to stderr:

- **C (provtrack.c)**: Log `sendto()` failures and socket errors to stderr
- **Python (sitecustomize.py)**: Log `_send()` exceptions to stderr
- **R (Rprofile.site)**: Log `trace()` failures and `send_prov()` errors to stderr

When `PROVENANCE_DEBUG` is unset or empty, no diagnostic output SHALL be produced.

#### Scenario: Debug logging on sendto failure

- **WHEN** `PROVENANCE_DEBUG=1` is set and the provenance socket is unreachable
- **THEN** `provtrack.c` emits a diagnostic message to stderr containing the failed path and errno
- **AND** the intercepted `open()` call still succeeds (provenance failure is non-fatal)

#### Scenario: No debug output in production

- **WHEN** `PROVENANCE_DEBUG` is not set
- **THEN** no provenance diagnostic messages appear on stderr

### Requirement: Dedup sets capped at 32,768 entries across all layers

All three provenance layers SHALL cap their dedup sets at 32,768 entries:

- **C (provtrack.c)**: `MAX_SEEN` SHALL be 32768. After cap, new paths are sent without deduplication.
- **Python (sitecustomize.py)**: `_seen` set SHALL stop deduplicating after 32,768 entries. New datagrams are sent without checking the set.
- **R (Rprofile.site)**: `seen` environment SHALL stop deduplicating after 32,768 entries. New datagrams are sent without checking the environment.

If `PROVENANCE_DEBUG=1` is set, a single warning SHALL be emitted to stderr on first overflow in each layer.

#### Scenario: Python dedup set overflow

- **WHEN** a Python process opens 32,769 unique files under `/data/`
- **THEN** the 32,769th file provenance datagram is sent (not dropped)
- **AND** the `_seen` set does not grow beyond 32,768 entries

#### Scenario: C dedup array at capacity

- **WHEN** a process opens 32,769 unique files via C-level `open()`
- **THEN** the 32,769th file provenance datagram is sent
- **AND** `seen_count` does not exceed 32,768

### Requirement: Provenance socket lifecycle per command

The sandbox-server SHALL create a fresh Unix domain socket (`SOCK_DGRAM`) at a unique path before each command execution and remove it after collecting all reports. The socket path SHALL be passed to the child process via the `PROVENANCE_SOCKET` environment variable.

The server SHALL read all pending datagrams from the socket after the child process exits, with a configurable drain timeout (default 100ms) to allow for late-arriving messages.

#### Scenario: Socket created before command and cleaned up after

- **WHEN** `POST /exec` is called with a command
- **THEN** a Unix socket is created before the process spawns
- **AND** the socket file is removed after provenance collection completes

#### Scenario: Multiple concurrent commands get independent sockets

- **WHEN** two `POST /exec` requests run concurrently
- **THEN** each command gets its own socket at a unique path
- **AND** provenance reports do not cross between commands

### Requirement: The sandbox-server activates the in-container layers per command

For each `POST /exec` command, the sandbox-server SHALL inject the provenance
layers into the child process environment when their files are present:
`PYTHONPATH` prepended with `/opt/provenance` (Layer 1 Python), `R_PROFILE`
pointing at `/opt/provenance/Rprofile.site` (Layer 1 R), `LD_PRELOAD` pointing at
`/opt/provenance/provtrack.so` (Layer 2), `PROVENANCE_SOCKET` set to the
per-command socket path, and `PROVENANCE_DATA_PREFIXES` set from the server's
configured watch dirs. After the child exits, the server SHALL drain the socket,
combine the socket reports with the inotify verification channel, and surface the
result as the exec `provenance` frame.

The server SHALL canonicalize every reported path — collapsing `.` and `..`
segments — and SHALL record it only if the canonical path lies **within** a
configured watch dir, at the single point where all layers converge. A watch dir
itself SHALL NOT be recorded: a read of the mount root is a directory, never an
attestable file.

Each in-container layer filters by string prefix on whatever path its caller
passed, and an absolute path need not be canonical: `/{resourceId}/..` literally
begins with the watch dir `/{resourceId}/` yet names its parent, so it survives
every layer's own filter. The host maps such a path to a location above the
workspace root, where it cannot attest it. The layer filters are therefore an
optimization — they keep a datagram off the socket — and this re-check is the
boundary that decides what a frame may contain. Canonicalization is
**lexical**: resolving symlinks would make the reported path disagree with the
name the workload used, and the layers report names, not inodes.

#### Scenario: Layers are injected for a Python command

- **GIVEN** a sandbox-server with the provenance files installed at `/opt/provenance`
- **WHEN** a command is executed via `POST /exec`
- **THEN** the child process environment carries `PYTHONPATH` including `/opt/provenance`, `R_PROFILE`, `LD_PRELOAD`, `PROVENANCE_SOCKET`, and `PROVENANCE_DATA_PREFIXES`

#### Scenario: Socket reports fold into the exec frame

- **WHEN** a script reads `/{resourceId}/data/inputs/test.csv` via `pandas.read_csv` and the command completes
- **THEN** the exec `provenance` frame's `reads` contains that path
- **AND** does not contain stdlib paths like `/usr/lib/python3/...`

#### Scenario: A read of the mount's parent is not reported

- **GIVEN** a watch dir of `/{resourceId}/` and a layer reporting a read of `/{resourceId}/..` (the container root, which the workload may legitimately open)
- **WHEN** the server records the report
- **THEN** the canonical path is `/`, which lies outside every watch dir, and the exec `provenance` frame does NOT contain it

#### Scenario: A traversal out of the tree is not reported

- **GIVEN** a layer reporting a read of `/{resourceId}/../../../etc/passwd`
- **WHEN** the server records the report
- **THEN** the canonical path is `/etc/passwd`, which lies outside every watch dir, and the exec `provenance` frame does NOT contain it

#### Scenario: A non-canonical in-tree path folds onto its canonical name

- **GIVEN** R's `normalizePath(mustWork = FALSE)` reporting a write to `/{resourceId}/runs/r1/T3S1/scripts/../output/enrich.csv` (it leaves `..` intact whenever a component does not exist yet — the common case for a new output file), and the inotify layer reporting `/{resourceId}/runs/r1/T3S1/output/enrich.csv`
- **WHEN** the server records both reports
- **THEN** the frame carries ONE entry, under the canonical path, attributed to both layers

