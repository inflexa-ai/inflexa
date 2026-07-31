## MODIFIED Requirements

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

At that same point, the server SHALL drop a report of a **read** whose path is
not present in the container, and SHALL log the drop when running at debug level.
Only absence drops a report: a `stat` failing any other way — a permission the
server lacks and the workload had — SHALL keep it rather than lose a real lineage
edge to a transient error. Reports of **writes** and **deletes** SHALL NOT be
subject to this check: a write is reported before the file it creates exists, and
a phantom write is dropped host-side at reconcile, where the file has had its
chance to appear.

A read report is a claim of intent, not of consumption. Two of the layers fire
ahead of the call they observe — the Python audit hook runs on the `open` audit
event, which CPython raises before the open is attempted, and R's `trace()` runs
at call entry over a `normalizePath(mustWork = FALSE)` name — so a read that
fails is reported exactly like one that succeeds. (Only Layer 2 reports after the
fact, gated on `fd >= 0`.) The commonest source is ordinary rather than exotic:
displaying an uncaught traceback whose frame carries a relative `co_filename` —
every Cython frame, e.g. pandas' `.pxi`/`.pyx` — makes CPython open
`<entry>/<basename>` for every `sys.path` entry until one succeeds, and the
entries under the analysis mount become reported reads of files that were never
there. The host can neither tell such a probe from an input nor hash it, so it is
dropped where the layers converge.

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

#### Scenario: A read of a path that is not there is not reported

- **GIVEN** a script that dies with an uncaught pandas `KeyError`, so the audit hook reports a read of `<sys.path entry>/hashtable_class_helper.pxi` under the analysis mount — CPython's probe for the Cython frame's source, which never existed there
- **WHEN** the server records the report
- **THEN** the exec `provenance` frame's `reads` does NOT contain that path

#### Scenario: A read of a file that is there survives

- **GIVEN** a layer reporting a read of a file that exists under a watch dir
- **WHEN** the server records the report
- **THEN** the exec `provenance` frame's `reads` contains it

#### Scenario: A write to a path that does not exist yet is reported

- **GIVEN** a layer reporting a write to `/{resourceId}/runs/{run}/{step}/output/de.csv` before the file has been created
- **WHEN** the server records the report
- **THEN** the exec `provenance` frame's `writes` contains that path

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
