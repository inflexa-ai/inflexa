# Design — record-command-lineage

## Context

`deepen-run-provenance` (archived) completed the run → step → file → input model with replay-stable times and cross-run chains. One granularity cut survived from the original migration research (old Q1): the producing *command* is collapsed to a bare `inflexa:producer = "command" | "file_tool"` attribute per file entity. The collapse happens in exactly one place — `prov_bridge.ts:55` keeps `rec.producer.type` and drops the rest — while the seam input carries everything: each `ProvenanceRecord` from `collector.getRecords()` holds `{outputPath, outputHash, producer: {command, args, exitCode, durationMs, timestamp} | {tool, timestamp}, inputs[] (per-command scoped), scriptPath, stepId, runId}`. The per-command input scoping exists upstream *specifically* so "one command's inputs don't collapse onto another's outputs" (`harness/src/provenance/exec-frame.ts:39-43`) — and the bridge then collapses them onto the step anyway.

Reference implementation (verified 2026-07-06): Cortex groups manifest outputs by `Producer` **object identity** — one activity per `recordCommandExecution()` call — and ships `{type: "command", command, args, exitCode, durationMs, scriptIndex, inputIndices, outputIndices}` or `{type: "file_tool", tool, timestamp, outputIndices}` activities to Nexus, which draws per-activity `used` and generation edges. Files referenced by no activity register as leaf entities.

## Goals / Non-Goals

**Goals:**

- The signed document answers "which command (with what args/exit code), reading which inputs, produced this file" — including intra-step chains (command B `used` the entity command A generated).
- Cortex-*semantic* parity: command and file-tool executions are first-class activities; inputs/outputs attach at command scope.
- Replay idempotency preserved: re-emission after DBOS recovery collapses to one record set, no formal-time conflicts possible.

**Non-Goals:**

- Harness or tsprov changes (the seam already carries the data; nothing new crosses it).
- Live E2E (deliberate: the pipeline was live-proven by `deepen-run-provenance`; this adds one event through unchanged machinery — unit + recorder coverage suffices).
- Nexus's per-activity lineage *signing* (`buildCommandChainMessage`) — our integrity model is the document-level chain hash + Ed25519 signature; per-activity signatures are a managed-ledger concern.
- Sub-command granularity (per-syscall, per-layer attribution) — stays collector-internal, as in Cortex.

## Decisions

### D1 — One event per producer group; the group is keyed by its output set, not the Producer object

Cortex groups by `Producer` object reference — perfect *within* one process, meaningless across DBOS replays (a re-executed body rebuilds the collector and mints fresh objects). But the collector is **last-write-wins per output path** (`collector.ts:253-255, 322-324`): after collapse, every output path has exactly one surviving producer, so a group is uniquely identified by its **sorted output `(path, hash)` set**. The command activity QName is therefore `inflexa:cmd-{runId}-{stepId}-{digest(sorted analysis-scoped output (path,hash) pairs)}` — deterministic across replays, stable under re-registration, and collision-free within a step (two surviving groups cannot share an output path). `Producer.timestamp` is excluded from the event payload entirely: it is re-minted per replay (`collector.ts:295`) and would poison determinism anywhere it leaked into an identifier or formal position — the same rule D2-era work applied to wall clocks.

Rejected alternative — digesting `(command, args)`: the same command line can legitimately run twice in one step with different surviving outputs; output-set keying handles that for free.

### D2 — `ProvCommandRef` is a discriminated union mirroring Cortex's two activity types

```ts
export type ProvCommandRef =
    | { kind: "command"; command: string; args?: string[]; exitCode: number; durationMs?: number;
        scriptPath?: string; outputs: ProvFileKey[]; inputs: ProvCommandInputRef[] }
    | { kind: "file_tool"; tool: string; outputs: ProvFileKey[] };
```

where `ProvFileKey = Pick<ProvFileRef, "path" | "hash">` (the QName key space) and `ProvCommandInputRef` widens the used-input source vocabulary with `"step"` for resolved intra-step self-reads (see D4). The `command` variant's `inputs` are the record's **command-scoped** reads (`"data" | "upstream" | "prior"` passed through; `"artifacts"`-source reads mapped to their analysis-scoped output paths as `source: "step"` so intra-step chains resolve — see D4). `file_tool` writes carry no inputs by construction (agent-authored content, `collector.ts:249-251`). The event is `prov.command_executed { analysisId, actor, step: ProvStepRef, command: ProvCommandRef }` — one bus event per group, per the one-event-per-domain-action rule (the discriminant lives *inside* the ref because both variants are the same domain action: "an execution inside the step produced files").

### D3 — Generation moves to the command; step-level `used` stays; leaf files keep step generation

The record model per group:

