## Why

The spawn names a report thread `{parent title} — Report N`. The web client names each session by its thread title, thus the user sees "Report 1" and "Report 2". The rendered document has a real title, but only the `data-report-rendered` part carries it.

The store also cannot tell an automatic title from a title that a person set, thus an automatic write cannot know whether it can replace the current title.

## What Changes

- `cortex_analysis_threads` gets `title_set_by_user BOOLEAN NOT NULL DEFAULT false`, through a new migration.
- `ThreadStore.updateTitle` is the rename by a person, and it sets the flag.
- The new `ThreadStore.setAutoTitle(threadId, title)` writes only while the flag is false.
- Each successful render gives the trimmed document title to `setAutoTitle`, before the tool emits the part. A failed write logs a warning.
- The chat turn writes the first-prompt title of a conversation through `setAutoTitle`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-thread-store`: the title flag, the rename that sets it, and the guarded automatic write.
- `report-session-agent`: the preview names the thread after the rendered document.

## Impact

- `src/state/migrations/20260927180000_thread_title_set_by_user.ts`, `src/memory/thread-store.ts`, `src/app/chat-turn.ts`, `src/tools/report-session/preview-report.ts`, `src/agents/report-session-agent.ts`.
- A host needs no code change: the rename route of Cortex and the rename command of the CLI call `updateTitle`.
