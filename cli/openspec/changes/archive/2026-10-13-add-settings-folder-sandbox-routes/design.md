# Design

## Context

Refer to `proposal.md` for the reason. The current state:

- `src/server/routes/machine.ts`: `serverSettings()` builds the body of `GET` and `PATCH /settings`. `MachineRouteOpts` holds the connection reads that a test replaces. `buildApp` mounts `machineRoutes()` at `/api/v1` with the default opts, and `AppDeps` has no route opts.
- `src/lib/env.ts`: the private `dataDir()` gives the base folder. Each path of the data folder is `join(dataDir(), "inflexa", …)`, but no `env` field gives `<data dir>/inflexa` itself. `env.serverLogPath` exists. The type of `envDoc` forces an entry, or an `Exclude` member, for each `env` field.
- `src/server/sandbox_gate.ts`: `readSandboxReadiness(analysisId, opts)` reads the image, the store, and the catalog farm. These three reads do not depend on the analysis. Then it reads the farm and the recorded failure of the analysis. `SandboxReadinessOpts` lets a test replace the image read and the store read.
- `GET /api/v1/store` is not a read with no state change: `readStoreFlights` deletes the live rows of a dead holder.
- `src/lib/open_external.ts`: `openExternal(target)` gives `ok` when the opener starts, and `err({ type: "open_failed", code, cause })` when it cannot start. No server code calls it today.
- `src/server/routes/analyses.ts`: `POST {A}/output-dir` gives an existing output folder as it is. Else it calls `ensureOutputDir`. The TUI action "Open output folder" and `inflexa open` use this route, then open the path in the client process.

## Goals / Non-Goals

**Goals:**

- Each new behavior of the specs has a route test that replaces the opener and the machine reads. No test starts a real opener or reads a real container engine.
- The read of one analysis and the read of the machine share one read of the image, the store, and the catalog farm.

**Non-Goals:**

- No change to the body of `GET {A}/sandbox-readiness`.
- No transfer state in `GET /api/v1/sandbox`. `inflexa sandbox status` keeps that report.
- No client fetcher in `src/client/` and no TUI change. The consumer is the web GUI. The TUI open actions stay in the client process.
- No CLI command, thus no agent policy.

## Decisions

### D1. The machine routes hold the two new routes

`machineRoutes` gets `GET /sandbox` and `POST /open`. `MachineRouteOpts` gets two members:

- `sandboxReadiness: () => Promise<MachineSandboxReadiness>`, with the production value `() => readMachineSandboxReadiness()`
- `openExternal: (target: string) => Result<void, OpenExternalError>`, with the production value `openExternal` of `src/lib/open_external.ts`

A route test replaces the two members, as it replaces `listModels` today.

`buildApp` mounts `machineRoutes()` with the production opts. Thus a test that calls `POST /api/v1/open` through `buildApp` or `startTestServer()` starts a real opener. Each test of the open route MUST call `machineRoutes` with a replaced `openExternal`.

Alternatives:

- A new route file. Rejected, because the two routes have one caller, and the `local-server` spec puts them beside the machine group.
- The store routes. Rejected, because the image is not part of the package store.
- A route under `{A}`. Rejected, because `data_dir` has no analysis, and the issue names the top-level paths.

### D2. One read of the machine, which the read of one analysis uses

`sandbox_gate.ts` gets `readMachineSandboxReadiness(opts: SandboxReadinessOpts = DEFAULT_SANDBOX_READINESS_OPTS): Promise<MachineSandboxReadiness>`. It reads the configured image, the store content, and the lock file of the catalog farm, the same as the current code. `readSandboxReadiness` calls it, and then it adds `farm.present` and `farm.failure` of the analysis. It puts `catalogFarmPresent` in `farm.catalogPresent`. The body of `GET {A}/sandbox-readiness` stays the same.

The machine read does not read the farm failure record. Thus it cannot clear the record.

Alternatives:

- Call `readSandboxReadiness` with an empty analysis id. Rejected, because the farm fields are then values of no analysis.
- Read `GET /api/v1/store` from the page. Rejected, because that read writes, and it gives no image state.

