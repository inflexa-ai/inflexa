## MODIFIED Requirements

### Requirement: Embedding vectors are 384-dimensional and L2-normalized

Every vector returned by `createLocalEmbeddingProvider.embed()` SHALL have exactly 384 dimensions and SHALL be L2-normalized (Euclidean norm within 0.001 of 1.0). The current realization delegates normalization to the sidecar: `llama-server` applies the model's pooling and L2 normalization server-side, and the provider passes vectors through unchanged. The unit-norm guarantee belongs to the provider's contract, not to the transport — any replacement transport that does not normalize server-side SHALL re-establish normalization client-side before returning vectors.

#### Scenario: Vector dimension is 384

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `vectors[0].length` SHALL equal 384

#### Scenario: Vectors are L2-normalized

- **WHEN** `embed(["some text"], session)` resolves to `ok(vectors)`
- **THEN** `Math.sqrt(vectors[0].reduce((s, v) => s + v*v, 0))` SHALL be within 0.001 of 1.0

#### Scenario: Empty input returns empty output

- **WHEN** `embed([], session)` is called
- **THEN** it SHALL resolve to `ok([])` without spawning the sidecar

### Requirement: Sidecar runtime acquisition is pinned, verified, and atomic

The local embedding runtime SHALL be an official prebuilt `llama.cpp` release archive (containing `llama-server` and its companion shared libraries), pinned to an exact release tag per platform with SHA-256 checksums vendored in this repository — upstream publishes none, so the vendored hash is the sole integrity authority. The macOS arm64 pin SHALL be a build compatible with the product's supported macOS versions (current upstream macOS builds require macOS 26). Acquisition SHALL be source-aware: the compiled binary carries its own platform's archive as a build-time embedded asset (each target embeds exactly one); a source checkout downloads the identical pinned artifact. Both sources SHALL converge on one materialization step: verify the SHA-256, extract the complete archive directory (the server resolves its shared libraries relative to itself), and atomically rename into a tag-named directory under the data dir — a partial or failed materialization SHALL leave no trace at the final path, and re-running SHALL converge (an already-materialized tag directory is reused without network or extraction). The build SHALL remove cached archives that match no current pin before compiling, so a stale embed reference fails the build loudly rather than embedding a superseded runtime.

#### Scenario: Compiled binary materializes from the embedded asset

- **WHEN** local mode first needs the runtime in the compiled binary
- **THEN** the embedded archive is extracted (never read by native code in place), hash-verified, and atomically renamed into the tag-named runtime directory, with no network access

#### Scenario: Source checkout downloads the pinned artifact

- **WHEN** local mode first needs the runtime in a source checkout
- **THEN** the pinned release archive is downloaded, verified against the vendored SHA-256, and materialized into the identical layout

#### Scenario: Hash mismatch is fatal and clean

- **WHEN** the downloaded or embedded archive fails SHA-256 verification
- **THEN** materialization fails with an actionable error and nothing is left at the final runtime path

#### Scenario: Already materialized is a no-op

- **WHEN** the tag-named runtime directory already exists
- **THEN** no download, extraction, or verification work is repeated

#### Scenario: Stale cached artifact cannot be embedded

- **WHEN** the vendored pins change and a build runs while the local build cache still holds an archive for the superseded tag
- **THEN** the stale archive is removed before compilation, and an embed reference that still names it fails the build rather than embedding the superseded runtime

### Requirement: Sidecar lifecycle is lazy, loopback-only, and reaped

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key delivered through the child process's environment — never through argv, where it would be readable in the host's process listing. Readiness SHALL require two gates: the server's public health endpoint reporting the model loaded, then one authenticated request to a key-gated endpoint succeeding with the minted key — the health endpoint is unauthenticated upstream, so only the second gate proves the server on this port holds our key (and proves key delivery end-to-end at launch: an auth rejection of our own key fails the launch with an actionable error rather than surfacing at first embed). Launch SHALL observe the child's exit: a child that exits before becoming healthy fails that launch attempt immediately (the health timeout is a bound, not a sentence), and a sidecar that exits after becoming ready SHALL invalidate the cached readiness so the next `embed()` spawns a fresh one — a mid-session crash costs one failed batch, never the rest of the process lifetime. The child's stderr SHALL be continuously drained into a bounded tail (an undrained pipe would eventually block the server), and launch failures SHALL include that tail so the server's own diagnostics reach the user. Before any sidecar traffic flows, the proxy bypass SHALL compute the union of existing entries across both `NO_PROXY` spellings, add the loopback hosts, and write the same union to both spellings — a user's proxy-bypass entry present in only one spelling SHALL never be shadowed. Embedding requests SHALL guard the model's 512-token per-input ceiling client-side (truncate or chunk before sending) — an over-length input must never surface as a raw server error.

