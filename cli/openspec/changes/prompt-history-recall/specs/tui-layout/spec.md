## ADDED Requirements

### Requirement: The empty-buffer placeholder advertises prompt-history recall

A chord that does something but is announced nowhere is a chord nobody finds. `ChatBar` SHALL take a
`canRecall` boolean prop — derived by the host from the live history and retract window and handed
down as data, keeping the component's no-domain-imports rule — and, when it is true and no boot gate
applies, SHALL append a recall affordance to the empty-buffer placeholder naming the chord
(`RECALL_LABEL`, derived from the bound chord in `keymap.ts`, never hand-written here).

The placeholder is the only honest home for this hint, and it is chosen over a footer entry for
reasons that are not merely aesthetic: it renders exactly when the buffer is empty, which is exactly
when a recall can be entered; it disappears the moment the user types, so it cannot become permanent
furniture; it costs no additional rows on a composer whose footer already carries the mode word, the
interrupt affordance, and the newline hint; and it is absent in a session with nothing to recall
rather than advertising a key that would do nothing.

`canRecall` SHALL be false whenever the retract window owns the chord instead, mirroring the
interrupt hint's honesty gates. A boot gate (`booting` / `failed`) SHALL outrank the affordance
entirely — that placeholder explains why typing goes nowhere, and a recall hint layered on top would
advertise a chord whose result could not be sent.

#### Scenario: Something to recall names the chord

- **WHEN** the composer is empty, ungated, and the host reports a recallable history
- **THEN** the placeholder reads `Type a message…` followed by the recall affordance naming the bound chord

#### Scenario: Nothing to recall keeps the placeholder bare

- **WHEN** the composer is empty and the host reports no recallable history (a first-run session, or the retract owning the chord)
- **THEN** the placeholder is the plain `Type a message…` with no recall affordance

#### Scenario: A boot gate outranks the affordance

- **WHEN** the runtime is still booting and the host reports a recallable history
- **THEN** the placeholder shows only the booting explanation, with no recall affordance
