## 1. Central keymap

- [x] 1.1 Create `src/tui/keymap.ts`: a static table mapping logical actions to `{ chord, label }` — chat: `openPalette`, `toggleRail`, `abort`, `newline`, `submit`; config: `save`, `exit`, `moveSelection` (config shares `StatusBar`, so its hints come from the keymap too). Import only `process.platform`; no `@opentui/*`/`solid-js`/`theme`/domain imports.
- [x] 1.2 Render labels OS-aware: `process.platform === "darwin"` → `⌘`/`⌥`/`^` glyphs (`⌘K`, `⌥S`, `^C`); otherwise `Ctrl+`/`Alt+` text (`Ctrl+K`, `Alt+S`, `Ctrl+C`). Keep real chords as Ctrl/Alt (Meta) — no Cmd capture.
- [x] 1.3 Export typed accessors (a `keymap` object / label getter) and JSDoc each export; document that ⌘ is a display label only (terminals do not forward Cmd).

## 2. Status bar (`layout/status_bar.tsx`)

- [x] 2.1 Create `src/tui/layout/status_bar.tsx` exporting `StatusBar`. Props: a left identity/title region, an OPTIONAL middle region (chat passes live state; config passes its unsaved-changes indicator, rendered only when dirty), and right-side affordance hint labels. Import only `theme` (+ opentui/solid) and `keymap`.
- [x] 2.2 Left = `inf` in `theme().accent` + the active analysis name; middle = `ready`/`thinking`/`error` colored `theme().success`/`warn`/`error`; right = keymap labels (⌘K · ⌥S · ^C). All colors via `theme()`, no inline hex.

## 3. Message block (`layout/message_block.tsx`)

- [x] 3.1 Create `src/tui/layout/message_block.tsx` exporting `MessageBlock`. Fixed 2-space gutter column; marker `>` (`theme().user`) for user, `<` (`theme().assistant`) for assistant; role label; markdown body. No meta footer.
- [x] 3.2 Move the existing per-message render (the `<For each={msg.parts}>` + `<markdown streaming>` logic) into `MessageBlock` verbatim — preserve the live `streamText`/`streamPartId` read and on-complete flush; do not change streaming behavior.

## 4. Input bar (`layout/input_bar.tsx`)

- [x] 4.1 Create `src/tui/layout/input_bar.tsx` exporting `InputBar`. Wrap the existing `<textarea>` (ref/focus, `keyBindings`, `onSubmit`, placeholder/colors) plus a single hint row whose labels come from `keymap` (Enter send · Alt+Enter newline · ⌘K cmds · ⌥S rail).
- [x] 4.2 Keep the textarea ref/focus contract intact (focus-on-mount, focus restored on dialog close is still owned by `app.tsx`).

## 5. Right rail (`layout/right_rail.tsx`)

- [x] 5.1 Create `src/tui/layout/right_rail.tsx` exporting `RightRail`, a fixed-width column with a left divider, rendering four sections in order: SESSION, CONTEXT, ANALYSIS, RUNS.
- [x] 5.2 SESSION: short session id (`S·` + the first 4 hex of the id, per the wireframe), session age as a relative duration (e.g. `6m ago`) from `getSession(sessionId).createdAt`, and message count (reuse the live `messages` store length passed in — no per-frame query).
- [x] 5.3 ANALYSIS: name; anchor path + ✓/⚠ badge from the anchor's `markerWritten` (`getAnchor(analysis.anchorId)` / `resolveAnchor`); input chips from `listAnalysisInputs(analysis.id)`; project name from `findProjectByRef(analysis.projectId)` when set.
- [x] 5.4 CONTEXT and RUNS: render explicit placeholder text (`—`, "no runs yet"). Do NOT fabricate token/cost/run values.
- [x] 5.5 Drive section data from a `createMemo` keyed on the current-analysis/current-session signals so an in-place `openSession` swap updates the rail.

## 6. Recompose `app.tsx` to Direction B

- [x] 6.1 Replace the inline header box with `<StatusBar …>`; replace the inline message `<For>` body with `<MessageBlock>`; replace the inline input box with `<InputBar>`. Keep the error banner + notice between stream and input.
- [x] 6.2 Add a `railOpen` signal (default `true`); render the stream and `<Show when={railOpen()}><RightRail …></Show>` side by side (Direction B); hidden rail = full-width stream (Direction A).
- [x] 6.3 In the existing `useKeyboard`, add the keymap `toggleRail` chord (Alt+S/Meta+S) to flip `railOpen`, placed AFTER the `dialogOpen()` early-return so it is gated while a dialog is open. Source the Ctrl+K branch's intent from the keymap; preserve the Ctrl+C-abort-while-busy branch.
- [x] 6.4 Preserve verbatim: the overlay dialog host + `zIndex`/scrim, keyboard gating, streaming flush, and focus-on-dialog-close effect.
- [x] 6.5 Preserve the empty-state welcome line (`<Show when={messages.length === 0}>` → "Welcome to inf…") in the stream area after the recompose.

