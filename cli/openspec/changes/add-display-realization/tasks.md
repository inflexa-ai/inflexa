# Tasks — display realization (CLI side)

Companion harness change: `harness/openspec/changes/add-display-realization`
(the `data-report-preview` rename + `show_user` `dataPath`). The renderers
here are written against the renamed part types.

## 1. Spec

- [x] `openspec validate add-display-realization --strict` passes
- [x] Review before implementation

## 2. Shared opener (`artifact-open`)

- [x] `openExternal(target)` helper in `lib/`: platform argv, WSL detection (`wslview` → `explorer.exe` + `wslpath -w`), detached spawn, `Result` with ENOENT on the error channel
- [x] Replace the inline openers in `modules/auth/login.ts` and `modules/analysis/open.ts`
- [x] Unit tests: argv selection per platform/WSL, ENOENT degrade

## 3. Materialization cache

- [x] Cache dir in CLI app data, files keyed by `pres-` id
- [x] `svg` → `.svg` file; `echart` → self-contained HTML shell (pinned-major CDN script, offline fallback notice, spec embedded)
- [x] `dataPath` charts: read workspace CSV (RFC-4180, header row, numeric inference), inject `dataset.source`; degraded state on missing/unparseable
- [x] Idempotence test: identical card → same file, no duplicates

## 4. Store mapping (`chat-view`)

- [x] New part types in the message store: inline presentation part + openable-card part (primitive fields only, copy-on-receive)
- [x] `applyEmitEvent`: map `data-presentation` (five kinds), `data-file-reference`, `data-report-preview`(+`-failed`) via shared readers
- [x] `cortexToUiMessage`: same mapping on reload (closes the `TODO(extend)`)
- [x] Keep tagged-mention fallback for unknown `data-*`
- [x] Store tests: live/reload parity per kind, unknown-part fallback

## 5. Blocks (`tui-stream-blocks`)

- [x] Inline presentation block: markdown body / fenced code / markdown table through the `<markdown>` renderable
- [x] Openable-card block: title, per-entry glyph + name + caption rows, resolved path, missing/degraded states; click target wired to the opener
- [x] `never`-typed switch default keeps exhaustiveness
- [x] Design-gallery exhibits for both blocks and their states
- [x] Layout tests (`testRender`) across heights for the new blocks

## 6. Open UX

- [x] `o` binding: open most recent openable card (via keymap layer, remappable command id)
- [x] "Browse artifacts…" palette command: `SelectDialog` over session openables, newest first
- [x] Gallery cards: per-row open + "open containing folder"
- [x] Failure path: notice with resolved path on opener error

## 7. REPL printer (`chat-command`)

- [x] `chat_printer.ts`: text-shaped presentations inline; openables as OSC 8 `file://` link + plain path; `data-report-preview-failed` prints reason
- [x] Printer tests updated

## 8. Verify

- [x] `bun run typecheck`, `bun run lint`, `bun test` green
- [x] `bun run format:file` on touched `src/` files
- [ ] Manual pass: chart → browser opens; `show_file` gallery; report preview; WSL opener; offline echart notice
