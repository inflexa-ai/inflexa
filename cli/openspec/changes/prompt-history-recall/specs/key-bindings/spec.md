## ADDED Requirements

### Requirement: Up/down in the composer recall previously sent prompts

The composer SHALL carry a textarea-targeted layer binding `up` and `down` to prompt-history
recall, so a previously sent message can be brought back for re-sending or editing without
retyping it. The chords SHALL be the structural `KEYS.up`/`KEYS.down` and SHALL NOT be added to
`KEYBIND_DEFAULTS` — like the retract binding they share `up` with, they are conventional and carry
no config surface. Recall is composer-only: the stream pane's `up`/`down` remain scroll keys in
every state.

**Entries.** The history SHALL be the current session's own sent user messages as held by the
conversation store, ordered newest first, with runs of identical consecutive texts collapsed to a
single entry (re-sending the same prompt after a failed turn SHALL cost one recall step, not two).
Only *consecutive* duplicates collapse: identical texts separated by other prompts SHALL remain
distinct entries, and a step SHALL proceed from the entry the user is currently on — never from the
newest entry that happens to share its text. Deriving from the store rather than from a record of what was typed is what makes the exclusions
structural rather than a maintained filter list: docked-ask answers and the `/quit` aliases never
become user messages, so they can never appear; and a retracted prompt is spliced out of the store,
so it leaves no entry behind. History SHALL reach only as far as the store's mounted window — older
turns remain in the thread but are not mounted, and recall SHALL stop at that edge rather than
paging.

**Precedence and gate.** The layer SHALL be enabled whenever the retract window does not hold, so
retract keeps `up` for its window and recall takes over the moment the window closes — including
while a turn is still busy, once output has arrived. Recall SHALL seed the buffer only: it never
submits, and the submit path's existing busy and boot gates are unchanged.

**Entering recall.** From an empty buffer, `up` SHALL seed the newest entry. Entry from an empty
buffer SHALL always resume at the newest entry, so a position left behind by an earlier, abandoned
recall can never resurface.

**Staying in recall.** The layer SHALL remain live while the buffer still equals the entry it
seeded, and SHALL go inert as soon as the buffer differs from it — at which point `up`/`down` are
ordinary cursor movement again. Without this the feature would be unusable at one step deep: the
seed itself makes the buffer non-empty, and a bare empty-buffer gate would hand the next `up` to
cursor movement. The condition SHALL be derived from the live buffer on each keystroke, in the same
way the retract layer re-reads it — never tracked through edit events or a flag that would need
clearing.

**Stepping.** `up` SHALL move toward older entries and SHALL stay at the oldest when there are no
older ones. `down` SHALL move toward newer entries; `down` from the newest entry SHALL clear the
buffer and leave recall, restoring the empty composer the user entered from. `down` while not in
recall SHALL fall through to cursor movement.

**Seeding.** A recalled entry SHALL be placed in the buffer with the cursor at the end, the same
completion the retract seed uses, so a multi-line prompt lands ready to append to.

#### Scenario: Up in an empty composer recalls the newest prompt

- **WHEN** the composer is focused and empty, the retract window does not hold, and the user presses up
- **THEN** the buffer holds the most recently sent prompt with the cursor at the end

#### Scenario: Up again steps to the next-older prompt

- **GIVEN** the composer holds a recalled entry, unedited
- **WHEN** the user presses up
- **THEN** the buffer holds the next-older prompt and no cursor movement occurs

#### Scenario: Editing a recalled prompt leaves recall

- **GIVEN** the composer holds a recalled entry
- **WHEN** the user edits the text and then presses up
- **THEN** the cursor moves within the buffer and no recall step occurs

#### Scenario: Down from the newest entry restores the empty composer

- **GIVEN** the composer holds the newest entry, reached by one up from an empty buffer
- **WHEN** the user presses down
- **THEN** the buffer is empty and a further down moves the cursor rather than recalling

#### Scenario: Up at the oldest entry stays put

- **GIVEN** the composer holds the oldest available entry, unedited
- **WHEN** the user presses up
- **THEN** the buffer is unchanged

#### Scenario: Entering recall again resumes at the newest

- **GIVEN** the user recalled several entries back, then cleared the composer
- **WHEN** the user presses up on the now-empty buffer
- **THEN** the buffer holds the most recently sent prompt, not the one the abandoned recall stopped at

#### Scenario: Retract outranks recall during its window

- **WHEN** a turn is busy with no output, the composer is focused and empty, and the user presses up
- **THEN** the retract runs and no recall occurs

#### Scenario: Recall is live once the retract window closes mid-turn

- **WHEN** a turn is busy, its first output has arrived, and the user presses up on the focused empty composer
- **THEN** the newest prompt is recalled into the buffer and no turn is submitted

#### Scenario: Consecutive duplicates collapse to one entry

- **GIVEN** the same prompt text was sent twice in a row
- **WHEN** the user recalls back past it
- **THEN** one up reaches it and the next up reaches the prompt sent before the pair

#### Scenario: Repeated non-adjacent prompts each keep their place

- **GIVEN** a prompt was sent, then a different prompt, then the first text again
- **WHEN** the user recalls back to the older occurrence of the repeated text and presses up
- **THEN** the buffer holds the prompt sent immediately before that older occurrence, not the one before the newer occurrence

#### Scenario: Ask answers and quit aliases never enter history

- **GIVEN** the user answered a docked ask from the composer and submitted a `/quit` alias during the session
- **WHEN** the user recalls through the history
- **THEN** neither the answer token nor the alias appears among the entries

#### Scenario: A retracted prompt leaves no entry

- **GIVEN** a sent message was retracted back into the composer
- **WHEN** the user clears the composer and recalls
- **THEN** the retracted text is not an entry, and recall reaches the prompt sent before it

#### Scenario: History reaches only the mounted window

- **WHEN** the user presses up repeatedly from an empty composer in a session with more turns than the store mounts
- **THEN** recall stops at the oldest mounted prompt and no paging occurs

#### Scenario: An empty history leaves the composer alone

- **WHEN** the composer is focused and empty in a session with no sent prompts and the user presses up
- **THEN** nothing happens

#### Scenario: The pane keeps its scroll keys

- **WHEN** the stream pane holds focus outside the retract window and the user presses up or down
- **THEN** the stream scrolls and no recall occurs

## MODIFIED Requirements

### Requirement: Up-arrow in an empty composer retracts the just-sent message

The retract SHALL bind `up` from BOTH resting states of a fresh send: a pane-targeted layer live
while the stream pane is focused, and a textarea-targeted layer live while the composer is focused
with an empty buffer — each enabled only while the retract window holds (turn busy, nothing produced —
the conversation hook's gate). The pane layer SHALL outrank the pane's scroll layer, so during the
window `up` retracts instead of scrolling; the moment the gate closes (first output, turn end) the
binding disables and `up` reverts to scroll-up — `k` and the page keys scroll throughout. Outside the
window the textarea binding falls through to prompt-history recall, which is gated on the retract
window NOT holding and so claims the composer's `up` exactly when the retract releases it. A
completed retract SHALL seed the composer with the original text and focus it (INSERT, cursor at
end), so send-to-editing is two keys from the post-submit resting state; recall reuses that same
seed completion.

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

- **WHEN** the retract window holds, the composer holds text, and the user presses up
- **THEN** the cursor moves within the buffer and no retract occurs

#### Scenario: Idle up-arrow recalls instead of retracting

- **WHEN** no turn is in flight and the composer is empty and the user presses up
- **THEN** no retract occurs and the press is governed by prompt-history recall