## 7. Config screen adopts the shared status bar

- [x] 7.1 In `src/tui/app_config.tsx`, replace the hand-rolled header box (`inf config | …`) with `<StatusBar …>`: title `inf config`; middle region = the unsaved-changes indicator (shown only when dirty); right hints sourced from the keymap's config actions (`save` / `exit` / `moveSelection`).

## 8. Palette + commands read keymap labels

- [x] 8.1 In `src/tui/command_palette.tsx` / `src/tui/commands.tsx`, render per-row keybind hints and the invocation hint through the keymap (OS-aware), replacing the hardcoded `keybind: "Ctrl+C"`-style strings. The bound Ctrl+K chord stays unchanged.

## 9. Documentation

- [x] 9.1 Update `CLAUDE.md` Project-structure section to document `src/tui/layout/` (the app-shell composition kit, distinguished by role from `tui/components/`) and note it as a scoped exception to the single-caller rule.

## 10. Format, type-check, verify

- [x] 10.1 Run `bun run format:file` on every changed file under `src/`.
- [x] 10.2 Run `bun run typecheck` and `bun run lint`; fix any issues (no `forEach`, no destructured props, no inline hex).
- [ ] 10.3 Manually verify with `bun run dev`: status bar shows analysis name + live state; rail shows real SESSION/ANALYSIS data with CONTEXT/RUNS placeholders; Alt+S toggles the rail and is gated during a dialog; Ctrl+K still opens the palette; `inf config` renders the shared `StatusBar`.

## 11. Layout adjustments (round 2)

- [x] 11.1 Drop OS-aware keymap labels — `Ctrl+`/`Alt+` text on every platform (`keymap.ts`); update the `key-bindings` and `command-palette` specs accordingly.
- [x] 11.2 Move chat status into a reactive store `src/tui/hooks/status.ts` (accessor + setter, the `theme.ts` shape); `app.tsx` only reads it, the bus handler / session swap set it; render each state with a leading glyph (`● ready` / `◐ thinking…` / `✗ error`).
- [x] 11.3 Make `RightRail` mouse-resizable: a 1-col left divider drag handle (`onMouseDrag` → `onResize(e.x)`); `railWidth` signal in `app.tsx` (default 40, clamped); enable `useMouse`/`enableMouseMovement` in the chat render (`app.launch.tsx`).
- [x] 11.4 Replace the input-bar keymap hint row with hardcoded session/mode info (`INSERT · ⌥ agents` left, `xhigh /effort` right); global key hints now live only in the status bar (no duplication).
- [x] 11.5 Add the shared gutter marker set `src/tui/layout/markers.ts` (8 kinds → glyph + theme role, no new tokens); `MessageBlock` renders its marker from it.
- [x] 11.6 `typecheck` + `lint` + `format:file` on changed files; smoke-test keymap labels / `matchChord` / status store / marker set (all pass).
- [ ] 11.7 Manually verify in `bun run dev`: status glyph shows; input footer shows the session/mode row; header shows the global key hints. (Superseded by round 3 below — the drag and Alt/⌘ labels were reverted.)

## 12. Sidebar + keybinds (round 3)

- [x] 12.1 Remove the draggable resize; rename `right_rail.tsx` → `sidebar.tsx`, `RightRail` → `Sidebar`, and all "rail" terminology → "sidebar" across specs, design, proposal, and CLAUDE.md.
- [x] 12.2 Full-height sidebar: restructure `app.tsx` into a main row of (chat column = stream + banners + input) beside a full-height `<Sidebar>` (fixed width 40); showing it shrinks the chat column — the opencode layout. Remove `useMouse`/`enableMouseMovement` from `app.launch.tsx`.
- [x] 12.3 Keybind hint labels ALWAYS lowercase — `keymap.ts` labels + the `key-bindings` spec rule + CLAUDE.md.
- [x] 12.4 Fix Alt not firing: move the sidebar toggle from `alt+s` to `ctrl+b` (with `preventDefault`). Root cause: terminals deliver Alt/Option unreliably (macOS Option composes a character); confirmed against opencode, which avoids `alt+` (21 ctrl vs 2 alt) and toggles its sidebar with a Ctrl-leader.
- [x] 12.5 `typecheck` + `lint` + `format:file` + smoke test (lowercase labels, `ctrl+b` match, no `toggleRail`) — all pass.
- [ ] 12.6 Manually verify in `bun run dev`: `ctrl+b` toggles the full-height sidebar and the chat column (stream + input) shrinks; all hint labels are lowercase (`ctrl+k · ctrl+b · ctrl+c`); the Alt issue is gone.
