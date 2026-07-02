# scroll-pane Specification

## Purpose

The single scroll surface for the TUI: `ScrollPane` wraps opentui's scrollbox as an uncontrolled component with one canonical vim key set, focus-target-gated key ownership, and sticky-scroll re-engagement. Free-scroll hosts (chat stream, scrollable dialogs) get live keys via focus; cursor-driven hosts compose it unfocused as the plain scrollbox wrapper.

## Requirements

### Requirement: ScrollPane uncontrolled scroll surface

The system SHALL provide a `ScrollPane` component in `src/tui/components/scroll_pane.tsx` that wraps opentui's `<scrollbox>` as an **uncontrolled** scroll surface: scroll position lives in the renderable and key handling lives inside the component; hosts render children into it with zero keymap wiring. It SHALL accept `children`, a `focusOnMount` flag (default `true`), an optional `onRef` callback receiving the `ScrollBoxRenderable` (the imperative escape hatch, mirroring `TextArea.onRef`), and layout passthrough props (`stickyScroll`, `stickyStart`, padding, `flexGrow`, `width`, …). It SHALL NOT expose keymap concepts (`enabled`/`mode` gating) in its props.

#### Scenario: Drop-in usage needs no host wiring

- **WHEN** a host renders `<ScrollPane>` with taller-than-viewport children and the pane is focused
- **THEN** the canonical scroll keys work without the host declaring any binding layer

#### Scenario: Ref escape hatch

- **WHEN** a host passes `onRef`
- **THEN** it receives the `ScrollBoxRenderable`, enabling imperative calls (e.g. the chat re-engaging bottom-stick on message send)

#### Scenario: Focus on mount default

- **WHEN** `ScrollPane` mounts without `focusOnMount={false}`
- **THEN** its scrollbox receives focus (via `queueMicrotask`), making its keys live immediately

### Requirement: Canonical vim scroll key set via a focus-target-gated layer

`ScrollPane` SHALL register one internal keymap layer (`useBindings`) gated by `target:` its own scrollbox renderable — the keys are live exactly while the pane or a descendant is focused, and with multiple panes mounted, focus disambiguates which pane scrolls. The layer SHALL bind, with these exact step sizes:

| Chord | Action |
|---|---|
| `gg` (two-stroke sequence) | scroll to top (`scrollTo(0)`) |
| `G` (shift+g) | scroll to bottom (`scrollTo(scrollHeight)`) |
| `j` / `k`, down / up | ±1 line (`scrollBy(±1)`) |
| `ctrl+d` / `ctrl+u` | ±½ viewport (`scrollBy(±0.5, "viewport")`) |
| pgdn / pgup | ±1 viewport (`scrollBy(±1, "viewport")`) |
| end / home | scroll to bottom / top |

Bindings SHALL carry `desc`/`group: "Scroll"` so WhichKey documents them while live. The set SHALL be complete over every chord opentui's native focused-scrollbox handler answers (j/k/arrows, pgup/pgdn, home/end): the layer's default preventDefault shadows the native handler for bound chords, and binding the full set is what prevents any key from falling through to the native 1/5-viewport step sizes.

#### Scenario: Vim keys with canonical steps

- **WHEN** the pane is focused and the user presses `j`, then `ctrl+d`, then `G`, then `gg`
- **THEN** the viewport moves +1 line, +half a viewport, to the bottom, then to the top

#### Scenario: Native handler is fully shadowed

- **WHEN** the pane is focused and the user presses any chord the native scrollbox handler answers (e.g. down, pgup, home)
- **THEN** the movement uses the ScrollPane step sizes above, never the native 1/5-viewport step

#### Scenario: Keys are dead without focus

- **WHEN** a sibling input owns focus
- **THEN** pressing `j`/`G`/`gg` types into the input (or does nothing) and the pane does not scroll

#### Scenario: Two panes disambiguate by focus

- **WHEN** two `ScrollPane` instances are mounted and the second is focused
- **THEN** scroll keys move only the second pane

### Requirement: Bottom-scroll re-engages sticky scroll

When the underlying scrollbox has `stickyScroll` with `stickyStart="bottom"`, the `G` and end bindings SHALL scroll via `scrollTo(scrollHeight)` so opentui re-engages bottom stickiness — after `G`, the view resumes following newly appended content (the chat's follow-the-stream behavior). For non-sticky hosts this is a plain scroll-to-bottom.

#### Scenario: G resumes following the stream

- **WHEN** the user scrolled up in a sticky-bottom pane while content streams in, then presses `G`
- **THEN** the view jumps to the bottom and continues following subsequent appends without further keys

### Requirement: ScrollPane is the single scrollbox composer

`ScrollPane` SHALL be the ONLY place `<scrollbox>` is composed in the TUI. Free-scroll surfaces — the chat stream (`chat.tsx`), `ResultsDialog`, and `DesignGallery` — render through it with its keys live via focus; no hand-rolled scroll binding layers or reliance on opentui's native focused-scrollbox key handling SHALL remain at those hosts. Cursor-driven hosts (the `FixedList`/`DynamicList` primitives, the config screen's section navigation), where keys move a selection cursor and `scrollChildIntoView` follows, SHALL compose `ScrollPane` too — with `focusOnMount={false}` and nothing ever focusing the pane, so the internal key layer never engages and cursor semantics are untouched; they reach `scrollChildIntoView` through `onRef`. The behavioral test coverage for scrolling SHALL live at the component (`ScrollPane` driven via the headless `testRender` harness), not per-host.

#### Scenario: No raw scrollbox outside the component

- **WHEN** the codebase is searched for `<scrollbox` JSX outside `scroll_pane.tsx`
- **THEN** none exist — every host composes `ScrollPane`

#### Scenario: Hosts have no scroll bindings

- **WHEN** the codebase is searched for scroll chord declarations (`scrollBy`/`scrollTo` bindings) outside `scroll_pane.tsx`
- **THEN** none exist at chat/dialog/gallery hosts; only ScrollPane declares them

#### Scenario: Cursor-driven hosts compose it without key ownership

- **WHEN** `FixedList`/`DynamicList` or the config screen renders its rows through `ScrollPane`
- **THEN** the pane is never focused, its scroll keys never fire, and `scrollChildIntoView`-based cursor following works unchanged via the `onRef` renderable

#### Scenario: Component-level test coverage

- **WHEN** the scroll key behavior is tested
- **THEN** a `ScrollPane` render test (headless harness, `mockInput.pressKeys`) asserts the canonical steps, focus gating, and sticky re-engagement — replacing the inline binding declarations of the former `keymap_scroll.render.test.tsx`
