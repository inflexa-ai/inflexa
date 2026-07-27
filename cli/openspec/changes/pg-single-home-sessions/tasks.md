## 1. Thread resolution at the ready edge

- [x] 1.1 Add a post-`ready` thread resolver in the TUI (new hook or `boot.ts` extension): on the `ready` edge, `ThreadStore.listThreads({analysisId})` over `runtime.pool` → most-recent live thread id, else mint `randomUUIDv7()`; write it into the workspace scope. No row creation.
- [x] 1.2 Change `Workspace`/`openSession` to treat `sessionId` as the pg thread id (rename the field or document the identity), including the "freshly minted, no row yet" state; keep the single-write-path resets (abort stream, clear hot state, reload transcript).
- [x] 1.3 Gate session-scoped surfaces pre-`ready`: sidebar SESSION line shows a placeholder; `session.switch`/`session.rename`/`session.delete` palette commands disabled until `ready`.
- [x] 1.4 `App` props become `workingDir` + `analysis` (no `sessionId`); seed the workspace scope accordingly and re-run the analysis-swap flows (`openAnalysis`) through the post-`ready` resolver.

## 2. Launcher slimming

- [x] 2.1 Remove session resolution/creation from `resolveChatTarget` and the three resolvers in `modules/analysis/launch.ts`; `ChatTarget` carries `analysis` + `workingDir` only. Drop the now-unused `resumeSessionId` parameter.
- [x] 2.2 Update `app.launch.tsx` (`renderChat`, `launchNew`/`launchResume`/`launchDefault`) for the slimmed target; verify passive bare-`inflexa` paths still create nothing (no-litter).

## 3. Palette and sidebar over the thread store

- [x] 3.1 `session.switch` dialog lists `listThreads({analysisId})` (live threads, most-recent first) instead of `listSessionsByAnalysis`; empty-state text updated; `openAnalysis` picks most-recent thread via the same read.
- [x] 3.2 `session.rename` calls `ThreadStore.updateTitle`; dialog reads the current pg title.
- [x] 3.3 `session.delete` calls `ThreadStore.deleteThread` (soft, interim per design Decision 4) and re-resolves the analysis's surviving most-recent thread (or a fresh mint).
- [x] 3.4 Sidebar SESSION section reads the thread row (`getThread`) post-`ready`: pg title, created-at age; drop the SQLite msgs-count readout or re-source it from the pg transcript.

## 4. SQLite chat store removal

- [x] 4.1 Migration `version: 2` dropping `parts`, `messages`, `sessions` (child-first) and their indexes, in one transaction; baseline v1 untouched.
- [x] 4.2 Delete session/message/part CRUD from `db/primary_query.ts` and `db/primary_mutation.ts` and their tests; delete `Session`, `Message`, `StoredMessage` from `types/session.ts` (keep the live UI part vocabulary).
- [x] 4.3 Chase remaining importers (`commands.tsx`, `sidebar.tsx`, `launch.ts`, `conversation.ts`, …) to the thread store; `bun run typecheck` clean.

## 5. Remove `inflexa sessions`

- [x] 5.1 Remove the command registration from `src/cli/index.ts` and delete `modules/analysis/sessions.ts`; update the agent-policy snapshot test.
- [x] 5.2 Update e2e read-only sweep (drop `inflexa sessions`) and the auth-session "other commands unaffected" test to use `inflexa ls`; confirm `bun run docs:gen` output no longer includes the page.

## 6. Verification

- [x] 6.1 Migration test: v1-seeded DB with chat rows upgrades to v2 (tables gone, other tables intact); fresh DB ends without chat tables.
- [x] 6.2 TUI flow tests: ready-edge resolution (most-recent / fresh-mint), switch/rename/delete over the thread store, pre-`ready` gating; run `cd cli && bun test` (never from the repo root) and `bun run lint`.
- [ ] 6.3 Manual smoke: open existing analysis (resumes most-recent pg thread), new analysis (empty chat, row appears after first message), rename reflected in picker, boot-failure state shows placeholders.
