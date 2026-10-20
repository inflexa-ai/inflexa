# Design

## Context

The route lives in `cli/src/server/routes/machine.ts` as a `z.discriminatedUnion("target")` body and one handler that maps a target to a folder, then calls the injected `opts.openExternal(folder)`. The pieces the new targets need already exist:

- The workspace jail of the artifacts route: `validatePath` (`@inflexa-ai/harness/tools/lib/path-validation`) for the form, then `workspaceReadRoot` + `classifyRealPath` (`cli/src/modules/analysis/boundary.ts`) for the real-path test. `cli/src/modules/harness/artifact_open.ts:48-62` composes them for `POST {A}/artifacts/resolve`.
- The input rows: `listAnalysisInputs` (`cli/src/db/primary_query.ts`) and `resolveInputPath` (`cli/src/modules/analysis/input.ts`). The `analysis_inputs` table has no id column by recorded design ("No identity triple: a ref is not an entity", `cli/src/db/primary_migrations.ts:51`); the client-visible identity is the reference `(path, anchorId)` that `GET {A}/inputs` returns.
- The folders outside a workspace: `env.logDir`, `env.refsDir`, `env.packageStoreDir` (`cli/src/lib/env.ts:310-325`).
- The analysis lookup and output folder: `findAnalysis` (`cli/src/modules/analysis/analysis.ts`) and `locateOrEnsureOutputDir` (`cli/src/modules/analysis/output.ts:128`).

## Goals / Non-Goals

**Goals:**

- One handler shape that maps each target to a folder or to an error, with the directories-only rule enforced in one place.
- Reuse of the jail rule so `POST /api/v1/open-directory` and `POST {A}/artifacts/resolve` cannot drift apart on what "inside the workspace" means.
- Every error state testable through the existing `MachineRouteOpts` options (the recording opener, the injected lookups a test needs).

**Non-Goals:**

- No reveal-a-file mode in `openExternal`: the endpoint opens directories only, so the helper stays unchanged.
- No harness changes; the workspace layout stays harness-owned.
- No Flamme work; the client repo switches paths and bodies in its own change.

## Decisions

- **Endpoint name `POST /api/v1/open-directory`.** The user asked for a rename that states the directories-only contract and left the concrete name to this change. The coordinator picked `open-directory`; the user reviews the name in this proposal. The old path has no in-repo caller; Flamme is the only client.
- **Directories-only is a guard, not a convention.** The handler resolves each target to a folder candidate, then tests the candidate on disk and refuses with 409 `conflict` when it names a file. The guard runs on every target, because an existence probe alone does not refuse a file: `locateExistingOutputDir` passes a file at the output path (`pathExistsAsync` tests existence, not the file type). `input` refuses earlier: a registered input with `isDir` false is 409 `conflict` without a disk probe, because the record already answers it, and the disk guard catches a stale record whose path now names a file.
- **The `workspace` jail uses the same three helpers as the `workspace-file` kind, with the errors mapped.** `validatePath` refuses a path that is not a valid relative path (absolute, `..` segment, NUL, too long) with 400 `validation_error`; `classifyRealPath` against the workspace read root refuses an escape, also through a symbolic link, with 404 `not_found`; an absent-inside path is 404 `not_found` because there is nothing to show. The reuse is not literal for the root error: `workspaceFileResolvable` swallows an unresolvable workspace root and answers true, so the route maps that error itself to 409 `conflict` with the reason, the same answer as `output_dir` for a gone anchor. The handler checks the `analysisId` with the exact-id guard that `output_dir` uses (`findAnalysis` plus the id comparison), because the workspace-root lookup would also resolve a name or a slug. Alternative considered: jail only by text prefix — rejected, because the artifacts route already learned that a symbolic link defeats a lexical check (`artifact_open.ts` comment on `workspaceFileResolvable`).
- **The `input` target matches the reference pair, not an id and not the remove helper.** The body carries the `path` and `anchorId` of the reference that `GET {A}/inputs` returns, and the server opens a folder only when the pair equals the stored `path` and `anchorId` of one registered input of the analysis. The rule is pair equality, not `matchInputRefs`: the remove helper also matches a resolved absolute path and never compares `anchorId`, which would let a wrong anchor open. No input id exists, and the recorded design says a ref is not an entity, so an id would need a migration and a new identity concept. Security note, recorded in the spec: for an unanchored input the body carries an absolute path — permitted only because the server opens it when the analysis already registers that exact reference. The user chose this scheme (clarity-gate decision, issue 688).
- **`reference_store` and `package_store` ensure, then open.** The same pattern as `output_dir`: an existing folder as it is, an absent folder made first. `logs_dir` opens as it is, because the server log is in it while the server runs. A failed make, or a file where the folder belongs, is 500 `internal_error` and 409 `conflict` respectively, mirroring the `output_dir` answers.
- **Error mapping in one table in the handler.** 400 `validation_error` for a body that names no known target or carries a malformed `workspace` path; 404 `not_found` for an unknown analysis, a path outside the workspace, an absent resolved path, and a reference that matches no registered input; 409 `conflict` for a file target, an input whose anchor folder cannot be found, and a file where a store folder belongs; 500 `internal_error` for each other failure; 200 `{opened}` otherwise, with `opened: false` when the opener cannot start.
- **The response type stays `OpenFolderResult`.** `{opened: boolean}` answers every target; only the body schema and the route path change.

## Risks / Trade-offs

- [Flamme sends the old path until it migrates] → The rename is breaking by request; the Flamme change lands beside this one, and the issue thread records the dependency (inflexa-ai/himmel#73).
- [A page probes store paths it should not see] → The store targets open only the two fixed folders `env.refsDir` and `env.packageStoreDir`; no body value influences them.
- [An input folder disappears between the match and the open] → The existence probe answers 404 `not_found`; the opener then gets a real folder or the request stops before it.
- [Two jail implementations drift] → The route calls the same `validatePath` + `workspaceReadRoot` + `classifyRealPath` composition the artifacts module uses; if a helper extraction is warranted, it is a follow-up inside this change's files, not a new module.

## Migration Plan

Single-process local server; no data migration. Deploy is a normal rebuild. Flamme switches to `POST /api/v1/open-directory` in its own repository.

## Open Questions

None. The input-identifier question went to the user during exploration; the answer (reference match, no id) is recorded above and in the spec delta.
