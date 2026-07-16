## Context

`@inflexa-ai/harness` is published to npm and embedded by hosts it does not control. It logs through two channels today:

- `src/runtime/*` and `src/sandbox/*` (9 files) accept an injected `pino.Logger` and work — their records reach the CLI's file log, tagged `module: "harness"`.
- Everything else — `workflows/`, `execution/`, `tasks/`, `tools/`, `lib/`, `state/` — writes **63 `console.*` calls** that the CLI's TUI discards, because it owns stdout in alternate-screen mode.

This is specified behavior, not drift: `structured-logging` mandates pino *and* blesses tagged `console.*` for best-effort failures. The cost is real — a repeated customer `lineage_attestation` failure arrived with zero diagnostic detail, because `sandbox-step.ts`'s `failStep` console.errors the stack and then throws a scrubbed message. Two plausible rescues were investigated and both are dead ends:

- **Boundary logging** cannot work. `failStep` deliberately destroys the detail before it escapes: it logs `err.stack`, then throws `new Error("Step results could not be finalized.")`. Everything outside — the DB row, the run panel, the parent's re-raise — sees only the generic phrase, by design. A logger at the harness boundary would faithfully record a useless string.
- **OpenTelemetry** cannot work. The CLI's OTel is a *sink fed by pino*: `createOtelLogStream()` returns a pino `DestinationStream` attached via `addLogStream()`. It can only ever contain what pino already has, it exports out to a collector rather than into the file a user sends, and it is double-gated on consent + `OTEL_EXPORTER_OTLP_ENDPOINT`. It sits downstream of the broken channel.

Constraint from `harness/CLAUDE.md`: "No classes, no god-ctx, no ALS, no magic-key bag." A module-level `getLogger()` singleton — the pattern the CLI itself uses internally — is not available here. DI is the only option consistent with the harness's architecture.

## Goals / Non-Goals

**Goals:**

- Harness diagnostics reach whatever sink the embedder chooses, with the `lineage_attestation` path first — it must name which of its three throw sites fired.
- The published surface names no logging library. A consumer's choice of logger is theirs.
- Regression is prevented structurally (lint), not by review.
- The embedder's existing pino → file and pino → OTLP pipelines light up with no new wiring.

**Non-Goals:**

- Fixing the provenance defect behind the attestation failures (inotify `IN_OPEN` recorded as a read → phantom inputs). Separate change; this one unblocks diagnosing it.
- Changing what the *user* sees. The scrubbing in `failStep` is correct and stays — internal paths and hashes must not reach the run panel or `cortex_runs.error`.
- Adopting OpenTelemetry logs in the harness.
- Cleaning the 21 `console.*` sites in the CLI's own `modules/harness/` — different package, and `getLogger()` is already in scope there.

## Decisions