#### Scenario: Lazy spawn and reuse

- **WHEN** `embed()` is called for the first time
- **THEN** the sidecar is spawned, health-checked, and used — and subsequent `embed()` calls in the same process reuse it without a new spawn

#### Scenario: No embed, no sidecar

- **WHEN** a CLI process never calls `embed()`
- **THEN** no sidecar process is ever spawned

#### Scenario: Key is not visible in the process listing

- **WHEN** the sidecar is running
- **THEN** the minted API key appears in the child's environment, not in its command line

#### Scenario: Readiness requires the key to be honored

- **WHEN** a server on the sidecar's port answers the public health probe but rejects the minted key on the authenticated gate
- **THEN** the launch fails with an error naming the authentication mismatch — it is never declared ready

#### Scenario: Early exit fails fast with diagnostics

- **WHEN** the spawned server exits before answering the health probe (port already bound, unloadable model)
- **THEN** that launch attempt fails as soon as the exit is observed — not after the full readiness timeout — and the failure includes the server's stderr tail

#### Scenario: Crash after readiness triggers respawn

- **WHEN** the sidecar exits after having served embeddings and `embed()` is called again
- **THEN** the cached readiness is invalidated and a fresh sidecar is spawned for the new request

#### Scenario: Single-spelling proxy bypass is preserved

- **WHEN** the user has proxy-bypass entries in only one of `NO_PROXY`/`no_proxy` and the sidecar launches
- **THEN** both spellings end up carrying the union of the user's entries plus loopback, and no previously honored entry is dropped from either

#### Scenario: Over-length input is guarded

- **WHEN** an input longer than the model's 512-token ceiling is embedded
- **THEN** the provider truncates or chunks it client-side and returns a valid embedding, never a raw server error

## ADDED Requirements

### Requirement: Sidecar termination is escalated and signal-covered

Terminating the sidecar SHALL send SIGTERM and escalate to SIGKILL when the process has not exited within a short grace period, so a wedged server cannot survive its own reap. The reap SHALL run on every non-crash CLI exit, including signal-initiated ones: SIGTERM and SIGHUP of the CLI process SHALL run the same shutdown chain as a normal exit before terminating. A stop that races an in-flight launch SHALL still result in the spawned process being reaped — the losing launch detects it was superseded when it resolves, terminates its own process, and caches nothing.

#### Scenario: Shutdown reaps the sidecar

- **WHEN** the CLI process exits normally
- **THEN** the sidecar receives SIGTERM and does not outlive the CLI

#### Scenario: Signal-terminated CLI still reaps

- **WHEN** the CLI process receives SIGTERM or SIGHUP while the sidecar is running
- **THEN** the shutdown chain runs and the sidecar does not outlive the CLI

#### Scenario: Wedged sidecar is force-killed

- **WHEN** the sidecar ignores SIGTERM past the grace period during a reap
- **THEN** it is SIGKILLed rather than left running

#### Scenario: Stop racing an in-flight launch leaks nothing

- **WHEN** the sidecar is stopped while its first launch is still in progress
- **THEN** the launched process is terminated when the launch resolves, and no stale readiness is cached

## REMOVED Requirements

### Requirement: Embedding concurrency is capped

**Reason**: The requirement mandated `Promise.all` over per-text `context.getEmbeddingFor()` calls capped at 4 — API and mechanism of the removed node-llama-cpp realization. The sidecar transport sends the whole guarded batch as one request to `llama-server`, which owns its own parallelism; no per-text concurrency exists in the CLI to cap.
