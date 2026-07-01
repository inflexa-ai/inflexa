## 1. Core Components

- [x] 1.1 Create `TextArea` component (`src/tui/components/text_area.tsx`) — wraps `<textarea>` with themed styling, `chrome` prop (`"full"`/`"compact"`/`"bare"`), INSERT/NORMAL mode tracking via `focused` accessor, border color signaling, and renderable-level submit/newline `keyBindings` sourced from `SUBMIT_CHORD`/`NEWLINE_CHORD`
- [x] 1.2 Create `TextInput` component (`src/tui/components/text_input.tsx`) — wraps `<input>` with themed styling, `chrome` prop (`"compact"`/`"bare"`), per-keystroke `onInput` callback, no mode concept

## 2. Chat Bar Migration

- [x] 2.1 Rename `src/tui/layout/input_bar.tsx` → `src/tui/layout/chat_bar.tsx` and refactor `InputBar` → `ChatBar` to compose `TextArea` with `chrome="full"`, keeping the external INSERT/NORMAL footer row and newline hint
- [x] 2.2 Update `app.tsx` import from `InputBar`/`input_bar` to `ChatBar`/`chat_bar`

## 3. Dialog Migrations

- [x] 3.1 Migrate `PromptDialog` to use `TextArea` with `chrome="compact"` — replace raw `<textarea>` and move enter-to-submit from keymap engine to renderable-level (via TextArea's built-in `onSubmit`)
- [x] 3.2 Migrate `ExportOptionsDialog` to use `TextArea` with `chrome="bare"` for its optional text field — replace raw `<textarea>`, keep tab-cycling and form-level confirm logic in the keymap engine
- [x] 3.3 Migrate `SelectList` to use `TextInput` with `chrome="bare"` for its filter input — replace raw `<input>`

## 4. Design Gallery

- [x] 4.1 Add TextArea gallery entries showing all three chrome tiers (full/compact/bare) in both INSERT and NORMAL states
- [x] 4.2 Add TextInput gallery entries showing compact and bare chrome tiers

## 5. Verification

- [x] 5.1 Run `bun run typecheck` — all imports resolve, no type errors
- [x] 5.2 Run `bun run lint` — no lint violations
- [x] 5.3 Run `bun run dev` and visually verify: chat input, command palette filter, prompt dialogs, export options dialog, and design gallery all render correctly with consistent styling and mode signaling
