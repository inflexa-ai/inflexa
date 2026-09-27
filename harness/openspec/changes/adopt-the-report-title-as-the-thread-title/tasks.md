# Tasks

Each path is relative to `harness/`.

- [x] 1 Add `src/state/migrations/20260927180000_thread_title_set_by_user.ts`, and register it in `src/state/migrations/index.ts`.
- [x] 2 In `src/memory/thread-store.ts`, make `updateTitle` set `title_set_by_user`, and add `setAutoTitle`.
- [x] 3 In `src/app/chat-turn.ts`, write the title seed through `setAutoTitle`.
- [x] 4 In `src/tools/report-session/preview-report.ts`, add the optional `threads` dep, and name the thread after the rendered document. Give the dep from `src/agents/report-session-agent.ts`.
- [x] 5 Test `setAutoTitle`, the seed after a rename, and the preview title.
