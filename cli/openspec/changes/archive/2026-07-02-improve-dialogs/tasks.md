## 1. Sizing tokens and DialogPanel chrome

- [x] 1.1 Rework `dialogSize` in `src/lib/design_system.ts`: fixed widths (`md: 64`, `lg: 88`, `xl: 116`) with `maxWidth: "90%"`, content height + `maxHeight` for `md` (80%) / `lg` (70%), fixed `85%` height for `xl` only
- [x] 1.2 Update `DialogPanel` to apply `width`/`maxWidth`/`maxHeight` from the presets, set `borderStyle: stroke.overlay`, and add the `tone?: "default" | "danger"` prop (`stroke.danger` + error border color)
- [x] 1.3 Sweep `lg` consumers (`SelectList`, `ResultsDialog`) with the headless `testRender` height/width matrix — ScrollPane bodies must behave under content-height + `maxHeight` (watch the known flexGrow-overlap quirk); update `dialog_panel.test.tsx`
- [x] 1.4 Use `tone="danger"` in the type-to-confirm delete prompts in `commands.tsx`

## 2. TextInput submit and PromptDialog multiline

- [x] 2.1 Add `onSubmit?: (value: string) => void` to `TextInput` (renderable-level enter, mirroring `TextArea`); verify `SelectList`'s filter (no `onSubmit`) is unaffected
- [x] 2.2 Add `multiline?: boolean` to `PromptDialog`: default renders `TextInput` (`chrome="bare"`, enter submits, no newline chord, no mode word); `multiline` renders `TextArea` (`chrome="bare"`) with `height` honored
- [x] 2.3 Collapse the duplicated busy text to the footer only; keep the spinner + input dimming
- [x] 2.4 Verify all `commands.tsx` / `app_config.tsx` PromptDialog callers work unchanged as single-line prompts (no caller edits expected)

## 3. Dialog host state machine

- [x] 3.1 Introduce `CloseReason` (`"cancel" | "dismiss" | "commit"`) in `dialog_host.tsx`: `dialogClose(reason = "commit")` (default revised during implementation — see design.md D3), push-time `onClose(reason)`, `dialogReplace`/`dialogClear` sweep with `"dismiss"`
- [x] 3.2 Add the entry context (`isTop`, `depth`, `setInitialFocus`, `onRequestClose` registration) and the `useDialogBindings` wrapper (ANDs `enabled` with `isTop`)
- [x] 3.3 Render every stack entry (non-top hidden via `visible={false}`) so lower entries stay mounted with state; prune on close
- [x] 3.4 Move esc-to-cancel into one host-owned layer active while the stack is non-empty; delete the per-dialog esc layers in `PromptDialog`, `ConfirmDialog`, `AlertDialog`, `ResultsDialog`, `ExportOptionsDialog`, `SelectList`
- [x] 3.5 Implement `onRequestClose` veto handling in `dialogClose`; wire `PromptDialog` busy to veto all reasons; make `app.tsx` ctrl+c escalate to its next tier when the dismissal is vetoed and pass `"dismiss"` otherwise
- [x] 3.6 Click model: track mouse-down location so dismissal requires down AND up outside the panel; keep the selection guard and the content `stopPropagation`
- [x] 3.7 Initial-focus contract: host applies the declared target on push and on reveal; migrate the per-dialog `onMount` focus microtasks (`PromptDialog`, `SelectList`, `ExportOptionsDialog`, `ScrollPane` focus-on-mount in `ResultsDialog`) to `setInitialFocus`
- [x] 3.8 Migrate all dialog key layers to `useDialogBindings`; route content-dialog `onCancel`/`onClose` props through the entry's `onClose(reason)` (single path for esc / click-outside / ctrl+c)
- [x] 3.9 Render tests: close reasons per gesture, busy veto, stacked-entry state survival + key inertness, press-inside-release-outside, focus restore at N→0

## 4. Consumers and keymap hygiene

- [x] 4.1 Migrate `app_config.tsx` to the host: mount `DialogOverlay` when standalone, replace the inline pg-field overlay with `dialogPush(PromptDialog)`, delete the dead `pushMode(MODE_MODAL)` effect, and gate the form layer so it is suspended while its prompt is open (embedded: `useDialogBindings`)
- [x] 4.2 Render test for the config bug: typing `s`/`q`/space into the postgres-field prompt inserts characters and fires no form action
- [x] 4.3 Fix `ExportOptionsDialog` tab cycle to move renderable focus (blur/focus the textarea) so the visual active row and key-eating widget agree
- [x] 4.4 Audit remaining layers against the bare-printable-key rule (`ResultsDialog` `q` is compliant; document the rule where `useBindings` is documented in `keymap.ts`)

## 5. Gallery and docs

- [x] 5.1 Add a "Dialogs" section to `design_gallery.tsx`: `DialogPanel` size presets and tones, plus representative states of `PromptDialog` (single-line, multiline, busy), `ConfirmDialog`, `AlertDialog`, `ResultsDialog`, `ExportOptionsDialog`
- [x] 5.2 Update `cli/CLAUDE.md`'s dialog-subsystem bullet (close funnel, stacking, `useDialogBindings`) and run `bun run format:file` on all touched `src/` files; `bun run typecheck` + `bun run lint` clean
