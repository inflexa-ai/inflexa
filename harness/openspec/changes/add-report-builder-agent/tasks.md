## 1. The value bridge

- [ ] 1.1 Make the bridge module in `src/report-render/value-bridge.ts`. It maps resolved values onto `RenderValues`: a scalar to a metric, rows to a table, and a file echo to a figure source through a caller-supplied policy.
- [ ] 1.2 A mismatch between a block kind and a resolved value type returns typed data that names the block and the mismatch. The bridge reads no file, and it resolves nothing.
- [ ] 1.3 Write the tests of the bridge: each mapping, the figure policy, and the mismatch refusal.

## 2. The session runtime

- [ ] 2.1 Make the thread-keyed binder in `src/app/report-session-runtime.ts`. A cell holds the minted snapshot and the authoring tool set of one thread. The map keys by `scope.threadId`.
- [ ] 2.2 The snapshot mints with `mintReportSnapshot` at the first call that needs it, one time for each thread. The cell caches it. A mint failure returns as typed data, and a later call mints again.
- [ ] 2.3 A call whose scope carries no thread id refuses as typed data in the ok channel.
- [ ] 2.4 Write the tests of the binder: two threads hold two drafts, the mint runs one time, the mint failure recovers, and the missing thread id refuses.

## 3. The render-and-preview tool

- [ ] 3.1 Make the preview tool in `src/tools/report-session/`. It runs the finish on the draft of the cell. A gap list returns as data, and no render runs.
- [ ] 3.2 On a pass, the tool resolves each reference through the injected `ReferenceResolver`, bridges the values, renders with `renderReportPage`, and publishes through `PreviewPublisher`.
- [ ] 3.3 An unresolved reference, a resolver absence, and an unavailable publisher each return a typed outcome that names the cause. Nothing throws for these outcomes.
- [ ] 3.4 Write the tests of the tool: the gap return, the pass path with a fixture resolver, the publisher absence, and the resolver absence.

## 4. The agent, the prompt, and the registration

- [ ] 4.1 Make the prompt module in `src/prompts/report-session.ts`. It obeys the prompt conventions: it names tools and mechanisms, it names no dataset and no path, and it carries a "Do NOT" list. It states the grounding rule: no number from memory.
- [ ] 4.2 Make the agent definition in `src/agents/report-session-agent.ts` with the id `report-session`. The prompt composes with the identity part and the conversational part. The definition carries no per-session value.
- [ ] 4.3 Wire the roster: the four workspace read tools, the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools of the binder, and the preview tool. Wire no planner, no run launcher, no working-memory write, and no sandbox mutate surface.
- [ ] 4.4 Register the agent under `report` in the assembly registry of `src/runtime/assemble.ts`.
- [ ] 4.5 Write the tests: the report type resolves to the singleton, the roster holds the read surface and no run starter, and two threads through the registry stay isolated.

## 5. The gates

- [ ] 5.1 Run `bun run format:file` on each changed source file.
- [ ] 5.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 5.3 Run the lint on the changed files, and repair each finding.
- [ ] 5.4 Run the tests of the changed areas only: `src/report-render/`, `src/app/report-session-runtime.test.ts`, `src/tools/report-session/`, and the agent tests. Do not run the full suite.
