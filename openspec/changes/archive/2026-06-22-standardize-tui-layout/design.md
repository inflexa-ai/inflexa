## Context

`src/tui/app.tsx` (≈364 lines) is a single render tree: an inline header box, an inline `<For>` message loop, an input `<textarea>`, an error banner, and a notice. `src/tui/app_config.tsx` hand-rolls its own header box. There is no sidebar, so the active analysis / anchor / session — the domain the user is actually working in — is not glanceable. The "inf CLI Wireframes" design resolves this with **Direction B (stream + toggleable sidebar)** and a locked five-part shared kit (status bar · message block · gutter markers · input bar · sidebar sections) plus a keyboard-first nav map.

Grounding against the codebase:
- Theme tokens (`ThemeColors` in `src/lib/themes.ts`) already cover every gutter-marker color (`user`, `assistant`, `warn`, `muted`, `secondary`, `success`, `error`) — **no new tokens**.
- Sidebar data: `Session.createdAt`, `listSessionMessages()`, `Analysis`, `getAnchor().markerWritten`, `listAnalysisInputs()`, and project lookup all exist. **There is no run/task/step or token/cost concept anywhere** in `src/types`, `src/db`, or `src/modules` (verified by grep), so two of the four sidebar sections have no data.
- Keybinds: there is no keybind engine (`commands.tsx` says so); chords are scattered across `app.tsx`, `app_config.tsx`, `select_list.tsx`, and hints are hardcoded strings. OS branching on `process.platform` is already idiomatic (`env.ts`, `login.ts`).

Constraints: Solid + opentui rules (no prop destructuring; signals/stores; `<For>`/`<Show>`; `theme()` colors only; `renderer.destroy()` before shutdown); no new dependencies; no `forEach`; `modules/` must never import `tui/`.

## Goals / Non-Goals

**Goals:**
- One reusable shell kit under `src/tui/layout/` that both `app.tsx` and (for the status bar) `app_config.tsx` compose, so screens stay cohesive.
- Direction B: persistent status bar → a main row of (stream + input) beside a full-height toggleable sidebar (`ctrl+b` hides it, giving the chat column full width).
- A single keymap as the source of truth for keybind chords and their lowercase display labels.
- Honest sidebar: real data where it exists, explicit placeholders where it does not.

**Non-Goals:**
- The 8 "key moments" (thinking / tool / run / diff / error-card / welcome / palette-as-block). Only user/assistant text turns render now.
- The ⌥R run monitor and ^◄/^► session switching (define in the keymap only if trivial; otherwise defer).
- Any data-model work for CONTEXT (tokens/cost) or RUNS. Those sections stay inert placeholders.
- A keybind *engine* (rebindable chords, conflict resolution). The keymap is a static table.

## Decisions

**D1 — `src/tui/layout/` as a documented exception.** The kit parts are single-caller (only `App` composes the full shell) and domain-coupled (the sidebar reads `Analysis`/`Anchor`/`AnalysisInput`). That fails both the "don't extract single-caller sub-components" coding rule and the `tui/components/` membership rule (theme-only + ≥2 callers). Rather than bend either rule, add a sibling directory distinguished by **role**: `layout/` holds the app-shell composition kit; `components/` holds reusable domain-agnostic widgets. `CLAUDE.md` is updated to document `layout/` (as it already documents the `app_config.tsx` exception).
- *Alternative — keep inline in `app.tsx`:* respects the letter of the rule but pushes `app.tsx` past ~500 lines and hides the "kit" the design explicitly locks. Rejected by the user.
- *Alternative — put generic parts in `components/`:* only `StatusBar` qualifies; splitting the kit across two dirs by import-shape (not role) is more confusing than one cohesive `layout/`.

**D2 — `StatusBar` is the one genuinely shared part (confirmed: `app_config.tsx` adopts it).** `app.tsx` and `app_config.tsx` both hand-roll `inf … | …` headers today. `StatusBar` takes a left identity segment, an **optional** middle region, and right affordance hints, importing only `theme`. The middle region is parameterized: the chat passes the live session state (`ready`/`thinking`/`error`); the config screen passes its unsaved-changes indicator (and nothing when clean). Two real callers — it is not a speculative extraction.

**D3 — Fixed-gutter `MessageBlock`.** A fixed 2-space gutter column with a swappable marker is the contract that lets every future block type (the "key moments") align identically. Now it renders `>` (you, `theme().user`) and `<` (assistant, `theme().assistant`) + role label + markdown body. The wireframe's meta footer (model · duration · tokens) is **omitted**, not faked — none of that data is tracked. The remaining markers (◆ ▸ ● ✎ ✓ ✗) and their token mapping are documented for later but not rendered.

**D4 — `Sidebar` renders all four sections; gaps are explicit placeholders.** SESSION and ANALYSIS read real data via a `createMemo` keyed on the current-analysis / current-session signals (so an in-place `openSession` swap updates the sidebar); message count reuses the live `messages` store length (reactive, no extra query per frame). CONTEXT and RUNS render literal placeholder copy (`—`, "no runs yet") so they read as "not yet", never as broken or fabricated. The sidebar is a fixed-width (~40 col), full-height column with a left divider.
- *Alternative — omit CONTEXT/RUNS until they have data:* cleaner today but the sidebar's section order/shape would churn when they land. The user chose the stable four-section shell.

