# Give Settings the data folder, the sandbox readiness of the machine, and a folder open (#646)

## Why

The Settings page of the web GUI shows the local data folder and the sandbox state of the machine. It also opens a folder in the file manager. Today no route gives the data folder, the sandbox readiness is a route of one analysis, and a browser cannot open a folder.

## What Changes

- **The settings.** `GET` and `PATCH /api/v1/settings` also give `dataDir`, the absolute path of the data folder (`<data dir>/inflexa`). They also give `serverLogPath`, the absolute path of the log of a background server of this build channel. A `PATCH` body cannot change them.
- **The sandbox readiness of the machine.** `GET /api/v1/sandbox` gives `{ image, store, catalogFarmPresent }`, with the types of `SandboxReadiness`. The read changes no state. It works with no analysis and with no runtime.
- **The folder open.** `POST /api/v1/open` takes `{ target: "data_dir" }` or `{ target: "output_dir", analysisId }`. The server opens that folder with the shared opener helper, and it answers `{ opened: boolean }`. The body names a known folder, never a path or a URL. Thus a page cannot make the server open a file of its choice.
- **The output folder.** `output_dir` resolves the folder as `POST {A}/output-dir` does: an existing folder as it is, else the server makes it. Thus the open of the web GUI and the "Open output folder" action of the TUI open the same folder.
- **Two spec rules change.** The opener helper can run in the local server for this route only. A browser cannot open a folder, and the server listens on the loopback address only. The rule that the server gives no route for the sandbox status now names the report of `inflexa sandbox status`, which stays a command with no server.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the route groups get the desktop of the machine: the sandbox readiness of the machine and the folder open. The settings give the data folder and the server log. New requirements give the read of the machine readiness and the folder open.
- `artifact-open`: the shared opener helper runs in the client process, except for the folder open of the local server.

## Impact

- `src/api/machine.ts`: `ServerSettings` gets `dataDir` and `serverLogPath`. New wire types for the machine readiness and the folder open.
- `src/server/routes/machine.ts`: the settings body, `GET /sandbox`, and `POST /open`. `MachineRouteOpts` gets the machine readiness read and the opener.
- `src/server/sandbox_gate.ts`: a read of the machine readiness, which the read of one analysis also uses.
- `src/modules/analysis/output.ts`: one helper for the output folder of an open, which `POST {A}/output-dir` also uses.
- `src/lib/env.ts`: `env.dataDir`.
- The `ServerSettings` fixture of `src/tui/components/dialog/dialog_host.render.test.tsx`.
- No client fetcher, no TUI change, no CLI command, no new dependency, and no migration.
