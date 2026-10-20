# Proposal

## Why

`POST /api/v1/open` accepts only `data_dir` and `output_dir` (the `openFolderBody` schema of the `POST /open` handler in `cli/src/server/routes/machine.ts`). Flamme cannot open the folder of a run, a step, a report, or an input, so the "Open folder" button of a step on the Run Detail board has no target. Each new folder would need another server change.

## What Changes

- **BREAKING** Rename the endpoint `POST /api/v1/open` to `POST /api/v1/open-directory`. The rename states the contract the user asked for: the endpoint opens directories only, never files. The only client is Flamme (separate repository), which switches to the new path in its own change.
- Add these targets to the body:
  - `{ "target": "workspace", "analysisId", "path" }`: the folder at `path`, relative to the workspace of the analysis. The server resolves it with the same rule as the `workspace-file` kind of `POST {A}/artifacts/resolve` (`validatePath` form check, then the real-path jail of `classifyRealPath` against the workspace read root). One target covers the folder of a run, the folder of a step with its `scripts`/`output`/`figures`/`logs`/`notebooks` folders, the folder of a report, and the folder of a file of the Files tab: the page sends the path of the folder that holds the file, and a path that names a file gives 409 `conflict`, because the endpoint opens directories only.
  - `{ "target": "input", "analysisId", "path", "anchorId" }`: the folder of one registered input. The reference must equal the stored `path` and `anchorId` of one registered input of the analysis (an exact pair match). Inputs live outside the workspace.
  - `{ "target": "logs_dir" }`: the log folder of the server, for the error states of the server.
  - `{ "target": "reference_store" }`: the folder of the reference datasets.
  - `{ "target": "package_store" }`: the folder of the packages.
- Enforce a directories-only rule on every target: a body that names a file is an error and opens nothing. For `workspace`, a path that resolves to a file is 409 `conflict`. For `input`, a registered input whose reference is a file (`isDir` false) is 409 `conflict`, rejected without a disk probe. `logs_dir`, `reference_store`, and `package_store` resolve to directories by construction; a file where a store folder belongs is 409 `conflict`.
- Keep the target-not-path rule: the body never names a path or URL the server opens outside the jail. The `workspace` path is jailed to the workspace of the analysis; the `input` reference is accepted only when it matches a registered input. A page can therefore not open a folder of its choice.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement "A page opens a known folder through the server" changes to the renamed `POST /api/v1/open-directory`, gains the `workspace`, `input`, `logs_dir`, `reference_store`, and `package_store` targets, and gains the directories-only rule with its error answers. The requirement "The routes group by domain and keep the Cortex path tail" changes the desktop bullet to the new path.
- `artifact-open`: the requirement "One shared external-opener helper" changes its endpoint reference and its server scenario to `POST /api/v1/open-directory`.

## Impact

- `cli/src/server/routes/machine.ts`: the route path, the `openFolderBody` schema, and the handler branches for the new targets.
- `cli/src/api/machine.ts`: the `OpenFolderBody` type gains the new target shapes.
- Reuse without edits (expected): `validatePath` (`@inflexa-ai/harness/tools/lib/path-validation`), `workspaceReadRoot`/`classifyRealPath` (`cli/src/modules/analysis/boundary.ts`), `findAnalysis`, `locateOrEnsureOutputDir`, `workspaceRootForAnalysisId` (`cli/src/modules/analysis/output.ts`), `listAnalysisInputs` (`cli/src/db/primary_query.ts`), `resolveInputPath` (`cli/src/modules/analysis/input.ts`), `openExternal` (`cli/src/lib/open_external.ts`, unchanged — no reveal mode is needed now that the endpoint opens directories only).
- `cli/src/server/routes/machine.test.ts`: the `POST /api/v1/open` tests move to the new path and grow the new-target cases.
- Flamme (repository inflexa-ai/himmel) must send the new path and the new targets; out of scope here.
- No harness changes: the workspace layout stays harness-owned (`harness/src/workspace/paths.ts`); the server reads it through the existing jail helpers, so a new folder in the workspace needs no new target.