### D3. The wire types live in `src/api/machine.ts`

- `ServerSettings` gets `dataDir: string` and `serverLogPath: string`. They are not members of `ServerSettingsValues`, thus `SettingsPatch` does not get them. `patchSettingsBody` is not strict, thus zod drops the two keys from a `PATCH` body.
- `MachineSandboxReadiness = { image: SandboxImageReadiness; store: StoreContentState; catalogFarmPresent: boolean }`. It imports the two types from `src/api/runs.ts`.
- `OpenFolderBody = { target: "data_dir" } | { target: "output_dir"; analysisId: string }`.
- `OpenFolderResult = { opened: boolean }`.

### D4. `env.dataDir` gives the data folder

`env` gets `dataDir: join(dataDir(), "inflexa")`. `serverSettings()` and the open route read it.

`envDoc` excludes `dataDir`. The Paths section of `--help` lists each file and each folder in the data folder already, with its base variable. An entry for the data folder changes `--help` and the generated CLI reference, and the issue does not ask for that.

Alternative: `dirname(env.dbPath)`. Rejected, because it makes the data folder depend on the place of the database file.

### D5. The open route resolves a target, then opens it

The body schema is `z.discriminatedUnion("target", [...])`, read through `readBody`. Thus a body that is not JSON gives 400 `invalid_json`. A body with no known target, or an `output_dir` with no `analysisId`, gives 400 `validation_error`.

- `data_dir` opens `env.dataDir`. The data folder exists while the server runs, because the database and the server log are in it. Thus the route does not make it.
- `output_dir` reads the analysis with `findAnalysis(analysisId)`. A `null` row, or a row whose `id` is not `analysisId`, gives 404 `not_found` with `No analysis <id>.`, as `POST {A}/farm/link` does. `findAnalysis` also matches a name, and the body field is an id. A `DbError` gives 500 through `internalError`.
- The output folder comes from one helper in `src/modules/analysis/output.ts`. The helper gives the existing folder from `locateExistingOutputDir`, or else calls `ensureOutputDir`. `POST {A}/output-dir` uses the same helper. Thus the two routes cannot resolve different folders. `workspace_unavailable` gives 409 `conflict` with the message: the anchor folder cannot be found, or it is not writable for a make. Each other error gives 500 through `internalError`, for example a failed `mkdir` (`mutation_failed`) or a `DbError`.
- The route calls `opts.openExternal(path)`. `ok` gives `{ opened: true }`. `err` gives `{ opened: false }`, and the route logs the failure with its `code` at the warn level.

The open route does not take the instance lock of the analysis. That lock is a fence for the provenance recorder of the analysis, and the route writes no provenance. The `mkdir -p` of the output folder is the same idempotent write as `POST {A}/output-dir`.

### D6. The credential check of the app is the guard against a page of a different site

The route accepts the bearer token and the session cookie, as each `/api/*` route does. A page of a different site cannot send the cookie, for these reasons:

- `hostOriginGuard` refuses an `Origin` that is not the address of the server.
- `credentialAuth` accepts the cookie only when `Sec-Fetch-Site` is absent, `same-origin`, or `none`.
- The cookie is `SameSite=Strict`.

The body names a target, not a path. Thus a page that passes these checks can open only the data folder or the output folder of an analysis.

## Risks / Trade-offs

- [Risk] A background server inherits the environment of the client that started it. A server that an SSH session started can have no display. → The opener fails, and the route answers `{ opened: false }`. The page shows `dataDir` from the settings.
- [Risk] `opened: true` tells that the opener started, not that a window opened. → The data folder always exists, and the route makes the output folder before the open.
- [Risk] An engine inspect can take more than 10 s. → `GET /sandbox` calls `holdConnection`, as `GET {A}/sandbox-readiness` does.
- [Risk] `dataDir()` in `src/lib/env.ts` accepts a relative `XDG_DATA_HOME`, thus each `env` path, `dataDir` included, is then relative. → This change does not fix it, because it is a defect of each `env` path. `tmp/claude/SESSION.md` records it.
