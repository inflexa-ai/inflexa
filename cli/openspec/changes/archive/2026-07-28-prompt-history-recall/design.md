## Context

The composer's `up` chord has been reserved for prompt-history recall since the retract binding
landed — `key-bindings` pins an "Idle up-arrow does nothing (reserved for future history recall)"
scenario, and `src/tui/app.tsx` carries the matching note. This change implements that reservation.

The surrounding machinery already fits the shape of the feature, which is why the change is small:

- **The keymap engine re-invokes each layer's config thunk on every keystroke** (`keymap.ts`,
  `activeLayers`), so a layer's `enabled` may read live, untracked state — the retract layer already
  reads `target?.plainText === ""` this way. Recall needs exactly that: a gate that depends on the
  current buffer contents.
- **The transcript is already in memory.** `conversation.messages` is an exported Solid store of the
  session's `UIMessage[]`, loaded from the durable thread on session open and capped at
  `MESSAGE_CAP = 200`. Two derived readers (`sessionOpenables`, `latestPlanCard`) already walk it
  newest-first with plain loops.
- **Two pure layer factories** (`retractLayer`, `paneRetractLayer`) establish the pattern: export the
  factory, let `App` register it via `useBindings`, and let tests drive the same config the app
  installs rather than a hand-copied replica.

The single genuinely new problem is that recall, unlike retract, is a *stateful sequence*: the
binding must fire repeatedly and each press depends on where the previous one left off.

## Goals / Non-Goals

**Goals:**

- Shell-style `up`/`down` recall in the composer, entered from an empty buffer, exiting cleanly when
  the user edits or steps past the newest entry.
- No new persistence, query, migration, dependency, or config surface.
- Keep the retract binding's behavior byte-identical inside its window.
- Make the recall position impossible to leave in a wrong state, without lifecycle wiring (no
  effects, no session-switch reset hook, no edit-event subscription).

**Non-Goals:**

- Fuzzy history search over the same entries (a `ctrl+r`-style picker). Additive later; the entry
  reader designed here is the surface it would consume.
- Cross-session or cross-analysis recall, and paging past the mounted window.
- Recall from the stream pane, and stashing a half-typed draft on entry (there is none — entry is
  from an empty buffer).
- A FOOTER hint for the chord. The affordance goes in the placeholder instead (decision 10).

## Decisions

### 1. The recall position is stored state, not derived by searching the buffer

The gate that keeps recall alive across presses is derived (see decision 2), which raises the
question of whether the *position* can be derived too — look the buffer up in the entry list on each
press and step from whatever index it matches, holding no state at all.

**It cannot, and the reason is the dedup rule.** Dedup collapses only *consecutive* duplicates, so a
prompt sent, then something else, then sent again yields two separate entries with identical text.
An `indexOf`-style lookup resolves to the newest occurrence, so pressing `up` while sitting on the
*older* one would jump the user back to just-before-the-newest — silently skipping every entry in
between. The bug would be invisible in any test whose fixture lacks a repeated non-adjacent prompt.

So the factory closes over a `createSignal<number | null>` position: `null` means "not in recall",
and an index addresses `entries()[index]` directly. The buffer-equality check is used *only* as the
enabled gate, comparing against that one addressed entry — never as a search.

**Alternative considered:** collapse *all* duplicates, not just consecutive ones, which would make
the entry list unique and the lookup sound. Rejected — it reorders history (a re-sent old prompt
would jump to the front, or the older occurrence would vanish), which is a bigger behavioral
surprise than the state it saves, and shells do not do it by default.

### 2. Exit-from-recall is a derived condition, never an edit subscription

The layer's `enabled` is:

```
!canRetract() && (buffer === "" || buffer === entries()[index()])
```

re-evaluated per keystroke by the engine. Editing a recalled entry makes the equality fail, the
layer goes inert, and `up`/`down` revert to cursor movement — with no keypress handler, no `onInput`
subscription, and no flag anyone has to remember to clear.

