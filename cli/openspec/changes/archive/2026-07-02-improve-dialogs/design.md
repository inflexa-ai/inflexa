# Design — improve-dialogs

## Context

The dialog subsystem is `src/tui/components/dialog/`: `DialogPanel` (chrome), `dialog_host.tsx` (module-level stack + `DialogOverlay`), and five content dialogs. Sizing comes from the `dialogSize` presets in `src/lib/design_system.ts`; keys route through the keymap engine (`src/tui/keymap.ts`), which sees every keystroke before the focused opentui renderable and `preventDefault`s matched chords.

Audit findings driving this design (all verified against source):

- `dialogSize` pairs percentages (`lg: 70%/60%`, `xl: 80%/80%`). Terminal cells are ~2× taller than wide, so equal-ish percentages render square/portrait panels on split panes and huge empty panels full-screen. `lg`/`xl` fix height regardless of content.
- `PromptDialog` embeds `TextArea` (`chrome="compact"`) though all seven call sites are single-line prompts: Ctrl+J inserts hidden newlines into `height=1` fields; the INSERT/NORMAL title word is unreachable fiction inside a modal (esc cancels the dialog); panel border + input border double-chromes an `md` prompt.
- Dismissal is three code paths: esc → per-dialog binding → `onCancel` prop; click-outside → `dialogClose()` directly (`dialog_host.tsx:164`); ctrl+c → `dialogClose()` directly (`app.tsx:88`). Only the esc path runs `onCancel`; only push-time `onClose` runs on all paths. `PromptDialog`'s busy state gates submit but none of the dismissal gestures.
- The host mounts only the top stack entry (`<Show when={dialogTop()} keyed>`), so a lower dialog unmounts and loses state when anything stacks above it. The palette works around it (close-before-run); `app_config.tsx` hand-rolled an inline overlay instead — and that overlay is live-broken: its `pushMode(MODE_MODAL)` effect (`app_config.tsx:87-91`) is a no-op because the form's key layer declares no `mode` (`:236`) and mode-less layers are active in every mode (`keymap.ts:400`). Typing `s`/`q`/space/arrows in the postgres-field prompt triggers form actions and the keystroke is `preventDefault`'d away from the input.
- `ExportOptionsDialog`'s tab cycle moves a signal, never renderable focus — unbound keys keep landing in its textarea while an option row is highlighted.
- `ConfirmDialog`, `AlertDialog`, `ExportOptionsDialog` have zero callers (kept deliberately — see proposal); no dialog appears in the design gallery.

Constraints: no new dependencies; the keymap engine's core contract (single root handler, layers as data, `preventDefault`-first) is in-flight under `add-keymap-engine` and must be amended, not rewritten; existing `PromptDialog` callers in `commands.tsx` should not need changes.

## Goals / Non-Goals

**Goals:**

- Dialog proportions that read as landscape panels at any terminal size; content-height by default.
- One input primitive per prompt shape: `TextInput` for single-line (the default), `TextArea` behind an explicit `multiline` opt-in.
- A single, reasoned close funnel; busy dialogs can block every dismissal gesture.
- Stacking that actually works: a dialog can open a dialog without destroying the one beneath.
- `app_config.tsx` on the shared host; the swallowed-keystroke bug dead.
- Gallery coverage for the dialog family.

**Non-Goals:**

- No visual redesign beyond sizing/stroke (colors, titles, footers keep their look).
- No animation/transition work.
- No change to `SelectList`'s interaction model (it inherits sizing + host fixes only).
- No new callers for the orphan dialogs — they are aligned and showcased, not productized.
- No keymap-engine rewrite; only the gating amendments the state machine needs.

## Decisions

### D1 — Sizing: fixed widths clamped by percentage; content height with caps

`dialogSize` becomes:

| preset | width | maxWidth | height | maxHeight | use |
|---|---|---|---|---|---|
| `md` | 64 cols | `90%` | content | `80%` | prompts, confirms, alerts |
| `lg` | 88 cols | `90%` | 20 rows | `80%` | pickers, results |
| `xl` | 116 cols | `90%` | `85%` | — | gallery/showcase |

