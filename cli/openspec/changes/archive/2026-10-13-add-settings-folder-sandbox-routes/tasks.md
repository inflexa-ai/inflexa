# Tasks

## 1. The data folder and the wire types

- [x] 1.1 Add `env.dataDir` (`<data dir>/inflexa`) to `src/lib/env.ts`, and add `dataDir` to the `Exclude` list of `envDoc` (design D4). Done when: `bun run typecheck` passes, and `src/lib/env.test.ts` and `src/cli/gen_docs.test.ts` pass with no change to `--help`.
- [x] 1.2 Add `dataDir` and `serverLogPath` to `ServerSettings`, and add `MachineSandboxReadiness`, `OpenFolderBody`, and `OpenFolderResult` to `src/api/machine.ts` (design D3). Update the `ServerSettings` fixture of `src/tui/components/dialog/dialog_host.render.test.tsx`. Done when: `bun run typecheck` passes, and that render test passes.

## 2. The read of the machine

- [x] 2.1 Add `readMachineSandboxReadiness` to `src/server/sandbox_gate.ts`, and make `readSandboxReadiness` use it (design D2). Done when: a new test in `src/server/sandbox_gate.test.ts` shows that the machine read gives the image, the store, and `catalogFarmPresent` from replaced reads. A second new test shows that a recorded farm failure stays for `readSandboxReadiness` after the machine read. The current readiness tests in `src/server/sandbox_gate.test.ts` and `src/server/routes/runs.test.ts` pass with no change.

## 3. The output folder of an open

- [x] 3.1 Add one helper to `src/modules/analysis/output.ts` that gives the existing output folder, or makes it (design D5). Make `POST {A}/output-dir` use it. Done when: the output-dir tests of `src/server/routes/analyses.test.ts` pass. A new test in `src/modules/analysis/output.test.ts` shows that the helper gives an existing output folder under a read-only anchor folder, and makes nothing.

## 4. The routes

- [x] 4.1 Add `dataDir` and `serverLogPath` to `serverSettings()` in `src/server/routes/machine.ts`. Done when: a test in `src/server/routes/machine.test.ts` shows the two absolute paths in `GET /settings`. A second test shows that a `PATCH /settings` with a `dataDir` key saves the other keys and keeps the same `dataDir`.
- [x] 4.2 Add `sandboxReadiness` to `MachineRouteOpts`, and add `GET /sandbox` with `holdConnection` (design D1 and D2). Done when: tests in `src/server/routes/machine.test.ts` show a 200 body from a replaced read, and a 200 body with `image.state` `engine_error`.
- [x] 4.3 Add `openExternal` to `MachineRouteOpts`, and add `POST /open` (design D1 and D5). Done when: tests in `src/server/routes/machine.test.ts`, each with a replaced `openExternal` that records its target, show these results:
  - `data_dir` opens `env.dataDir` and answers `{ opened: true }`.
  - `output_dir` for a seeded analysis with no output folder makes the folder, opens it, and answers `{ opened: true }`.
  - `output_dir` with no `analysisId` answers 400 `validation_error`, and opens nothing.
  - A path in place of a target answers 400 `validation_error`, and opens nothing.
  - An unknown `analysisId` answers 404 `not_found`, and opens nothing.
  - An analysis whose anchor folder was deleted answers 409 `conflict`, and opens nothing.
  - An opener failure answers 200 `{ opened: false }`.
- [x] 4.4 Update the JSDoc of `machineRoutes` so that it names the two new routes. Done when: `bun run lint` passes.

## 5. The checks

- [x] 5.1 Run `bun run format:file` on each changed file in `src/`, then `bun run typecheck`, `bun run lint`, and each changed test file. Done when: each command passes.
- [x] 5.2 Run `openspec validate add-settings-folder-sandbox-routes --strict`. Done when: the change is valid.
- [x] 5.3 The coordinator runs the full cli suite (`bun run test`) one time, after the reviews. The implementor does not run it. Done when: the suite passes, apart from the known failures of the environment.
