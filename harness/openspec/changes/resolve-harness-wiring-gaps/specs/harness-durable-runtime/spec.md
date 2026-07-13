# harness-durable-runtime — delta

> Decision 2 resolved: the harness owns an ordered boot sequence (`bootHarness`,
> `runtime/boot.ts`) that wraps `assembleCoreRuntime` with the effectful boot
> steps every host runs in the same order, and returns the `shutdown` handle. An
> embedder wires that handle to its process signals.

## ADDED Requirements

### Requirement: The harness owns the ordered boot sequence

`bootHarness` (`runtime/boot.ts`) SHALL be the harness-owned boot sequence that
wraps `assembleCoreRuntime` with the effectful, order-dependent boot steps, and
SHALL return a `{ runtime, shutdown }` handle. `assembleCoreRuntime` SHALL stay
synchronous and pure (registration only). The steps SHALL run cheapest-failure
first, in this order:

1. injected telemetry init (default no-op, so a library host acquires no
   process-wide telemetry it did not ask for),
2. `validateAgentSkills(skillsDir, SANDBOX_AGENT_META)`,
3. `initCortexState(pool)`,
4. `assertConnectionBudget(...)`,
5. `assembleCoreRuntime(core)`,
6. an optional embedder `beforeLaunch()` hook (host-specific pre-launch work —
   scheduled sweeps, an ephemeral reap, an agent-switch install — that must
   attach before DBOS launch re-emits events),
7. `launchDbos(...)`.

Boot-step failures SHALL propagate to the caller (the embedder's composition
root releases whatever it acquired). Only `shutdown` swallows per-step failures.

#### Scenario: Skills are validated before launch

- **GIVEN** `bootHarness` is called with a `skillsDir` under which a declared skill has no readable `SKILL.md`
- **WHEN** the harness boots
- **THEN** it SHALL reject before `assembleCoreRuntime` and `launchDbos` run

#### Scenario: The embedder hook runs after registration and before launch

- **GIVEN** a `beforeLaunch` hook is supplied
- **WHEN** `bootHarness` runs to launch
- **THEN** `beforeLaunch` SHALL run after `assembleCoreRuntime` registers the workflow cohort and before `launchDbos`

## MODIFIED Requirements

### Requirement: Graceful shutdown order is injectable

`runShutdownSequence` SHALL mark draining, close the host's HTTP server through
an injected callback, shut DBOS down, close the app pool, flush telemetry/logs,
and exit. Core SHALL NOT own the HTTP server itself.

`bootHarness` SHALL return a `shutdown(signal)` handle that drives
`runShutdownSequence` wired with the harness-owned callbacks (`markDraining`,
`shutdownDbos`, and closing the app pool). The HTTP-drain, logger-flush,
telemetry-shutdown, and process-`exit` callbacks SHALL default to no-ops so a
library host that owns none of those (and owns its own process lifecycle) is not
forced to supply them; an embedder overrides any it does own (e.g. a server host
supplies `closeHttpServer` and `exit`).

#### Scenario: Shutdown ordering is preserved

- **GIVEN** a host wires all shutdown callbacks
- **WHEN** `runShutdownSequence` runs
- **THEN** DBOS shutdown runs after HTTP drain and before pool close

#### Scenario: The boot handle closes the pool without an embedder callback

- **GIVEN** an embedder that supplies no `closeHttpServer` / `exit` override
- **WHEN** the returned `shutdown` handle runs
- **THEN** draining is marked, DBOS is shut down, and the app pool is closed, and the missing callbacks default to no-ops rather than failing