This matters more than it looks: the alternative (an `inRecall` boolean flipped by an edit event)
has to be cleared correctly on submit, on `ctrl+u` clear-input, on session switch, on dialog
open/close, and on retract seeding the composer. Every one of those is a place to forget. The
derived form has no such surface — it is a function of the buffer, so it is right in all of them by
construction.

### 3. A stale position is made harmless rather than reset

Entering recall from an empty buffer always resets the position to the newest entry, regardless of
what it held before. That single rule discharges every reset that would otherwise need wiring:

| Situation | Why no reset hook is needed |
|-|-|
| Session switched mid-recall | New entries ≠ the buffer → layer inert. Clearing the buffer re-enters at the new session's newest. |
| Message submitted | Submit clears the buffer; next `up` re-enters from empty. |
| `ctrl+u` clear-input | Same — buffer empty, re-enter at newest. |
| Retract seeded the composer | Seeded text ≠ `entries()[index]` → inert, as it should be. |
| Recall abandoned by editing | Buffer differs → inert; position is never read again until a re-entry resets it. |

The position signal is therefore write-mostly: it is only ever *read* while the equality gate has
already confirmed the buffer still matches it.

### 4. `promptHistory()` lives in `conversation.ts` as a plain derived reader

It walks `messages` newest-first, keeps `role === "user"`, joins each message's `text` parts in
order (non-text parts ignored — a user message carries one text part today via `pushUserMessage`,
but `cortexToUiMessage` can produce several from a replayed thread), drops empty results, and
collapses runs of identical adjacent texts. Returns `string[]`, newest first.

Placing it beside `sessionOpenables`/`latestPlanCard` keeps `app.tsx` from reaching into `Part`
shapes, and keeps the store's exclusions where the store is. **No `createMemo`:** module-scope
singletons in Solid would need a `createRoot` owner, the two existing readers set the no-memo
precedent, and the cost is a ≤200-element filter per keystroke — well under any budget that matters.
It reads the store inside a tracking scope when called from one, so a caller that wants reactivity
gets it.

### 5. Mutual exclusion with retract by gate, not by priority

