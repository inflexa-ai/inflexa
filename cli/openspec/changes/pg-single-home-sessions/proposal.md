## Why

A chat session has two identity rows — CLI SQLite `sessions` and harness Postgres `cortex_analysis_threads` — with no synchronization: titles diverge by construction (rename writes SQLite only), deletes orphan the PG side, `sessions.updatedAt` never reflects activity, and the SQLite `messages`/`parts` tables are frozen legacy with no writer and no reader. The only load-bearing job the SQLite row still does is pre-boot session resolution in the launcher — and that dissolves by resolving the thread at the boot-`ready` edge, where the chat becomes usable anyway. Single-homing identity in Postgres removes the divergence bugs before the multi-session model (parent/child + thread type, issue #224) lands on top; mirroring those new columns across two stores would entrench the split. (Issue #233.)

## What Changes

- **BREAKING (schema):** a versioned migration drops the `sessions`, `messages`, and `parts` tables. The legacy transcripts in `messages`/`parts` are already unreachable from the UI; this deletes them for good.
- **BREAKING (CLI surface):** the `inflexa sessions` command is removed — it prints globally-scoped session ids that no other command can consume. The agent-policy snapshot and generated CLI reference lose the entry.
- The launcher no longer resolves or creates a session: `ChatTarget` carries analysis + working dir only, and all pre-boot session CRUD in the resolvers is deleted. Passive paths remain PG-free (no-litter).
- The TUI resolves the thread at the boot-`ready` edge via the harness `ThreadStore`: most-recent live thread for the analysis, else an empty chat whose thread is created by the first turn (existing `prepareChatTurn` behavior).
- Session switch/rename palette commands and the sidebar session line re-point from SQLite queries to the harness thread store over the booted runtime's pool.
- The `Session` domain type and its SQLite CRUD (`createSession`, `getSession`, `listSessions`, `listSessionsByAnalysis`, `renameSession`, `deleteSession`, message/part accessors) are removed; the thread (`threadId`) is the one session identity.
- Companion harness change (in `harness/openspec`): appending a turn bumps the thread row's `updated_at`, so `listThreads`' `updated_at DESC` ordering means activity — required for resume-most-recent to work once the SQLite row is gone.

## Capabilities

### New Capabilities

_None — the change consolidates existing capabilities onto the Postgres thread store; no new capability boundary is introduced._

### Modified Capabilities

- `chat-wiring`: the session-creation requirement is retired with the launcher's session resolution; `ChatTarget` and the launch/in-place-switch flows are respecced thread-first (analysis-only pre-boot, thread resolution post-`ready`).
- `cli-core`: the `inflexa sessions` command requirement is removed.
- `primary-storage`: session/message/part query and mutation requirements are removed (tables dropped).
- `data-model-storage`: the schema requirements lose the chat tables (JSON-blob chat-tables requirement retired; baseline scenario updated; a versioned drop migration is added to the forward-only history).
- `data-model-db-access`: session create/read helper requirements are removed.
- `data-model-types`: the `Session` chat type is retired from the preserved-types requirement.
- `command-palette`: the in-place session-switching commands requirement is respecced against the harness thread store (list/switch/rename by thread).
- `tui-harness-chat`: the thread-binds-one-to-one-to-the-session requirement becomes "the thread is the session identity"; boot-gate requirement gains the post-`ready` thread resolution; the frozen-legacy-transcripts note is resolved (they are deleted).
- `workspace-context`: the `openSession` write-path requirement is respecced to carry the thread id.
- `cli-e2e-coverage`: the read-only command sweep drops `inflexa sessions`.
- `auth-session`: the scenario that exercises `inflexa sessions` as its example command is repointed at another read-only command.

## Impact

- **cli code**: `src/db/` (migrations, `primary_query.ts`, `primary_mutation.ts`), `src/types/session.ts`, `src/modules/analysis/launch.ts`, `src/modules/analysis/sessions.ts` (deleted), `src/cli/index.ts` (command removal + policy snapshot test), `src/tui/` (`app.launch.tsx`, `app.tsx`, `commands.tsx`, `contexts/workspace.ts`, `layout/sidebar.tsx`, `hooks/conversation.ts`, `components/chat.tsx`), e2e/unit tests over the removed surfaces, generated CLI docs.
- **harness**: consumed at the package boundary (`ThreadStore.listThreads`/`updateTitle` gain their first CLI callers); the `updated_at`-on-append behavior ships as a companion change in `harness/openspec` (spec deltas to `harness-thread-store`/`harness-thread-history`) and a harness release the CLI pins.
- **Data**: user-local SQLite loses three tables including legacy transcript rows (deliberate, documented in the migration); Postgres becomes the sole session-identity store. Degradation stays symmetric: a deleted SQLite DB leaves unlistable PG threads; a lost PG volume reopens analyses with fresh chats.
