# Tasks — record-command-lineage

## 1. Vocabulary: types, event, telemetry

- [x] 1.1 Add `ProvFileKey` (the `(path, hash)` pick) and the discriminated `ProvCommandRef` to `src/types/prov.ts` per design D2 — `command` variant `{ kind, command, args?, exitCode, durationMs?, scriptPath?, outputs: ProvFileKey[], inputs: ProvCommandInputRef[] }` (with `ProvCommandInputRef` adding `source: "step"` for resolved intra-step self-reads — design D4), `file_tool` variant `{ kind, tool, outputs: ProvFileKey[] }`; JSDoc on every export documenting the no-timestamp rule (producer observation timestamps are replay-unstable and never cross the bus)
- [x] 1.2 Add `prov.command_executed { analysisId, actor, step: ProvStepRef, command: ProvCommandRef }` to `BusEvent` in `src/types/events.ts`, add `generation: "command" | "step"` to the `prov.file_written` payload (the bridge's produced-vs-leaf bucket decision riding the event — design D3), and update telemetry in `src/lib/bus.ts` (command event: runId + stepId + command-or-tool + output count)

## 2. Builders and recorder

- [x] 2.1 `src/modules/prov/document.ts`: add the command QName helper (`inflexa:cmd-{runId}-{stepId}-{digest(sorted output (path,hash) pairs)}` — reuse `fileDigest` for the pair digests, document why the OUTPUT SET keys the group per design D1) and `appendCommandExecuted` per the D3 record table: activity with `prov:type inflexa:Command`/`inflexa:FileToolWrite` + execution-fact attributes, NO formal times; `wasInformedBy(cmdQn, stepQn)`, `wasAssociatedWith(cmdQn, agentQn)`, `used(cmdQn, entityQn)` per input (and per `scriptPath` when present), `wasGeneratedBy(fileQn, cmdQn)` per output — all relation ids deterministic per the existing endpoint-tuple scheme
- [x] 2.2 Rework `appendFileWritten`: takes the event's `generation` discriminant and writes the step-level `wasGeneratedBy(fileQn, stepQn)` ONLY for `"step"` (leaf fallback); produced files receive their generation exclusively from `appendCommandExecuted` (design D3, exactly one generation edge per entity)
- [x] 2.3 Recorder case for `prov.command_executed` in `src/modules/prov/prov.ts` (existing pattern: live doc → append → dirty → scheduleFlush)
- [x] 2.4 Builder/recorder tests: command activity records + attributes; the intra-step chain scenario (cmd A writes `de_results.csv`, cmd B reads it + writes `heatmap.png` → one shared entity, generated-by A, used-by B); exactly-one-generation-per-file (produced vs leaf partition); file_tool variant; duplicate-emission dedup by the output-set QName (activity AND relations); recorder end-to-end (bus → flush → signed column contains `inflexa:Command`)
- [x] 2.5 `bun run typecheck && bun test` green in `cli/` on the vocabulary+builder slice; format touched files

## 3. Bridge rework

- [x] 3.1 `src/modules/harness/prov_bridge.ts`: replace the `producerByPath` join with producer-reference grouping (design D5 — partition manifest entries into producer groups + the leaf bucket; the partition is exclusive by construction); per group emit `prov.command_executed` then its `prov.file_written` events (leaf bucket: file events only, flagged for step-level generation); step-level `prov.input_used` emission unchanged after the groups
- [x] 3.2 Command-scoped inputs per design D4: pass through `data`/`upstream`/`prior` reads (container paths stripped); resolve `"artifacts"`-source reads to `runs/{runId}/{stepId}/…` and include ONLY when the target path is in the reconciled manifest (phantom self-reads dropped); no producer timestamps forwarded
- [x] 3.3 Bridge tests: grouping (two files sharing one producer → one command event with two outputs), file_tool group, leaf entry (no command event, existing producer fallback), intra-step `"artifacts"` read resolution, phantom self-read dropped, emission order (command before its files), input_used unchanged, `registered`/`failed` result shape unchanged
- [x] 3.4 `bun run typecheck && bun run lint && bun test` green in `cli/` (lint: changed files clean; the 16 pre-existing baseline problems in 7 untouched files are out of scope); format touched files

## 4. Close-out

- [x] 4.1 Recorder-level end-to-end assertion pass (deliberately NO live E2E — design non-goal: the bus→builder→flush→sign pipeline was live-proven by `deepen-run-provenance`; this change adds one event through unchanged machinery): emit a realistic mixed registration (2 command groups, 1 file_tool group, 1 leaf, 1 intra-step chain) through the bus, flush, assert the signed PROV-N export shows the command activities, per-command used/generation edges, and `prov verify` passes
- [x] 4.2 Docs close-out: add the change node to `docs/harness_integration-new/06-change-graph.md` (D3, after D2) and a landing section to `00-progress.md` (the old-Q1 collapse retired; command granularity at Cortex parity; note the two deliberate asymmetries — leaf step-generation fallback, step-level input_used retained)