Rationale: OpenCode's fixed-column tiers (60/88/116) are the proven shape for terminal dialogs — a panel's readable line length doesn't scale with monitor size. The percentage moves from *the* dimension to a *clamp*, keeping small-terminal responsiveness without large-terminal ballooning. Heights split by whether content changes while the dialog is open (revised during dogfooding from an all-content-height design): `lg` pickers filter live, and a panel that resizes as its list shrinks is worse UX than trailing empty rows — so `lg` holds a fixed 20 rows (clamped on short terminals). Only `md` is content-height: its body (a prompt line, a confirm message) is static for the dialog's lifetime, so nothing can shrink mid-interaction. Alternatives considered: pure percentages with different ratios (still couples aspect to terminal aspect — rejected); per-dialog explicit dimensions (destroys the token system's uniformity — rejected); content-height pickers (rejected after dogfooding — filtering visibly resized the palette).

Consequence for `lg` consumers (`SelectList`, `ResultsDialog`): their `ScrollPane` bodies simply `flexGrow` into the fixed panel. Two opentui quirks the `testRender` sweep confirmed while landing this: (1) opentui's scrollbox always FILLS available space — its internal viewport is `flexGrow`, so it cannot shrink to content (this is what makes content-height pickers impractical anyway: the exact-fit bound `maxHeight = rows + paddingTop + 1` had to be hand-measured); (2) a percentage-capped panel must not sit inside an auto-sized wrapper — yoga resolves `%` against the parent, and an indefinite parent squeezes the panel below its content — so the overlay's per-entry wrapper is a full-inset self-centering box and click containment moved onto `DialogPanel` itself.

`DialogPanel` also adopts `borderStyle: stroke.overlay` (the token contract already says overlays are rounded; today it silently uses the default) and a `tone?: "default" | "danger"` prop mapping to `stroke.danger` + `theme().error` border for destructive dialogs — the type-to-confirm delete prompts are the first consumer.

### D2 — PromptDialog: `multiline` prop selects the primitive

`PromptDialog` gains `multiline?: boolean` (default false).

- **false**: renders `TextInput` (`chrome="bare"` — the panel border is the chrome; no second border, no mode word). Enter submits via the new `onSubmit`; there is no newline chord. The `height` prop is ignored/absent.
- **true**: renders `TextArea` as today (`chrome="bare"` too — same single-border rationale; the mode word is meaningless inside a modal so `compact`'s title adds nothing), with `height`/Ctrl+J newline semantics intact.

`TextInput` gains `onSubmit?: (value: string) => void` wired to opentui's input submit event, mirroring `TextArea`'s. `SelectList`'s filter usage passes no `onSubmit` (enter is handled by its keymap layer) — unchanged.

Busy state: the spinner row remains the single busy indicator; the footer keeps showing the key hints' replacement (`busyText`) only — the duplicated body/footer copy is collapsed to footer-only display, and the input dims as today. Busy also engages the D3 close interceptor.

Alternative considered: teaching `TextArea` a "single-line mode" (suppress newline, height 1). Rejected — that re-implements `TextInput` inside `TextArea` and keeps the mode machinery where it can leak; the codebase already owns the right primitive.

### D3 — One close funnel with reasons; host-owned esc; per-dialog interception

`dialog_host.tsx` API becomes:

```ts
type CloseReason = "cancel" | "dismiss" | "commit";
dialogPush(render, onClose?: (reason: CloseReason) => void);
dialogClose(reason?: CloseReason); // default "commit"
```

The default is `"commit"` (revised during implementation from the proposal's `"cancel"`): every
bare programmatic `dialogClose()` / `ws.closeDialog()` in the codebase sits at the tail of a
submit/select handler, so commit-by-default is what lets those call sites keep working with zero
edits — gestures always pass their reason explicitly. Two companion mechanisms make the legacy
caller shape safe: nested `dialogClose` calls during close-hook dispatch are swallowed (an
`onCancel` body ending in `ws.closeDialog()` cannot double-pop a stacked dialog), and content
dialogs register their cancel props via `useDialogCancel` (fires on non-commit reasons only).

- **Host binds esc once** in a layer owned by `DialogOverlay` (active while the stack is non-empty): `dialogClose("cancel")`. The five per-dialog esc layers are deleted. Dialog-specific close keys (`q`/enter in `ResultsDialog`/`AlertDialog`) stay per-dialog but call `dialogClose(reason)` instead of caller props.
- **Click-outside** → `dialogClose("dismiss")`. **Ctrl+c** (app.tsx) → `dialogClose("dismiss")`. **Submit/select flows** close with `"commit"` after the caller's action.
- **Interception**: a push-time `onRequestClose?: (reason: CloseReason) => boolean` (return false to veto). `PromptDialog` exposes its busy state to its pusher via this hook — busy vetoes every reason, making busy dismissal-proof (today it blocks only submit).
- **`onCancel` props survive as sugar**: content dialogs keep their `onCancel`/`onClose` props for callers, but internally they are invoked from the entry's `onClose(reason)` — one path, so esc / click-outside / ctrl+c can no longer diverge. Existing `commands.tsx` callers keep working: `PromptDialog` wires its own `dialogPush`-level plumbing… **no** — see D6: callers still push render thunks; the *dialog components* register their interceptors via a small host hook (`useDialogEntry()`) rather than requiring every caller to pass host opts.

Alternative considered: keeping the two channels and documenting "wire cleanup in `onClose` only". Rejected — a convention that silently breaks per gesture is exactly what the audit caught.

### D4 — Real stacking: lower entries stay mounted, hidden, inert

`DialogOverlay` renders **every** stack entry, not just the top: each wrapped in a box with `visible={false}` (opentui's render-skip) for non-top entries. Each entry's render thunk is wrapped in a context provider carrying `{ isTop: () => boolean, depth }`.

Inertness has two halves:

- **Keys**: a new host-provided hook, `useDialogBindings(config)`, a thin wrapper over `useBindings` that ANDs `enabled` with the entry's `isTop()`. All dialog components migrate their layers to it. The keymap engine itself is untouched — `isTop` is just another reactive `enabled` input, which the engine already re-evaluates per keystroke.
- **Focus**: on push, the host blurs the previous top's focused renderable and applies the new top's initial focus; on close, it re-applies the newly-revealed top's initial focus (or, at depth 0, restores the app focus saved at 0→1 — the existing `tui-layout` contract, unchanged).

Initial focus contract: dialogs declare their focus target by calling `useDialogEntry().setInitialFocus(renderable)` in their ref callbacks (the host applies it via the existing `queueMicrotask` timing). The scattered self-focus grabbers (`focused` attr races, per-dialog `onMount` microtasks) collapse into this single mechanism. `TextInput`/`TextArea` keep their `focused` attr for non-dialog hosts (ChatBar) but dialogs stop relying on it.

Why mounted-hidden over top-only-with-replace: the depth-2 need has materialized twice (palette close-before-run at `command_palette.tsx:38-40`; app_config's hand-rolled overlay), and top-only *forces* inline overlays, which is how the mode-gating bug was born. The cost — hidden dialogs keep their Solid state and renderables alive — is bounded: real stacks are depth ≤ 2-3, and entries are pruned on close.

The palette's close-before-run behavior is *kept* (a picker replacing the palette is good UX); stacking is for cases that want it, not a new default.

### D5 — Keymap amendments: `isTop` gating + bare-key hygiene

Two spec-level amendments to `key-bindings` (no engine code change beyond what D4's hook needs):

1. The "a mode-less layer is active in any mode" rule gains the qualifier: a layer belonging to a dialog entry SHALL be gated on that entry being topmost (via `useDialogBindings`). `MODE_MODAL` continues to suspend `MODE_BASE` layers; entry-gating handles modal-over-modal, which the mode stack cannot express (both entries are "modal").
2. Hygiene rule: a layer that can be active while a text input is focused MUST NOT bind unmodified printable keys. Today's violator is `app_config.tsx`'s form layer (`s`, `q`, space, enter live while its prompt is up) — fixed structurally by D6. `ResultsDialog`'s `q` is compliant (no input inside it). Enforced by convention + spec scenario, not an engine guard — an engine-level "skip bare keys when an editor is focused" heuristic would silently change dispatch semantics for correct layers (e.g. NORMAL-mode vim keys gated by focus `target`).

### D6 — app_config migrates to the dialog host

`ConfigApp` mounts `DialogOverlay` when standalone (embedded, the chat `App`'s overlay already exists — the host is module-level, so both cases share the same stack; the overlay component must therefore be render-once *per renderer*, which holds: standalone config owns its renderer). The pg-field editor becomes a plain `dialogPush` of `PromptDialog`. The form's key layer gates itself with `enabled: !dialogIsOpen() && …` (standalone) — and because the form screen itself may be *embedded as a dialog* in the chat app, its layer moves to `useDialogBindings` in that mode, which handles both suspension directions with one mechanism. The broken `pushMode(MODE_MODAL)` effect and its comment are deleted.

### D7 — Orphans aligned, gallery gains a dialog section

`ConfirmDialog`/`AlertDialog` migrate to the funnel (D3) mechanically. `ExportOptionsDialog`'s tab cycle calls `.blur()`/`.focus()` on the textarea renderable so renderable focus tracks `activeKey` (visual-active == key-eating, per the focus contract). The design gallery gains a "Dialogs" section showcasing `DialogPanel` sizes/tones and each content dialog in a representative state — satisfying the gallery-as-source-of-truth rule the subsystem currently violates.

## Risks / Trade-offs

- [`lg` content-height + ScrollPane under `maxHeight` may hit yoga/scrollbox quirks (the known flexGrow-overlap bug)] → verify with the headless `testRender` height sweep before landing; the panel-background footer remedy is already documented and in place.
- [Mounted-hidden stack entries keep timers/effects alive (e.g. a hidden busy spinner)] → acceptable at depth ≤ 3; `PromptDialog`'s spinner effect is cheap; document that heavyweight dialogs should pause work when `!isTop()`.
- [Changing `dialogClose()`'s signature ripples through callers] → default reason `"cancel"` keeps the bare call compiling and semantically close to today; the sweep of call sites is mechanical.
- [`onRequestClose` veto could trap a user in a stuck busy dialog] → a quick second ctrl+c press (within a 1.5s window) escalates past the veto to stream-abort/quit. First-press escalation was rejected during implementation: config's dirty-guard veto ARMS a confirm on the first press, and escalating immediately would have quit the whole app on a single accidental ctrl+c.
- [Two `DialogOverlay` mounts on one renderer would double-render the stack] → the embedded-config case reuses the chat's overlay; assert/document render-once-per-renderer as the host contract (matches the existing `useKeymapRoot` once-per-renderer rule).
- [Spec churn against the in-flight `add-keymap-engine` change] → the amendment is additive (a qualifier + a hygiene rule) and phrased against the capability spec, not that change's tasks.

## Open Questions

- None blocking. Preset column widths (64/88/116) may be tuned after seeing them in the gallery; the token structure is the decision, the integers are calibration.
