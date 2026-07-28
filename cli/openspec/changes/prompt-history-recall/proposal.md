## Why

The chat composer has no way to get a previously sent prompt back. Re-running a
near-identical analysis request, or recovering the wording of a message after a
failed turn, means retyping it from scratch — and the transcript scrolled off
above is read-only.

The chord for this was reserved when the retract binding landed: `key-bindings`
pins "**Scenario: Idle up-arrow does nothing** — nothing happens (reserved for
future history recall)", and `src/tui/app.tsx` carries the matching note. This
change cashes that reservation in. Resolves #242.

## What Changes

- **Up-arrow in the composer recalls the previous sent prompt**, down-arrow walks
  back toward the newest, and down past the newest restores the empty buffer.
  Composer-only: the stream pane's `up`/`down` stay scroll keys.
- **The entries are the session's own sent user messages**, newest first, read
  from the conversation store — no new table, no new query, no new persistence.
  Consecutive duplicates collapse to one entry (a re-sent prompt after a failed
  turn is one recall step, not two).
- **The gate is `!canRetract()`, not idle-only.** The retract window is the one
  claimant of `up` that outranks recall; the moment it closes (first output
  arrives) recall takes over, even while the turn is still busy — so the next
  message can be recalled and edited while the agent works. Submits stay gated by
  the existing busy check; only the buffer is seeded.
- **Recall survives its own seed.** Stepping past the first entry would otherwise
  be impossible: once seeded, the buffer is non-empty and `up` reverts to cursor
  movement. The layer stays live while the buffer still equals the recalled
  entry, and goes inert the moment the user edits it — a derived condition
  re-read on each keystroke, matching how `retractLayer` re-reads the live
  buffer. No edit subscription, no flag to clear.
- **A recalled prompt stays navigable.** The composer is multi-line, so a chord steps history only
  from the buffer edge it moves away from — `up` from the first row, `down` from the last, caret
  movement everywhere in between (the readline rule). Without it a recalled multi-line prompt would
  hold both arrows for as long as it sat in the buffer, leaving every row but the last unreachable.
- **The chord is advertised where advertising it is honest**: appended to the EMPTY-buffer
  placeholder, which renders exactly when a recall can be entered and vanishes as soon as the user
  types. No extra rows, nothing to find in a session with no history, and no claim while the retract
  or a boot gate owns the chord.
- **BREAKING (spec-level only, no user-visible regression)**: the pinned
  "Idle up-arrow does nothing" scenario is replaced, and the retract
  requirement's "the chord remains free for a future prompt-history recall when
  idle" prose stops being true. Both are corrected in the delta.

Out of scope: fuzzy history search (a `ctrl+r`-style picker over the same
entries), cross-session or cross-analysis recall, recall from the stream pane,
and stashing a half-typed draft on entering recall (entry is from an empty
buffer, so there is none). Each is additive on top of this and none is needed to
close #242.

## Capabilities

### New Capabilities

None. The behavior is an app-level key layer plus a derived store reader — the
same shape as the existing retract binding, which lives in `key-bindings`.

### Modified Capabilities

- `key-bindings`: add a requirement for composer prompt-history recall (the
  `up`/`down` bindings, the entry source and its ordering/dedup/window rules, the
  retract precedence, and the edit-exits-recall condition); amend the existing
  "Up-arrow in an empty composer retracts the just-sent message" requirement,
  whose prose reserves the idle chord and whose "Idle up-arrow does nothing"
  scenario this change replaces.
- `tui-layout`: add a requirement for the composer's `canRecall` prop and the
  recall affordance it appends to the empty-buffer placeholder, including the
  honesty gates (absent with no history, while the retract owns the chord, or
  behind a boot gate) and the derived-label rule the existing footer hints follow.

## Impact

- **Code**:
  - `cli/src/tui/hooks/conversation.ts` — a derived `promptHistory()` reader over
    the existing `messages` store (user-role texts, newest first,
    consecutive-deduped), alongside the existing derived readers
    (`sessionOpenables`, `latestPlanCard`).
  - `cli/src/tui/app.tsx` — a `historyRecallLayer` pure factory registered via
    `useBindings`, sitting beside `retractLayer`/`paneRetractLayer` and reusing
    their `seedComposerFromRetract` completion (set text, cursor to end). Stays
    in `app.tsx` per the single-caller rule.
- **Tests**: a dispatch/render test driving the same exported factory `App`
  installs (the `keymap_interrupt_retract.render.test.tsx` pattern), plus unit
  coverage of `promptHistory()` ordering and dedup.
- **Reused unchanged**: the `messages` store and its `MESSAGE_CAP` window, the
  keymap engine's layer priority and lazy-thunk re-evaluation, and
  `seedComposerFromRetract`.
- **No** new dependencies, storage schema, migration, or config surface. The
  chords are structural (`KEYS.up`/`KEYS.down`), so they are deliberately not
  added to `KEYBIND_DEFAULTS`.
- **Known limit, stated not discovered**: history reaches only as far as the
  mounted window (`MESSAGE_CAP = 200` messages). Older turns live in the thread
  but are not mounted, so recall bottoms out there.
- **Free by construction, worth recording**: `pushUserMessage` is called only
  from `send`, so docked-ask answers (`y`/`a`/`n`) and the `/quit` aliases never
  become user messages and can never enter history; and retract splices its
  message out of the store, so a retracted prompt leaves no entry behind.