Both layers target the composer and both bind `up`. Exploration considered ordering them with layer
priority (as `paneRetractLayer` does against the pane's scroll layer). Instead, recall's `enabled`
carries `!canRetract()` — the exact negation of retract's own gate — so the two are mutually
exclusive by construction and *cannot* both match, whatever the registration order.

That is stronger than priority, which only decides who wins when both are live. It also reads as the
intent (`recall is what the composer's up means when a retract is not on offer`) rather than as a
tuning parameter, and it matches the codebase's preference for explicit gates.

### 6. The binding list is rebuilt per keystroke, so a chord is bound only when it will act

`up` and `down` sit in one layer, but `enabled` cannot separate them: the layer must be live on an
empty buffer so `up` can *enter* recall, and that is exactly the state where `down` has nowhere to
go. The engine `preventDefault`s whatever it matches, so binding `down` there would swallow a
keystroke to run a no-op — a key stolen from the editor underneath.

The layer's `bindings` array is rebuilt on every keystroke along with the rest of its config, so it
is not a fixed list: `down` is pushed only while a recall is in progress, and `up` only when the
index it would land on actually has an entry (an empty history therefore leaves `up` to the editor
rather than eating it). Both chords fall through untouched whenever the layer has nothing to do with
them.

**Alternative considered:** bind both unconditionally and guard inside `run`, with
`preventDefault: inRecall` to release the key. Rejected — a matched binding still returns `handled`
and stops dispatch regardless of `preventDefault`, so lower-priority layers would be shadowed by a
binding that did nothing. Not binding is the only way to genuinely fall through.

### 7. Seeding reuses `seedComposerFromRetract`'s completion

Recalled text lands via `setText` + `gotoBufferEnd`, the same completion the retract seed uses, so a
multi-line prompt arrives ready to append to. Recall does *not* reuse the seed's `focus()` call or
its empty-buffer re-check — the composer already holds focus by the time recall can fire (the layer
is focus-`target`-gated to it), and the emptiness check is the retract path's protection against a
draft typed during the async retract window, which recall has no analogue of. If the shared shape is
awkward, factoring the two-line set-and-move-cursor tail out of `seedComposerFromRetract` is
preferable to calling it and then undoing the focus.

### 8. Recall stays live while an ask is docked

While a docked ask is awaiting an answer the composer doubles as an answer path, and a recalled
prompt submitted there is intercepted by `askSubmitAction` and refused with a notice — the same as
any other non-`y`/`a`/`n` text. Gating recall off in that state was considered and rejected: it
would add a condition to defend an outcome the submit path already handles correctly, and preparing
the next message while an approval is pending is a legitimate thing to want.

### 9. Multi-line prompts keep their caret keys — history steps only from the buffer edge

The equality gate keeps recall live for as long as the entry sits unedited in the buffer. Applied to
both chords unconditionally, that makes a recalled **multi-line** prompt un-navigable: `up` and
`down` step history from every row, so the caret can never reach line one to fix a typo there. The
user's only escape is to type a junk character (breaking equality), navigate, and delete it. On a
composer sized `minHeight={3} maxHeight={8}` — built for multi-line input — that is not an edge case.

The fix is the readline/shell rule every terminal user already has in their fingers: a chord steps
history only from the buffer EDGE it moves away from. `up` recalls from the first row; `down` recalls
from the last; on every row in between neither is bound, so both fall through to the textarea's own
caret movement. A single-line entry is the first and last row simultaneously, so the common case
still recalls in one press per direction and pays nothing for the rule.

Row position comes from `editBuffer.getCursorPosition().row` against `editBuffer.getLineCount()` —
logical rows, **not** wrapped display lines. A soft-wrapped long prompt is one row however narrow the
terminal, because a chord that recalled at 120 columns and moved the caret at 60 would be
indefensible.

Consequence worth naming: stepping back through several multi-line entries now costs one keystroke
per row of each entry traversed, since each seed lands the caret at the end. That is exactly how bash
and zsh behave, and the alternative — seeding the caret at the top when travelling backwards —
inverts the problem onto `down`.

**The hold at history-top must be a true no-op.** `up` at the oldest entry clamps back to the entry
already showing, and a step that resolves to where it already is must touch NOTHING — not the buffer,
and not the caret. Re-seeding identical text reads as free but ends in `gotoBufferEnd`, and on a
multi-line entry that yanks the caret from wherever the user put it to the end. The damage lands
precisely where the edge rule is most useful: it exists to let a user reach row 0 of a recalled entry
to fix its first line, and at the oldest entry one more `up` — pressed out of habit, or without
knowing this is the oldest — would undo that positioning. readline holds both at history-top; so does
this. The check is gated on the recall being live, so a stale position (one an edit abandoned, kept
deliberately per decision 3) can never suppress a fresh entry that happens to address the same place.

Note this is invisible for single-line entries, where the caret's "end" and its row-0 position
coincide — which is why it needs a multi-line test of its own rather than riding on the existing
oldest-entry coverage.

### 10. The chord is advertised in the empty-buffer placeholder, not the footer

A reserved chord that now does something, announced nowhere, is a feature most users never find. The
ChatBar footer is the obvious home and the wrong one: it already carries the mode word, the
mode-scoped interrupt affordance, and the newline hint, and a fourth permanent item would crowd a row
whose value is that it is scannable mid-turn.

The placeholder is strictly better suited, because its visibility conditions already match the
feature's: it renders only when the buffer is empty — exactly when a recall can be entered — and it
disappears the instant the user types, so the hint cannot become furniture. `ChatBar` takes a
`canRecall` boolean (host-derived, keeping its no-domain-imports rule) and appends the affordance,
labelled from `RECALL_LABEL` in `keymap.ts` so the advertised key is derived from the bound chord
rather than hand-written.

Two honesty gates, mirroring the interrupt hint's: `canRecall` is false while the retract owns the
chord, and a boot gate outranks the affordance entirely (that placeholder explains why typing goes
nowhere; a recall hint on top would advertise a chord whose result could not be sent).

### 11. The entry list leaves the keystroke path entirely; the position carries its own text

`activeLayers` re-invokes **every** registered layer's config thunk on each keystroke *before* it
filters by `enabled`/`mode`/`target`:

```js
return [...layers.values()].map((get) => get()).filter((c) => ...)
```

So anything the factory reads is read on every key pressed anywhere in the app — inside a dialog or
the command palette included, where this layer can never fire. An unguarded `deps.entries()` therefore
walks the whole mounted transcript per keystroke.

A first attempt guarded that read with `buffer === "" || index !== null`. **That guard does not hold**,
and the reason is decision 3: a position deliberately *outlives* its recall. Nothing clears it on an
edit, a submit, a clear-input, or a session swap — it is simply overwritten at the next entry, which is
what buys the design its freedom from lifecycle wiring. So the very first recall-then-edit leaves
`index` non-null for the rest of the session, and `index !== null` is true forever after: the walk is
back on every keystroke, permanently. The two decisions are individually sound and jointly wrong, which
is exactly the kind of interaction a guard expressed in terms of the wrong variable hides.

The fix removes the need for the list at config time rather than guarding the read. The position now
carries **the text it seeded** alongside its index (`RecallPosition = { index, text }`), so the
liveness check is an O(1) comparison against that text instead of a lookup into `entries()`. The list
is built only inside a binding's `run` — a press that actually steps history — and the one question
left at config time ("is there anything at all to recall?", needed so an empty history leaves `up`
unbound and falling through) is answered by a separate `hasPromptHistory()` that returns at the first
qualifying turn instead of building the list.

Index and text travel in one value because they must never disagree: separately-updated signals could
address one entry while holding another's text, which is the confusion the stored-index rule of
decision 1 exists to prevent. The index is still what *steps* — entry texts are non-unique, so only a
position can walk the list correctly — and the text is only what *gates*.

A call-count test pins the property, since nothing else would catch its regression: after a recall is
abandoned by editing, further keystrokes must not build the list again.

## Risks / Trade-offs

- **History is silently bounded by `MESSAGE_CAP`.** A user in a long session cannot recall past the
  mounted window, and nothing tells them why recall stopped → Pinned as a spec scenario rather than
  left to be discovered, so the ceiling is a documented behavior. Paging is a follow-up if anyone
  actually hits it; the reader would grow a source that pages the thread, and no other decision here
  changes.
- **Non-consecutive duplicates make the entry list non-unique.** Any future code that treats an entry
  text as an identity (a fuzzy picker keying on text, say) inherits the same trap decision 1 avoids
  → the position-not-search rule is written into the spec's requirement text, not just here.
- **The equality gate makes recall exit on *any* buffer difference**, including a change the user did
  not intend (a stray keystroke). The cost is one `up` to re-enter and re-step, and the alternative
  is stateful edit-tracking with a much larger correctness surface → accepted deliberately.
- **`preventDefault` on `down` in an empty buffer** technically suppresses a cursor move. Zero-length
  buffer, so unobservable → accepted; noted so a future reader does not mistake it for a bug.

## Migration Plan

Not applicable — additive behavior on a chord that is currently a documented no-op, with no storage,
config, or API surface. Reverting is removing one layer registration and one reader.

## Open Questions

None blocking. Two deferred by choice, both recorded above: paging history past the mounted window
(risk 1), and whether the fuzzy-search picker consumes `promptHistory()` unchanged when it lands.