| Record | Notes |
|---|---|
| `activity(cmdQn, —, —, {prov:type: inflexa:Command \| inflexa:FileToolWrite, inflexa:command/args/exitCode/durationMs \| inflexa:tool})` | No formal times (only a replay-unstable timestamp exists at this seam) |
| `wasInformedBy(cmdQn, stepQn)` | Deterministic id; step activity arrives separately from the scheduler settlement — forward reference tolerated, same as file→step today |
| `wasAssociatedWith(cmdQn, agentQn)` | Endpoint-tuple id with agent digest, matching the existing scheme |
| `used(cmdQn, inputEntityQn)` per command-scoped input | Same `(path,hash)` entity space as everything else — chains fall out |
| `used(cmdQn, scriptEntityQn)` when `scriptPath` resolves | Cortex's `scriptIndex` analogue; the script is itself a registered file entity |
| `wasGeneratedBy(fileQn, cmdQn)` per output | Replaces the file→step generation for produced files |

Two deliberate asymmetries with Cortex:

1. **Leaf files** (no producer record — inotify-only observations) keep today's `wasGeneratedBy(file, stepQn)`: Cortex leaves them generation-less leaf entities, but locally an ungenerated entity answers nothing, and "the step produced it somehow" is both true and the best available attestation. The produced-vs-leaf decision is the bridge's (it owns the partition) and rides `prov.file_written` as `generation: "command" | "step"` — the recorder passes it to `appendFileWritten`, which writes the step-level edge only for `"step"`; cross-event inference in the recorder was rejected as ordering-fragile.
2. **Step-level `prov.input_used` stays untouched** even though command-scoped `used` edges subsume it informationally. It shipped days ago as the step's attested-inputs registry, its removal would be a semantic regression mid-graph, and the duplication cost is one extra edge per input. Cortex-exact minimalism was rejected in favor of not reworking a just-verified surface; pruning is a later decision if document size ever matters.

### D4 — Intra-step chains: `"artifacts"`-source reads resolve to output entities at the bridge — deliberately BEYOND Cortex

The collector classifies a read of the step's *own* prior output as `source: "artifacts"` — skipped by `prov.input_used` (mirroring reconcile's skip) because at step scope "the step read its own output" is noise. At **command** scope it is the signal: command B reading command A's output is the intra-step chain. The bridge therefore maps each command's `"artifacts"`-source reads to their analysis-scoped `runs/{runId}/{stepId}/{path}` form and includes them in that command's `inputs` (they resolve to the same `(path,hash)` QNames command A's outputs registered). Reads that resolve to files absent from the manifest (written-then-deleted phantoms) are dropped — reconcile already dropped their entities, and a `used` edge to a never-registered entity would dangle.

This is a **conscious divergence from Cortex**, not a mirror: Cortex drops self-reads entirely — `resolveInputIndices` skips both `"artifacts"`-source reads and any input resolving to a batch output path, so its activities carry only data/upstream/prior inputs and intra-step chains are unrepresentable there too. Chain fidelity is this change's core value-add, and the local signed document is exactly where it pays; the divergence is additive (extra `used` edges) and breaks no shared vocabulary. These chain inputs carry `source: "step"` in a dedicated `ProvCommandInputRef` type (`{ path, hash, source: "data" | "upstream" | "prior" | "step", fileId? }`, used only inside `ProvCommandRef`) — `ProvUsedInputRef` and the step-level `prov.input_used` keep their three-value vocabulary, which never emits `"step"` by construction.

### D5 — Emission order and bridge structure

`register()` emits, per group: `prov.command_executed` first, then that group's `prov.file_written` events, then (after all groups) the step-level `prov.input_used` set — declaration-before-reference legibility, though PROV and `unified()` are order-independent. Grouping mirrors the managed reference: iterate the manifest entries, look up each entry's record, bucket by `record.producer` reference; entries without a record form the leaf bucket. The existing producer-join map (`producerByPath`) is subsumed by the grouping.

## Risks / Trade-offs

- **[Two generation authorities]** A defect that puts one file in both a command group and the leaf bucket would write two `wasGeneratedBy` edges (command + step) for one entity — a PROV generation-uniqueness violation. → The buckets are computed from one partition of the manifest (has-record vs not), so overlap is structurally impossible; a unit test locks the partition.
- **[Command args in a signed document]** `args` can carry user paths or sensitive-looking strings into `analyses.provenance`. → Accepted: the document is local, already carries full file paths, and args are the provenance (Cortex ships them to Nexus verbatim). Redaction would forge the record.
- **[Group digest sensitivity]** The command QName changes if the output set changes across replays. → It can't: outputs come from the durable exec results replayed identically; reconcile's drops happen before registration on every execution of the inline post-step section.
- **[Document growth]** One activity + ~4 relations per command execution. Bounded by commands-per-step (typically < 10); negligible against the existing per-file records.

## Migration Plan

Single cli PR, no data migration (new record types only; existing documents stay valid — old runs simply lack command activities). Rollback: revert; the step-level generation fallback path is the pre-change behavior.

## Open Questions

None — the leaf-fallback and keep-step-level-`input_used` decisions were settled in conversation (2026-07-06); everything else follows the verified Cortex reference.
