## 1. The boot and the sign-in

- [x] 1.1 Give the boot reason `sign_in_required` for a missing or dead provider login, with the remedy `inflexa up`.
- [x] 1.2 Make `inflexa up` run the gate of the boot with the login prompt, exit 1 on a failure, and send `POST /api/v1/server/boot` to a failed server.
- [x] 1.3 Name the phase, the cause, and `inflexa up` in the 503 `unavailable` message.
- [x] 1.4 Refuse a TUI launch with no terminal before the check of the server.

## 2. The server

- [x] 2.1 Add the `Host` and `Origin` check with 403 `forbidden`.
- [x] 2.2 Serve the web page at `/gui/` in the dev channel, and add `scripts/poc_gui.ts`.
- [x] 2.3 Add the sandbox gate before each profile drive: 409 for the rerun, `failed` for the chat open, and a wait for the input change.
- [x] 2.4 Make the input change wait for the ready runtime, and give `workPending` in the data profile.
- [x] 2.5 Count the live durable work in one query for the busy gate and the activity.
- [x] 2.6 Take `touch` on `GET {A}`.
- [x] 2.7 Remove the unused store routes, `StoreAddRequest`, the reclaim exclusion in the process, and the unused queries.
- [x] 2.8 Give the reason of a failed model listing, and write a line to the server log at each stop.

## 3. The TUI

- [x] 3.1 Offer the recovery of a failed boot in a dialog: the sign-in, a new boot, or the start of a server.
- [x] 3.2 Poll on one interval while an analysis is open, at 5 s with active work and at 15 s when idle.
- [x] 3.3 Probe the server at each tick, and follow a stopped server and a new server.
- [x] 3.4 Read the analysis, the usage, and the open thread at each tick. Reload a changed thread, and show the turn of a different client.
- [x] 3.5 Clear a banner that a state of the server raised at the `ready` edge.
- [x] 3.6 Hold a profile drive only while a transfer is live. Send the `r` key of the profile dialog through the path of the palette.
- [x] 3.7 Show `<agent>: thinking` for the `iteration` frame of a sub-agent.

## 4. The specs and the documents

- [x] 4.1 Change each cli spec that the fixes make false.
- [x] 4.2 Add the sign-in, the poll, the `Host` and `Origin` check, and the dev web page to the section "The local server" of `cli/CLAUDE.md`.
