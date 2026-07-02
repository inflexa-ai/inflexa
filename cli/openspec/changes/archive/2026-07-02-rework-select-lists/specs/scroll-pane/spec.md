# scroll-pane — delta

## MODIFIED Requirements

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
