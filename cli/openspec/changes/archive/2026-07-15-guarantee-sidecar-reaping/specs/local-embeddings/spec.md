## MODIFIED Requirements

### Requirement: Sidecar lifecycle is lazy, loopback-only, and reaped

The provider SHALL spawn `llama-server` lazily on first `embed()` (a process that never embeds never spawns it), bind it to `127.0.0.1` on an ephemerally allocated free port, and protect it with a per-spawn minted API key delivered through the child process's environment — never through argv, where it would be readable in the host's process listing. Readiness SHALL require two gates: the server's public health endpoint reporting the model loaded, then one authenticated request to a key-gated endpoint succeeding with the minted key — the health endpoint is unauthenticated upstream, so only the second gate proves the server on this port holds our key (and proves key delivery end-to-end at launch: an auth rejection of our own key fails the launch with an actionable error rather than surfacing at first embed). Every readiness request SHALL carry its own bounded timeout in addition to the shared deadline, so a half-open server that accepts connections but never answers cannot hold the launch past the advertised bound. Launch SHALL observe the child's exit: a child that exits before becoming healthy fails that launch attempt immediately (the health timeout is a bound, not a sentence), and a sidecar that exits after becoming ready SHALL invalidate the cached readiness so the next `embed()` spawns a fresh one — a mid-session crash costs one failed batch, never the rest of the process lifetime. The child's stderr SHALL be continuously drained into a bounded tail (an undrained pipe would eventually block the server); when a launch fails because the child exited, the drain's completion SHALL be awaited (the exit closes the pipe, so completion is prompt) before the tail is read, so the failure always includes the server's final diagnostics rather than racing them. Before any sidecar traffic flows, the proxy bypass SHALL compute the union of existing entries across both `NO_PROXY` spellings, add the loopback hosts, and write the same union to both spellings — a user's proxy-bypass entry present in only one spelling SHALL never be shadowed. Embedding requests SHALL guard the model's 512-token per-input ceiling client-side (truncate or chunk before sending) — an over-length input must never surface as a raw server error.

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

#### Scenario: Half-open server cannot hang the launch

- **WHEN** a process on the sidecar's port accepts connections but never answers the readiness requests
- **THEN** each request times out individually and the launch fails at the shared deadline, not later

#### Scenario: Early exit fails fast with complete diagnostics

- **WHEN** the spawned server exits before answering the health probe (port already bound, unloadable model)
- **THEN** that launch attempt fails as soon as the exit is observed — not after the full readiness timeout — and the failure includes the server's complete final stderr tail, never a partially drained one

#### Scenario: Crash after readiness triggers respawn

- **WHEN** the sidecar exits after having served embeddings and `embed()` is called again
- **THEN** the cached readiness is invalidated and a fresh sidecar is spawned for the new request

#### Scenario: Single-spelling proxy bypass is preserved

- **WHEN** the user has proxy-bypass entries in only one of `NO_PROXY`/`no_proxy` and the sidecar launches
- **THEN** both spellings end up carrying the union of the user's entries plus loopback, and no previously honored entry is dropped from either

#### Scenario: Over-length input is guarded

- **WHEN** an input longer than the model's 512-token ceiling is embedded
- **THEN** the provider truncates or chunks it client-side and returns a valid embedding, never a raw server error

### Requirement: Sidecar termination is escalated and signal-covered

Terminating the sidecar SHALL send SIGTERM and escalate to SIGKILL when the process has not exited within a short grace period, so a wedged server cannot survive its own reap; the terminate primitive SHALL be idempotent (repeated calls send one SIGTERM and arm one escalation timer). A live child SHALL be reachable by the reap from the moment it is spawned: the spawn handle is tracked before readiness resolves and the reap hook is registered before the first launch begins, so a shutdown landing mid-launch terminates the in-flight child rather than finding nothing. The reap SHALL run on every non-crash CLI exit, including signal-initiated ones: the first SIGTERM or SIGHUP runs the same shutdown chain as a normal exit before terminating, and a second signal while that chain is in flight SHALL force immediate exit — a hung shutdown hook must never make the process unkillable short of SIGKILL. A stop that races an in-flight launch SHALL still result in the spawned process being reaped. Exits the process cannot intercept (SIGKILL, a crash) SHALL be healed by the next spawn anywhere on the machine: before spawning, the provider SHALL kill processes executing this installation's materialized `llama-server` binary that have been reparented to pid 1 — the orphan signature — and SHALL never touch a sidecar whose parent is a live process (another CLI's sidecar).

#### Scenario: Shutdown reaps the sidecar

- **WHEN** the CLI process exits normally
- **THEN** the sidecar receives SIGTERM and does not outlive the CLI

#### Scenario: Signal-terminated CLI still reaps

- **WHEN** the CLI process receives SIGTERM or SIGHUP while the sidecar is running
- **THEN** the shutdown chain runs and the sidecar does not outlive the CLI

#### Scenario: Shutdown during an in-flight launch reaps the child

- **WHEN** the shutdown chain runs while a sidecar launch is still awaiting readiness
- **THEN** the already-spawned child is terminated — the reap never depends on the launch having completed

#### Scenario: Second signal forces exit

- **WHEN** a second SIGTERM or SIGHUP arrives while the shutdown chain from the first is still running
- **THEN** the process exits immediately with the conventional signal exit code

#### Scenario: Wedged sidecar is force-killed

- **WHEN** the sidecar ignores SIGTERM past the grace period during a reap
- **THEN** it is SIGKILLed rather than left running

#### Scenario: Stop racing an in-flight launch leaks nothing

- **WHEN** the sidecar is stopped while its first launch is still in progress
- **THEN** the launched process is terminated when the launch resolves, and no stale readiness is cached

#### Scenario: Orphans from unsurvivable exits are swept at the next spawn

- **WHEN** a previous CLI process was killed without running its shutdown chain and its sidecar was reparented to pid 1, and any CLI later spawns a sidecar
- **THEN** the orphaned process is killed before the new spawn, while a sidecar parented to a different live CLI is left untouched
