## Context

`ProvenanceCollector` holds two record maps — command records (fed by `execute_command` via `feedExecFrame`) and file-tool records (fed by `recordFileToolWrite`) — with last-write-wins unlinking in both directions. Only the first feed exists: `recordFileToolWrite` (`src/provenance/collector.ts:223`) has zero callers. The mutate seam (`src/tools/workspace/mutator.ts`) executes each `write_file`/`edit_file` as a sandbox `python3 -c` exec and reads only `exitCode` from the result, discarding the returned provenance frame — deliberately never calling `feedExecFrame`, since that would attribute the file to `python3` with a base64 blob as its command line.

Downstream, everything is already built and waiting: the registration bridge maps `producer.type === "file_tool"` groups, the document builder emits `inflexa:FileToolWrite` activities, and lineage renders the kind. Today agent-authored files instead land in the bridge's leaf bucket and get attested `producer: "command"` with a step-grain generation edge.

Composition facts the design leans on:
- Both write tools funnel full file content through the single `mutator.writeFile` chokepoint (`write-file.ts:43`, `edit-file.ts:123` — `edit_file` reads, applies the edit host-side, then writes whole bytes).
- `resolveForWrite` returns an **analysis-root-relative** path (`workspace/paths.ts:78`); collector records key **step-relative** (`recordCommandExecution` strips `stepPrefix`, `collector.ts:280`).
- `createWorkspaceMutator` has exactly one production call site, `agents/sandbox/shared.ts:243`, where `deps.lineageCollector` (optional, `shared.ts:124`) is already in scope.
- The bridge attests the entity hash from the reconciled manifest entry, not from the collector record (`cli` bridge `attest`) — the record supplies only the producer identity.

## Goals / Non-Goals

**Goals:**
- Every successful `write_file`/`edit_file` write produces a file-tool provenance record, so registration groups it as a `file_tool` producer and the signed document gains an `inflexa:FileToolWrite` activity.
- Hash and size attested in-process from the exact bytes written — no rehash round-trip, using the shared `sha256:<hex>` content hasher (`lib/fs-helpers.ts`).
- Record keys land in the same step-relative keyspace as command records, so the bidirectional last-write-wins unlinking actually fires.
- Stale docstrings stop naming tools that don't exist.

**Non-Goals:**
- Read lineage (`read_file`/`grep`/`workspace_search` producing `used` edges) — issue #75 Gap 1, explicitly postponed; the collector's exec-frame-only input stance is unchanged.
- Consuming the mutator's sandbox exec provenance frame — stays discarded (see Decisions).
- Any cli-side or event-shape change — the `prov-run-events` contract already specifies the `file_tool` variant.
- New file tools (`append_file`, `copy_file`) — the docstring fix removes the fiction, it doesn't add the tools.

## Decisions

**1. Record inside the mutate seam, not in each tool factory.** `mutator.writeFile` is the one place both tools' bytes pass through, and the seam already owns the whole write gauntlet (resolve, confine, execute). Recording there means a future file tool cannot forget its provenance by construction. The calling tool's identity rides the existing args object as a new `tool` field (`write_file` / `edit_file`) — it names the agent-visible tool for `ArtifactRecord.toolName`, which the document builder surfaces as `inflexa:tool`. Rejected: per-factory recording — two call sites that can drift, and the seam's docstring ("the confinement invariant is concentrated in one place") argues the same for attestation.

**2. The collector is an optional construction-time dep of `createWorkspaceMutator`.** Mirrors `createExecuteCommandTool`'s optional `lineageCollector` (`shared.ts:268`): absent collector → write proceeds, nothing recorded. The mutator deps are already step-scoped (`stepId`, `workflowId`), so a step-scoped collector fits the seam's construction pattern; `ToolContext` stays free of provenance plumbing (per the harness-workspace-tools construction-time-dependency rule).

**3. Hash/size computed in-process; the exec frame stays discarded.** The collector docstring explicitly blesses callers "where the bytes are already known and stable" passing a non-empty hash. `contentBytes` is in hand at the seam; hash with the shared `sha256:<hex>` helper so the string format matches every other hash in the system. Rejected: threading the mutator's exec result through `feedExecFrame` — it would mint the `python3`+base64 command record the last-write-wins unlink was designed to erase, and its write hashes are empty pending reconcile anyway. The in-process record is strictly richer; the frame carries nothing else (a pure write has no reads).

**4. Step-prefix normalization lives inside `recordFileToolWrite`.** The seam resolves analysis-root-relative; record keys must match manifest entry paths (step-relative) or the bridge's `recordByPath` lookup misses and the `commandRecords.delete` unlink dead-fires. Normalize exactly as `recordCommandExecution` does (strip `stepPrefix` when present, pass through otherwise) so the invariant is owned by the collector, not spread across callers.

**5. Record only on `status: "ok"`.** `out_of_scope` / `out_of_prefix` / `write_failed` attest nothing — a provenance record for bytes that never landed would be a false attestation. The record's `timestamp` is minted at write time; this is replay-safe because the bridge never forwards producer timestamps into identifiers or formal positions, and the collector is rebuilt per step attempt.

**6. Accepted semantics: the final producer wins per path.** `write_file` then command-overwrite → command record survives (existing behavior at `collector.ts:293-295`). Command output then `edit_file` → the file-tool record supersedes: the final bytes are agent-authored, and the command's derivation is lost for that path. This is the semantics the last-write-wins design already encoded; this change just makes both directions reachable.

## Risks / Trade-offs

- [Record hash goes stale if a later exec rewrites the file before step end] → Harmless by construction: the attested entity hash comes from reconcile's disk rehash of the manifest entry; the record contributes only producer identity, and a rewriting *command* would replace the record anyway via last-write-wins.
- [`edit_file` of a command output erases the command attribution for that path] → Accepted (Decision 6); the alternative — merging producers per path — has no PROV shape today and contradicts "exactly one generation edge per file".
- [A future mutator caller outside `shared.ts` forgets the collector] → The dep is optional by design; the mutate-surface invariant tests pin that a collector-carrying mutator records on ok and stays silent on failure, so the regression surface is the composition root only — the same exposure `execute_command` already accepts.

## Migration Plan

Additive, no rollout steps: no event-shape, schema, or storage change. Existing signed documents are unaffected; new steps simply start producing `file_tool` groups the downstream already renders. Rollback is reverting the wiring.

## Open Questions

_None._
