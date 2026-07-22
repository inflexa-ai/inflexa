## MODIFIED Requirements

### Requirement: Up-arrow in an empty composer retracts the just-sent message

The retract SHALL bind `up` from BOTH resting states of a fresh send: a pane-targeted layer live
while the stream pane is focused, and a textarea-targeted layer live while the composer is focused
with an empty buffer — each enabled only while the retract window holds (turn busy, nothing produced —
the conversation hook's gate). The pane layer SHALL outrank the pane's scroll layer, so during the
window `up` retracts instead of scrolling; the moment the gate closes (first output, turn end) the
binding disables and `up` reverts to scroll-up — `k` and the page keys scroll throughout. Outside the
window the textarea binding falls through to normal cursor movement, and the chord remains free for a
future prompt-history recall when idle. A completed retract SHALL seed the composer with the original
text and focus it (INSERT, cursor at end), so send-to-editing is two keys from the post-submit
resting state.

#### Scenario: Up-arrow on the pane retracts and lands in INSERT

- **WHEN** a turn is busy with no output, the pane holds focus (the post-submit state), and the user presses up
- **THEN** the retract runs and, on completion, the composer holds the original text with focus and the cursor at the end

#### Scenario: Up-arrow in the empty composer still retracts

- **WHEN** a turn is busy with no output, the composer is focused and empty, and the user presses up
- **THEN** the retract runs exactly as from the pane

#### Scenario: Scroll keys keep working during the window

- **WHEN** the retract window holds and the user presses `k` (or a page key) on the focused pane
- **THEN** the stream scrolls; only `up` is claimed by the retract

#### Scenario: Up reverts to scroll when the window closes

- **WHEN** the first output has arrived and the user presses up on the focused pane
- **THEN** the stream scrolls up and no retract occurs

#### Scenario: A non-empty buffer keeps cursor movement

- **WHEN** the composer holds text and the user presses up
- **THEN** the cursor moves within the buffer and no retract occurs

#### Scenario: Idle up-arrow does nothing

- **WHEN** no turn is in flight and the composer is empty and the user presses up
- **THEN** nothing happens (reserved for future history recall)
