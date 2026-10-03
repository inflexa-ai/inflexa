# Close the gaps of the local server

## Why

A use of the local server found gaps that the split left:

- A failed boot was a terminal state of the TUI. The remedy `inflexa setup` did not boot the server again, and no client could recover a server that stopped.
- An idle TUI did not poll. Thus it did not show the turn, the rename, or the run of a different client.
- Only the TUI checked the machine before a profile. A profile that a different client or an input change started could start a sandbox that the machine cannot serve.
- A web page whose host name points at 127.0.0.1 could send a request to the server.
- Some store routes had no client, and their exclusion in the process had no use.

## What Changes

- `inflexa up` signs in to the provider on a terminal, and then asks a failed server to boot again (`POST /api/v1/server/boot`). The boot reports a missing or dead login with the reason `sign_in_required`.
- The TUI offers a recovery for each failed boot in a dialog: the sign-in through `inflexa up` in its terminal, a new boot, or the start of a server that does not answer.
- A TUI launcher with no terminal refuses before it starts a server.
- The TUI polls on one interval while an analysis is open: 5 s with active work, and 15 s when idle. A tick reads the runs, probes the server, and reads the analysis, the usage, and the open thread. The TUI shows the turn of a different client, reloads a changed thread, and follows a new server back to `ready`.
- The server refuses a profile drive that cannot start a sandbox. The TUI holds a drive only while a transfer is live.
- One query counts the live durable work for the busy gate and for the activity of a stop.
- The server answers only a request whose `Host` and `Origin` headers name its own address (403 `forbidden`). The dev channel serves a web page at `/gui/`.
- `GET {A}` takes `touch`, thus a poll records no sighting of the folder.
- Remove the store routes for the inventory, the adds, the catalog cancel, the reclaim, and the sandbox status. They had no client.
- Remove the reclaim exclusion in the process and the unused count queries.
- The model listing gives the reason of a failure, and the server log gets one line at each stop.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- The server: `local-server`, `context-resolution`, `data-model-db-access`, `package-store-management`, `package-store-transfers`, `agent-model-selection`.
- The boot and the sign-in: `cliproxy-credential-health`, `postgres-provisioning`, `agent-cli-tool`, `chat-view`.
- The TUI: `tui-harness-chat`, `sidebar-live`, `workspace-context`, `data-profile-launch`.

## Impact

- Changed code: `cli/src/server/`, `cli/src/client/`, `cli/src/api/`, `cli/src/tui/`, `cli/src/cli/`, `cli/src/modules/infra/`, `cli/src/modules/libs/store.ts`, `cli/src/db/primary_query.ts`.
- New code: `cli/src/server/sandbox_gate.ts`, `cli/src/server/durable_work.ts`, `cli/src/server/routes/gui.ts`, `cli/src/server/gui/poc.html`, `cli/scripts/poc_gui.ts`, `cli/src/client/commands/geo.ts`.
- The harness change `give-a-sub-agent-iteration-frame` gives the `iteration` frame that the TUI shows as `<agent>: thinking`.
- The removed store routes had no client, thus no client changes.
