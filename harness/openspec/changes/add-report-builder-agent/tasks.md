## 1. The session-state store

- [ ] 1.1 Make the store in `src/state/report-session-state.ts`, and add the table to the DDL in `src/state/init.ts`. One row for each thread: the thread id as the key, the analysis id, the document, and the snapshot. Keep each DDL comment free of a semicolon.
- [ ] 1.2 The read parses the stored document and the stored snapshot with the current schemas, the way `report-versions.ts` does. A parse failure reads as a typed error, and an absent row reads as a normal absence.
- [ ] 1.3 The purge of an analysis removes the session-state rows of its threads. Extend the purge coverage the way the version store did.
- [ ] 1.4 Write the tests of the store: a write and a read across two store instances, the absent row, the parse failure, and the purge.

## 2. The authoring gateway

- [ ] 2.1 Change `createReportAuthoringTools` to take a session-state gateway in place of the closure holder. The gateway loads the state by thread id, and it persists the document. The tool ids, the envelopes, and the refusal shapes stay as they are.
- [ ] 2.2 Each tool reads the thread id from the scope of the call. A scope with no thread id refuses as typed data in the ok channel. A landed document persists before the tool reports `applied: true`.
- [ ] 2.3 Update the tests of the tool layer: two threads through one factory stay isolated, the landed document persists before the report, and the missing thread id refuses.

## 3. The value bridge

- [ ] 3.1 Make the bridge module in `src/report-render/value-bridge.ts`. It maps resolved values onto `RenderValues`: a scalar to a metric, rows to a table, and a file echo to a figure source through a caller-supplied policy. The policy stays a parameter here, and the preview tool gives the concrete one.
- [ ] 3.2 A mismatch between a block kind and a resolved value type returns typed data that names the block and the mismatch. The bridge reads no file, and it resolves nothing.
- [ ] 3.3 Write the tests of the bridge: each mapping, the figure policy, and the mismatch refusal.

## 4. The session runtime

- [ ] 4.1 Make the runtime in `src/app/report-session-runtime.ts`. It realizes the gateway over the store, and it wires the authoring tool set of the agent.
- [ ] 4.2 Give the idempotent operation that makes sure that the session state exists. Its first run mints with `mintReportSnapshot` and writes the row. The serving path of a report turn runs it at the turn start, and each tool runs it too. A mint failure returns as typed data, and a later run mints again.
- [ ] 4.3 Write the tests of the runtime: the mint runs one time, the mint failure recovers, and two threads hold two documents. After a reload, the stored snapshot wins over a changed ledger.

## 5. The render-and-preview tool

- [ ] 5.1 Make the preview tool in `src/tools/report-session/`. It runs the finish on the document of the thread. A gap list returns as data, and no render runs.
- [ ] 5.2 On a pass, the tool resolves each reference through the injected `ReferenceResolver`, bridges the values, and renders with `renderReportPage`. The page and the staged figure assets land in `report-sessions/{threadId}/` under the workspace root. The result carries the page path.
- [ ] 5.3 When a `PreviewPublisher` realization is present, the result also carries the minted access. An unresolved reference, a resolver absence, and an unavailable publisher each return a typed outcome that names the cause. Nothing throws for these outcomes.
- [ ] 5.4 Write the tests of the tool: the gap return, the pass path with the page on disk, the staged asset with a relative `src`, and each absence. No write touches `previews/` or `reports/`.

## 6. The agent, the prompt, and the registration

- [ ] 6.1 Make the prompt module in `src/prompts/report-session.ts`. It obeys the prompt conventions: it names tools and mechanisms, it names no dataset and no path, and it carries a "Do NOT" list. It states the grounding rule: no number from memory.
- [ ] 6.2 Make the agent definition in `src/agents/report-session-agent.ts` with the id `report-session`. The prompt composes with the identity part and the conversational part. The definition carries no per-session value.
- [ ] 6.3 Wire the roster: the four workspace read tools, the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools over the gateway, and the preview tool. Wire no planner, no run launcher, no working-memory write, and no sandbox mutate surface.
- [ ] 6.4 Register the agent under `report` in the assembly registry of `src/runtime/assemble.ts`.
- [ ] 6.5 Write the tests: the report type resolves to the singleton, the roster holds the read surface and no run starter, and two threads through the registry stay isolated.

## 7. The gates

- [ ] 7.1 Run `bun run format:file` on each changed source file.
- [ ] 7.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 7.3 Run the lint on the changed files, and repair each finding.
- [ ] 7.4 Run the tests of the changed areas only: `src/state/report-session-state.test.ts`, `src/tools/report-authoring/`, `src/report-render/`, `src/app/report-session-runtime.test.ts`, `src/tools/report-session/`, `src/agents/report-session-agent.test.ts`, and the resolution tests in `src/runtime/`. Do not run the full suite.
