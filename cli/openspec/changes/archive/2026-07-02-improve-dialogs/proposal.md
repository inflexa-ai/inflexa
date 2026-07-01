# Improve Dialogs

## Why

An audit of the dialog subsystem found three clusters of defects. (1) The `dialogSize` percentage presets couple dialog proportions to terminal proportions — a terminal cell is ~2× taller than wide, so `lg`/`xl` render near-square or portrait panels on split panes and gigantic mostly-empty boxes on large terminals, and `lg`/`xl` claim fixed heights regardless of content. (2) Dialogs and text inputs are miswired: every `PromptDialog` call site is a single-line prompt, yet the widget embeds the multi-line `TextArea` — Ctrl+J inserts invisible newlines into `height=1` name fields, the INSERT/NORMAL mode word advertises a mode machine that is unreachable inside a modal (esc cancels the dialog), and the double border (panel + input) over-chromes small prompts. (3) Dialog dismissal and focus have no coherent state machine: esc routes through per-dialog `onCancel` while click-outside and ctrl+c bypass it via `dialogClose()` directly (two divergent cancel channels), a busy prompt blocks submit but not dismissal, only the top stack entry is mounted so "dialog needs a dialog" is unexpressible — which forced `app_config.tsx` to hand-roll an inline overlay that is live-broken today (its mode-less form layer keeps matching bare keys, so typing `s` into the postgres-field editor triggers *save* and the keystroke never reaches the input).

## What Changes

- **Rework dialog sizing tokens**: replace the paired-percentage `dialogSize` presets with fixed column widths clamped by a percentage (`maxWidth`), and content-driven height with a `maxHeight` cap for tall tiers; only `xl` (gallery/showcase) keeps near-full-screen fixed dimensions. `DialogPanel` grows `minWidth`/`maxWidth`/`maxHeight` handling and adopts the `stroke` tokens (rounded `stroke.overlay` chrome; `stroke.danger` available via a `tone` prop for destructive dialogs).
- **PromptDialog input rework**: a `multiline` prop selects the input primitive — single-line (the default) renders the `TextInput` primitive (no newline chord, no mode word, single border via `chrome="bare"`); multiline renders `TextArea`. `TextInput` gains an `onSubmit` callback (enter). The duplicated busy text (footer + body spinner line) collapses to one location.
- **Dialog close/focus state machine** (new `dialog-system` capability):
  - Single close funnel: every dismissal gesture (esc, click-outside, ctrl+c, programmatic) routes through `dialogClose(reason)` with `reason ∈ cancel | dismiss | commit`; the entry's `onClose(reason)` is the one lifecycle hook.
  - The host owns the structural esc binding (one layer, not five per-dialog copies); dialogs veto or intercept via an `onRequestClose(reason) → boolean` hook — a busy `PromptDialog` blocks **all** dismissal, not just submit.
  - Click-outside dismisses only when both mouse-down and mouse-up land outside the panel; clicks inside remain capturable by inner components (existing stopPropagation behavior preserved).
  - Real stacking: lower stack entries stay mounted but hidden and inert; the host provides an `isTop` signal per entry, and a dialog's key layers are active only while its entry is topmost.
  - Initial focus is declared by the dialog and applied by the host at open (replacing the competing `focused`-attr / per-dialog microtask grabbers); save/restore at the 0↔N boundary is unchanged.
- **Keymap hygiene**: layers that can be active while a text input is focused MUST NOT bind unmodified printable keys; the mode-stack rule "a mode-less layer is active in every mode" is qualified by the dialog host's `isTop` gating so a stacked modal suspends the layers beneath it.
- **Migrate `app_config.tsx`** off its hand-rolled prompt overlay onto the dialog host (mounting `DialogOverlay` standalone), fixing the swallowed-keystroke bug.
- **Keep and align the orphan dialogs** (`ConfirmDialog`, `AlertDialog`, `ExportOptionsDialog` — currently zero callers, retained for future use): fix `ExportOptionsDialog`'s tab cycle to move renderable focus (not just a signal), and add design-gallery states for the dialog family so the gallery stays the source of truth.

## Capabilities

### New Capabilities

- `dialog-system`: the dialog host state machine — stack semantics (mounted-hidden-inert lower entries, `isTop`), the single close funnel with reasons, host-owned structural keys with per-dialog close interception, the click-outside model, and the initial-focus contract.

### Modified Capabilities

- `tui-design-tokens`: `dialogSize` presets change from paired percentages to fixed widths + percentage clamps with content-driven height (`maxHeight`) for the tall tiers.
- `tui-components`: `DialogPanel` sizing/chrome requirements (clamped presets, `stroke.overlay` border, `tone` prop); `PromptDialog`'s input requirement changes from "uses `TextArea` with `chrome=compact`" to the `multiline`-prop contract.
- `tui-input-primitives`: `TextInput` gains an enter-submit callback requirement.
- `key-bindings`: the mode-stack requirement is amended — a dialog's layers are gated by its stack entry being topmost, and a bare-printable-key hygiene rule is added for layers coexisting with focused text inputs.

## Impact

- `src/lib/design_system.ts` — `dialogSize` token rework.
- `src/tui/components/dialog/` — `dialog_panel.tsx` (clamps, stroke, tone), `dialog_host.tsx` (close reasons, stacking, initial focus, click model), `prompt_dialog.tsx` (multiline prop, busy interception, dedup busy text), `confirm_dialog.tsx` / `alert_dialog.tsx` / `results_dialog.tsx` (drop per-dialog esc layers in favor of the host's), `export_options_dialog.tsx` (renderable-focus tab cycle).
- `src/tui/components/text_input.tsx` — `onSubmit` support.
- `src/tui/keymap.ts` — whatever gating primitive the design lands on (e.g. an `isTop`-style `enabled` convention or a new gate field); no engine rewrite expected.
- `src/tui/app.tsx` — ctrl+c dialog dismissal routes through the close funnel.
- `src/tui/app_config.tsx` — inline prompt overlay replaced by the dialog host; the dead `pushMode(MODE_MODAL)` effect and its contradictory comments removed.
- `src/tui/layout/design_gallery.tsx` — dialog-family showcase states.
- Tests: `dialog_panel.test.tsx` updated; new render tests for close reasons, stacking inertness, and the config-screen prompt fix.
- No new dependencies. Existing `PromptDialog` callers in `commands.tsx` keep working unchanged (single-line default).
