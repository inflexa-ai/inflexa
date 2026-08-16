## Why

A report session renders exactly as its parent conversation, thus the user cannot tell which of the two is open. The session identity surfaces are weak beside that gap. The `S·8ddf` chip explains nothing and copies nothing. The SESSION age is relative where an absolute time answers directly. The report picker is empty inside a report session.

## What Changes

- The chat shell marks an open report session on three surfaces. The chat-bar footer gains a scope word: `REPORT` with a distinct tone, and `ANALYSIS` muted. The status bar gains a `report` segment. The SESSION rail gains a line that names the kind and the parent conversation.
- The full session id becomes copyable: a click on the SESSION chip copies it to the clipboard with a notice, and a palette command does the same.
- The SESSION rail shows the absolute created time of the open session, in place of the relative age.
- The "Switch report session" command lists the sibling report sessions when the open thread is a report child, with the open session named.
- The report picker rows carry the short session id, and the detail line of the focused row carries the full id.

## Capabilities

### New Capabilities

- `report-session-identity`: how the shell marks the open report session, and how the user reads and copies the session id.

### Modified Capabilities

- `tui-layout`: the footer requirement admits the scope word, the status-bar requirement admits the scope segment, and the sidebar requirement changes the SESSION section (absolute created time, the copy affordance, the report context line).
- `sidebar-live`: the relative-age sentence of the ledger-data requirement narrows to the RUNS rows, because the SESSION time becomes absolute.
- `report-session-navigation`: the palette listing covers the siblings when the open thread is a report child, and the picker rows carry the ids.

## Impact

- `cli/src/tui/hooks/thread.ts` — the open-thread snapshot gains the parent row of a report child.
- `cli/src/tui/layout/chat_bar.tsx`, `status_bar.tsx`, `sidebar.tsx`, `app.tsx` — the marking surfaces and the copy affordance. The two dumb components keep their no-domain-imports rule, and the words arrive as props.
- `cli/src/tui/commands.tsx` — the sibling listing, the picker rows, and the copy command.
- `cli/src/lib/clipboard.ts` is reused as it is. No harness change, and no new dependency.
