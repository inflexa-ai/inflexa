## 1. Command registry and dispatch (foundation)

- [x] 1.1 Create `src/tui/commands.tsx` with the `Command`, `CommandContext`, `CommandCategory` (string-literal union), and `CommandId` types, each with JSDoc on the exported declarations
- [x] 1.2 Declare the empty `commands: Command[]` registry in `commands.tsx` (entries added in §4)
- [x] 1.3 Add the single dispatch verb `runCommand(cmd, ctx): Promise<void>` (awaits `run`) in `src/tui/command_palette.tsx`
- [x] 1.4 Add the inline subsequence fuzzy scorer (title weighted over category) used by the palette filter — no new dependency

## 2. Overlay / dialog host (Phase 1 infra)

- [x] 2.1 Add a dialog stack (`createStore`) and `dialogOpen()` accessor to `App` in `src/tui/app.tsx`
- [x] 2.2 Render the top dialog as an absolutely-positioned, `zIndex`-100 full-screen overlay above the chat — a direct child of the root box, NOT a `<Portal>` (a Portal's wrapper box has no size, so the `top/left/right/bottom=0` insets would collapse it); theme background, dim via `opacity`
- [x] 2.3 Gate every background `useKeyboard` handler in `App` on `dialogOpen()` (early-return) so the modal owns the keyboard; exempt the in-flight Ctrl+C abort so a streaming response stays cancellable while a dialog is open
- [x] 2.4 Build the `CommandContext` in `App` (live state + `openDialog`/`closeDialog`/`notify`/`quit`; `openSession` is wired in Phase 2)
- [x] 2.5 Add a `notify` status-line/toast surface to `App` for `ctx.notify` (info/warn/error), reusing theme tokens; a notice auto-clears after a short timeout or when the next notice/command replaces it
- [x] 2.6 Bind Ctrl+K in `App` to push the palette, calling `key.preventDefault()` so the textarea does not consume the key; restore focus to the chat input on close

## 3. Command palette UI

- [x] 3.1 Implement `CommandPalette` in `command_palette.tsx`: focused single-line `<input>` search + grouped `<scrollbox>` result list (the reusable list stays inline until a second caller)
- [x] 3.2 Filter by `enabled(ctx)` then fuzzy-rank by query; group by category; show a per-row keybind hint when present
- [x] 3.3 Keyboard nav: Up/Down and Ctrl+P/Ctrl+N move the highlight; `scrollChildIntoView` keeps it visible; Enter dispatches via `runCommand` and closes; Esc closes without acting
- [x] 3.4 Add small reusable dialog components used by commands: a `PromptDialog` (single-input submit) and a read-only `ResultsDialog` (with an empty-state message when its list is empty), each with its own Esc handler that pops only when it is the top dialog

## 4. Phase-1 commands (no chat swap)

- [x] 4.1 Quit — `ctx.quit()`
- [x] 4.2 Change theme — picker dialog applying `setTheme` and persisting via `writeConfig`; running chat recolors in place
- [x] 4.3 Parameterize `ConfigApp` (`src/tui/config.tsx`) with an embedded/`onClose` mode so its quit path calls back to the dialog host instead of `renderer.destroy()` + `shutdown`
- [x] 4.4 Settings — embed the parameterized `ConfigApp` as a dialog (the dialog wrapper owns close)
- [x] 4.5 Open output folder — `openOutputDir(ctx.analysis)` (the library-pure core the `inf open` CLI's `runOpen` wraps), `enabled: ctx.analysis !== null`
- [x] 4.6 List analyses — render `listRecentAnalyses` into a `ResultsDialog`, with an empty-state message when there are none (no stdout)
- [x] 4.7 Show status — render `resolveContext`/`describeContext` into a `ResultsDialog`
- [x] 4.8 New project — `PromptDialog` → `createProject` with `Str256` validation at the boundary; outcome via `ctx.notify`

## 5. Phase-2 reactive session refactor

- [x] 5.1 Add `analysis: Analysis` to `App` props and thread it through `launchChat`/`renderApp` in `src/tui/launch.tsx`
- [x] 5.2 Hold the current session in a reactive signal in `App`, seeded from the `sessionId` prop
- [x] 5.3 Change the bus event handler to filter by the current reactive session id (not the static prop)
- [x] 5.4 Implement `App.openSession(sessionId, workingDir, analysis)`: abort any in-flight chat, swap the session/dir/analysis signals, reload messages, reset stream/error state; expose it on `CommandContext`
- [x] 5.5 Update the `chat-wiring` launch-preamble call sites so `App` props are `sessionId` + `workingDir` + `analysis` across all four launchers

## 6. Phase-2 session-switching commands

- [x] 6.1 Switch analysis — picker dialog over `listRecentAnalyses` (empty-state when none) → `ctx.openSession` for the chosen analysis's session
- [x] 6.2 Switch session — `enabled: ctx.analysis !== null`; picker over `listSessionsByAnalysis(ctx.analysis)` (empty-state when none) → `ctx.openSession`
- [x] 6.3 New analysis — `PromptDialog` for a name → create analysis + session (deliberate action; anchor marker allowed) → `ctx.openSession`

## 7. Verification

- [x] 7.1 Manually verify: Ctrl+K opens the palette without leaking `k` to the textarea; Esc closes; a dialog swallows background keys (but Ctrl+C still aborts a stream)
- [x] 7.2 Manually verify each Phase-1 command; then each Phase-2 switch command swaps the chat in place with no process restart and aborts an in-flight stream
- [x] 7.3 Run `bun run format:file` on changed `src/` files, then `bun run typecheck` and `bun run lint` pass (0 errors; the remaining solid/reactivity warnings are the sanctioned prop→signal seeds and the neverthrow `.match` callbacks)
