## Context

The chat TUI (`src/tui/app.tsx`) is a single Solid-on-opentui screen with one root `useKeyboard` and no modal/overlay system. Every non-chat action (`new`, `resume`, `config`, `open`, `status`, `ls`, `project new`) lives in the commander CLI (`src/cli/index.ts`) as a thin action that lazy-imports a library-pure module core. To do any of those things a user must quit the TUI back to the shell.

The full investigation is captured in `docs/dev_commandPalette.md` and grounded in two probes: opencode's command system (a `@opentui/keymap`-based registry + a generic fuzzy `DialogSelect` + a single `dispatchCommand` verb) and the exact opentui 0.4.0 primitives available to us.

Key constraints:
- **No new dependencies** (CLAUDE.md). `@opentui/keymap` (opencode's registry/leader-key engine) is out; we reimplement only what we need.
- **opentui is Solid, not React** — reactivity via signals/stores, control flow via `<For>`/`<Show>`, no re-renders.
- **`useKeyboard` is a global, focus-agnostic bus** — every handler fires for every key, before the focused widget. This is the load-bearing fact for modal key handling.
- **Theme colors only via `theme()`**; ids via `randomUUIDv7()`; named exports; JSDoc on exports; `type` over `interface`.

## Goals / Non-Goals

**Goals:**
- An in-app command palette opened by one keystroke that fuzzy-filters and runs commands.
- A registry where **adding a command is a single array entry** — the central extensibility property.
- Reuse the existing library-pure module cores; the palette is another thin adapter, parallel to the CLI.
- A reusable overlay/dialog host the palette and future pickers/prompts share.

**Non-Goals:**
- A unified CLI+palette command object (the execution models are incompatible — see Decisions).
- Leader-key sequences, mode stacks, or per-component reactive command contribution (deferred to Phase 3; not needed for v1).
- Exposing stdio/device-flow commands (`auth login`, `setup`) in-app — they stay CLI-only.
- A fuzzy-search dependency — ranking is inline.

## Decisions

### Decision 1: Two adapters over one logic layer (not one shared command object)

The CLI and the palette are **separate registries** that both call the same `src/modules/` cores. The CLI runs in a fresh process with normal stdio (can `console.log`, run clack prompts, call `render()`); the palette runs inside an already-running TUI that owns the alt-screen (cannot use stdio, cannot nest `render()`, must drive in-app dialogs and navigation). Forcing one command object would fight both.

*Alternative considered:* auto-generate the palette from commander definitions. Rejected — most CLI actions either print to stdout or call `render()`, neither of which is valid mid-TUI. opencode reached the same conclusion (separate in-app keymap commands vs. CLI/slash commands).

*Consequence:* "Exposes CLI functionality" means offering the same **actions** backed by the same cores, which is the repo's existing thin-adapter pattern. The principle to enforce: a mutating/printing module function exposes a library-pure core returning `Result`/data; the `console.log` belongs to the CLI adapter, not the core. Most cores (`listRecentAnalyses`, `createProject`, `resolveContext`) already satisfy this.

### Decision 2: Flat declarative registry + `CommandContext` capability surface

Commands are a flat `Command[]` in `src/tui/commands.tsx`; `enabled(ctx)` gates contextual availability; `category` drives grouping as data. Each `run(ctx)` receives a `CommandContext` built in `app.tsx` exposing exactly the in-app capabilities (`openDialog`, `closeDialog`, `openSession`, `notify`, `quit`) plus live state (`sessionId`, `workingDir`, `analysis`). This is the extensibility keystone: a new command is one entry that talks only to the context.

*Alternative considered:* opencode's reactive per-component registration (`useBindings`). Deferred — it shines for contextual command sets tied to mounted components, which v1 doesn't have. A static array + `enabled(ctx)` covers the 90% case; the reactive path is a clean Phase-3 extension behind the same dispatch.

*Alternative considered:* the built-in opentui `<select>`. Rejected for the palette core because it lacks grouping headers, a keybind-hint column, and fuzzy filtering; a small custom list over `<scrollbox>` + `<input>` gives full control and becomes the shared picker engine. It lives in `src/tui/select_list.tsx`, extracted once the Phase-2 pickers became a second caller — per the repo's no-premature-extraction rule.

### Decision 3: Single dispatch verb `runCommand(cmd, ctx)`

All invocation funnels through one verb that awaits `run`. The palette uses it today; keybinds and `/`-slash entry reuse it later. Definition is fully decoupled from invocation, and the stable dotted `id` decouples dispatch from the display `title`.

### Decision 4: Overlay host via an absolute root-child box + `dialogOpen()` keyboard gating

`app.tsx` holds a dialog stack (`createStore`); the top entry renders as an absolutely-positioned, `zIndex`-100 full-screen overlay above the chat — a direct child of the root box rather than a `<Portal>`. A Portal was the original plan, but its wrapper box has no intrinsic size, so the `top/left/right/bottom=0` insets collapse it to the bottom of the layout; mounting the overlay directly under the full-screen root box keeps it full-screen. Because `useKeyboard` is a global bus, the background handlers **early-return while `dialogOpen()`** so the modal owns the keyboard — we do not rely on `stopPropagation()` ordering between subscriptions (which is registration-order-dependent and fragile). The open-key handler calls `key.preventDefault()` so the focused textarea (the renderable-tier handler) does not also consume the keystroke.

*Grounding:* opentui supports `position:"absolute"` + `top/left/right/bottom` + `zIndex` + `opacity` on every box and exposes `key.preventDefault()`/`stopPropagation()` with a global→renderable dispatch order. (`<Portal>` from `@opentui/solid` is available but its size-less wrapper collapses the absolute insets, so the overlay is a direct child of the root box instead.)

### Decision 5: Ctrl+K to open; inline subsequence fuzzy

Ctrl+K is free in the chat TUI (only Ctrl+C/abort and Enter/submit are bound) and matches the VS Code/Linear/Slack convention. Filtering is a ~20-line subsequence scorer weighting title over category — no `fuzzysort`. Empty query lists all, grouped.

### Decision 6: Phasing

- **Phase 1** (overlay host only): Settings, Change theme, Open output folder, Show status, List analyses, New project, Quit — all reuse existing cores and render into dialogs / `notify`. Ships the full UX and extensibility surface.
- **Phase 2** (reactive-session refactor): thread `Analysis` into `App`, hold the current session in a signal, add `openSession` (reload messages, reset stream/error, abort in-flight, bus filters on the reactive id), then add Switch analysis / Switch session / New analysis.
- **Phase 3** (optional): "Suggested" group, per-command keybinds, `/`-slash entry, reactive per-component contribution.

## Risks / Trade-offs

- **Two registries can drift from CLI behavior** → Mitigation: both call the *same* module cores; the palette never reimplements logic, only presentation. Validation parity (e.g. `Str256` for project name) is enforced at each boundary.
- **Reactive-session refactor (Phase 2) is the one nontrivial change** — it rewrites how `App` consumes `sessionId` and how the bus handler filters → Mitigation: phased so Phase 1 ships without it; the change is contained to `app.tsx` + the `chat-wiring` launcher contract, both covered by spec deltas. In-flight chats are aborted on switch to avoid cross-session writes.
- **Global `useKeyboard` bus means a missed gate leaks keys** (e.g. textarea acting while a dialog is open) → Mitigation: a single `dialogOpen()` gate at the top of every background handler, plus `preventDefault()` on the open key; the requirement is spec'd and testable.
- **Absolute overlay sizing across terminal resizes** → Mitigation: a full-screen `top/left/right/bottom = 0` box mounted directly under the root so it tracks dimensions; opentui recomputes layout on resize.
- **Embedding `ConfigApp` as a dialog** (Settings) when it was written as its own render root → Mitigation: it already reads/writes config and uses `theme()`; rendered as a dialog child it shares the single renderer. Its own quit/`renderer.destroy()` path must not fire when embedded — parameterize `ConfigApp` with an `onClose` callback so the dialog wrapper owns close and it does not tear down the renderer.

## Migration Plan

Additive; no data or schema migration. Phase 1 is independently shippable behind the new Ctrl+K binding. Phase 2 changes the `App` props/contract (covered by the `chat-wiring` delta) but all four launchers go through the shared preamble, so they update together. Rollback is removing the binding + new files (Phase 1) or reverting the `App` session signal (Phase 2).

## Open Questions

- Whether "Settings" should embed the full `ConfigApp` or a slimmer in-palette settings dialog — start by embedding `ConfigApp`; revisit if its standalone-screen assumptions (quit handling) prove awkward as a dialog.