**D5 — Central keymap `src/tui/keymap.ts`.** A static table mapping each logical action (chat: `openPalette`, `toggleSidebar`, `abort`, `newline`, `submit`; config: `save`, `exit`, `moveSelection`) to `{ chord, label }`, where `label` is **platform-neutral, always-lowercase** text (`ctrl+k`/`ctrl+b`/`ctrl+c`) — identical on every OS. It is a pure module (no `process.platform`, no opentui imports), and `matchChord` accepts Alt/Option from either the parsed key's `option` or `meta` flag. Because `app_config.tsx` shares `StatusBar` (D2), the keymap covers the config screen's keys too, so it is the single source for every keybind hint in the TUI; the scattered hardcoded strings are deleted.
- *Alternative — `@opentui/keymap` or a fuzzy/keybind dependency:* explicitly banned by the existing `command-palette` spec ("SHALL add no new dependencies… nor `@opentui/keymap`").
- *Alternative — inline platform checks at each hint site:* re-scatters exactly what this consolidates.

**D6 — Ctrl-only navigation, always-lowercase labels.** Terminals don't forward ⌘/Cmd (the parser maps it to `super`), and they deliver Alt/Option unreliably — on macOS the Option key composes a character (Option+s → `ß`), which is exactly why the user's `Alt+S` never fired. So navigation chords are **Ctrl** (palette `ctrl+k`, sidebar `ctrl+b`, abort `ctrl+c`), and every keybind hint label is **lowercase** (a fixed project rule). The matcher still accepts Alt for the one binding that opts in (the textarea newline).

**D7 — Sidebar toggle state + gating.** A `sidebarOpen` signal (default `true`) lives in `app.tsx`. `ctrl+b` toggles it inside `useKeyboard`, after the `dialogOpen()` early-return (so it is gated under a modal) and with `preventDefault()` so the focused textarea doesn't also consume the key — the same pattern the palette's `ctrl+k` uses. `<Show when={sidebarOpen()}>` mounts the sidebar.

**D8 — Chat status in a shared store.** The chat status (`idle`/`busy`/`error`) moves out of `app.tsx`'s private signal into a reactive store `src/tui/hooks/status.ts` (signal accessor + setter — the `theme.ts` pattern). `app.tsx` only READS it to render; the bus handler and the session swap mutate it through the setter, so setting is indirect and the holder is decoupled from the renderer. Each state renders with a leading glyph (`● ready` / `◐ thinking…` / `✗ error`) — a special character, no library.
- *Alternative — an animated spinner for busy:* deferred; a static glyph satisfies "ready has a thingy" without a timer.

**D9 — Full-height sidebar, fixed width, no drag.** Per the user and the opencode layout, the sidebar is a fixed-width (~40 col) column that spans the full height of the main row — beside BOTH the stream and the input — so showing it shrinks the chat column (stream + input together) horizontally. The top-level tree is `column[ StatusBar, row[ column[stream, banners, InputBar], Show(Sidebar) ] ]`. An earlier mouse-drag resize was removed (the user disliked it), so the chat render no longer enables `useMouse`.
- *Alternative — keep the drag resize:* removed at the user's request; a fixed width matches opencode and avoids the mouse-capture trade-off (terminal text-selection needing a modifier).

**D10 — Header vs footer split (no duplicated keys).** Global key hints (`ctrl+k` · `ctrl+b` · `ctrl+c`) live ONLY in the status bar. The input footer instead shows hardcoded session/mode info (`INSERT` … `xhigh /effort`), so the two rows never repeat the same keys. The full gutter marker set (`> < ◆ ▸ ● ✎ ✓ ✗`) is lifted into a shared `markers.ts` constant now (shared kit), even though only `>`/`<` render until the key-moment blocks land.

## Risks / Trade-offs

- **Alt/Option chords don't fire (user-reported)** → root cause: terminals deliver Alt unreliably (macOS composes Option to a character). Fixed by moving navigation to Ctrl (`ctrl+b` toggle); only the textarea newline still opts into Alt.
- **Inert CONTEXT/RUNS look broken** → explicit "not yet" placeholder copy, distinct from an empty value, so intent is legible.
- **Fixed-width sidebar crowds narrow terminals** → default-open but one keystroke (`ctrl+b`) hides it; `useTerminalDimensions()` is available in `app.tsx` if a future min-width auto-hide is wanted (out of scope here).
- **Single-caller exception sets precedent** → scope it narrowly to the layout kit and document it in `CLAUDE.md`; it is not a license to extract arbitrary single-caller helpers.
- **Refactor regressions in the chat render tree** → behavior (streaming flush, dialog overlay/keyboard gating, Ctrl+C abort, focus-on-close) must be preserved verbatim; the message/stream logic moves into `MessageBlock` unchanged, and the overlay/keyboard host stays in `app.tsx`.

## Migration Plan

Pure presentation refactor — no schema, data, or dependency changes, so no migration and no rollout staging. Rollback is a straight revert. Verification is manual: `bun run dev`, confirm the status bar shows the analysis name + live state, the full-height sidebar shows SESSION/ANALYSIS data with CONTEXT/RUNS placeholders, `ctrl+b` toggles the sidebar (and the chat column shrinks), `ctrl+k` still opens the palette, hint labels are lowercase, and `inf config` renders the shared `StatusBar`.

## Open Questions

Both prior open questions are now resolved:
- Sidebar message count: **resolved — reuse the live `messages` store length** (reactive, no per-frame query). See tasks 5.2.
- Empty-state welcome line: **resolved — preserved as-is** in the stream area after the recompose. See tasks 6.5.
