## 1. The record

- [x] 1.1 The derivation record on `src/state/report-session-state.ts`: the list on the row, the append operation, and the name-uniqueness rule.
- [x] 1.2 Store tests: the append, the read-back, the refusal of a repeated name, and the parse of a legacy row with no list.

## 1b. The write tail

- [x] 1b.1 `CreateSandboxMeta` gains the optional workspace-relative `writableTail`, with per-segment safe-id validation in the mount plan.
- [x] 1b.2 `buildMountPlan` and `buildSessionSubPaths` use the tail in place of the step tail, with no step subdirs. An absent field keeps the plan of today.
- [x] 1b.3 The host-side preparation generalizes: the host makes the tail directory, with the world-writable arm where the engine preserves host ownership.
- [x] 1b.4 Both backends translate the plan unchanged in form. The mount-plan, preparation, and backend tests cover the tail, and the run-path shapes stay byte-identical.

## 2. The tool

- [x] 2.1 The `derive_table` tool in `src/tools/report-session/`, on the extraction rails: the sandbox client, the identity, and the authorizer on every terminal path.
- [x] 2.2 The mounts: the tree read-only, and the declared write tail over `derived/`. The script writes the output directly, and stdout carries logs alone. The bounds: the script cap, the input cap, and one output.
- [x] 2.3 The record lands after the exec: the output hash from the disk, the source hashes from the served membership, and the script hash.
- [x] 2.4 The roster wiring, the tool description, and the call details for the started and the finished lines.
- [x] 2.5 Tool tests with a stubbed sandbox client: the happy path, the undeclared input, the repeated name, the over-cap script, and the failed exec.

## 3. The membership

- [x] 3.1 The gateway load merges the derivation records into the served snapshot in `src/app/report-session-runtime.ts`.
- [x] 3.2 Tests: a derived path binds through the authoring tools, and the stored pin stays unchanged.

## 4. The teaching and the purge

- [x] 4.1 The prompt names the derivation: real reshaping through the tool, and a per-row transform through the chart grammar.
- [x] 4.2 The purge tests state that `derived/` goes with the session directory.

## 5. The gates

- [x] 5.1 Run the targeted suites of the touched modules only, with the podman Postgres for the store suites.
- [x] 5.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
- [x] 5.3 The state and tool surfaces are exported, thus run `bun run harness:local` from `cli/` and the cli typecheck.