### Own `Logger` interface, not pino's type

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
    /** Contextual binding — slog's `With`. */
    with(fields: LogFields): Logger;
    /** Namespace binding — renders as the message's `[a.b]` prefix. */
    named(name: string): Logger;
}
```

*Alternatives considered.* **Keep `pino.Logger`** — it is already the type in `runtime/*` and pino is already a dependency, so this was the initial proposal. Rejected: it dictates a logger to every npm consumer, and the justification evaporated on inspection — all nine references are `import type`, so the dependency is nominal and removable. **`@opentelemetry/api-logs`** — genuinely the nearest thing to a neutral standard, and `@opentelemetry/api` is already a harness dep for traces/metrics. Rejected: `api-logs` is `0.219.0`, still pre-1.0 (OTel JS ships stable packages at 1.x/2.x), it is only present transitively, and it would trade pino-coupling for OTel-coupling — forcing consumers into an OTel SDK to read one log line. **Emit diagnostics as events** — purest library answer, but the harness's `EmitFn` is run/step-scoped and absent from leaf functions like `reconcileManifestWithDisk`; it would mean inventing a parallel diagnostics contract.

*Why message-first.* `slog`, winston, and `console` are all message-first; pino/bunyan are the outliers. The earlier draft used `(fields, msg)` **because** pino satisfied it structurally with no adapter — which is designing the public API around one consumer's incidental shape. Verified by type-probe: pino **is** assignable to a fields-first seam (including `child()` round-tripping), and is **not** to this one. That is the deliberate trade: we buy a ~15-line adapter at the CLI and keep the contract honest.

*Why `with()`.* The harness threads a logger through deps and then repeats `{ runId, stepId }` at every site. `with()` binds it once. Named for `slog`'s `With` rather than pino/bunyan's `child`; legal as a method name (cf. `Array.prototype.with`).

*Why `named()`.* The `[module]` tag is a real field of a record, but the codebase carried it as hand-typed prose inside each message (`"[boot] harness booted"`). That spelling can drift or be dropped, and a sink must parse it back out of the message to use it. `named("boot")` declares it once at the seam and renders the prefix, nesting with a dot to match the `[post-step.reconcile]` convention already in use. The alternative — a `module` *field* — was rejected as a behavior change: it would drop the tag out of the rendered line that operators currently read.

### `logger` is optional to the embedder, no-op internally

`createConsoleLogger()` and `createNoopLogger()` both ship from `index.ts`. An embedder that omits `logger` gets the no-op; internal call sites therefore call `logger.warn(...)` unconditionally instead of `deps.logger?.warn(...)`.

*Alternatives considered.* **Required dep** — makes the embedder choose, and an omission a compile error. Rejected: it forces every deps-bag constructor and test to name a logger for no gain over the no-op, and the optionality it removes is already expressible internally by resolving `?? createNoopLogger()` once per entry point. **Optional defaulting to console** — rejected outright: console is precisely what a TUI host eats, so a forgotten wire-up would silently restore today's bug. The accepted trade is that an embedder who forgets gets silence; that is a real cost, mitigated by silence being an honest signal (nothing appears anywhere) rather than a misleading one (records written to a destroyed stream).

### The CLI keeps pino; the adapter lives at its composition root

The dependency direction stays correct — harness declares, embedder realizes. The adapter flips argument order and maps `with` → `child`. Because the CLI's pino root already fans out to the file destination and `createOtelLogStream()`, harness records reach both sinks with no further wiring, and inherit the root's `redact` config on `text`/`prompt`/`delta`.

### Structured fields, never interpolation

`logger.error("[sandbox-step] lineage_attestation failure", { runId, stepId, errorClass, err })` rather than templating the stack into a string. Records stay queryable, and field-name redaction can apply. The `[module]` tag stays in the message — it is the existing convention and the spec keeps it.

### Fix `lib/otel.ts`'s console banner

`src/lib/otel.ts:77` prints a `console.log` TracerProvider banner. `cli/src/modules/harness/runtime.ts` cites exactly this when passing `initTelemetry: () => {}` — a stray console.log is why harness traces and metrics are off entirely, which is also why `cortex.artifact.reconcile.dropped` (`lib/metrics.ts:12`), instrumented in the failing attestation path, increments into a no-op meter. Converting it to `logger.debug` removes the blocker. Re-enabling `initTelemetry` at the CLI is left as a follow-up: the two OTel setups are complementary (harness = traces + metrics, CLI = logs), but flipping it is a behavior change that deserves its own verification.

## Risks / Trade-offs

- **Semver-major for published consumers** → Retyping `BootHarnessDeps.logger` breaks anyone passing pino raw, and required `logger` fields break deps-bag constructors. Verified: pino is *not* assignable to the message-first interface, so this fails loudly at compile time rather than misbehaving at runtime. Ship as a major with the adapter snippet in the migration note; in-repo the blast radius is one CLI adapter.
- **63 sites is a wide mechanical diff** → Sequence it: seam + realization, then the attestation path (`SandboxStepDeps` → `PostStepPipelineDeps` → `ReconcileManifestInput`, ~13 sites) which delivers the actual value, then the remaining sweep. The lint rule lands last, once the tree is clean, or it blocks its own migration.
- **Leaf functions must grow a parameter** → `reconcileManifestWithDisk` and friends are plain functions over an input object, not factories. Adding `logger` to `ReconcileManifestInput` is consistent with how `collector` is already threaded there; no ambient accessor is introduced.
- **Logs re-emit on DBOS replay** → `failStep` runs inside a workflow body, so a recovered workflow re-logs. Harmless for diagnostics but reading requires dedup by `runId`/`stepId`, not line count. Documented rather than engineered around; suppressing it would mean checkpointing log calls, which is worse.
- **Tests need a logger** → Supply a trivial capturing or silent `Logger` in test setup. Cheaper than the pino-instance the current spec's "tests supply a silent pino" implies, and keeps `bun test` output clean.
- **The spec's Purpose prose falls out of sync** → Delta specs carry requirement operations only, so `structured-logging`'s Purpose paragraph (which opens "The harness logs operationally through **pino**") is not touched by the delta. It must be rewritten at sync/archive time; called out explicitly in tasks.
