## 1. The entry reader

- [x] 1.1 Add `promptHistory(): string[]` to `src/tui/hooks/conversation.ts`, beside the existing derived readers (`sessionOpenables`, `latestPlanCard`) and following their plain newest-first loop style — no `createMemo` (design decision 4).
- [x] 1.2 Within it: keep `role === "user"` messages, join each message's `text` parts in order (ignore non-text parts), drop entries that come out empty, and collapse runs of identical *adjacent* texts to one. Non-adjacent identical texts MUST remain distinct entries.
- [x] 1.3 Unit-test `promptHistory()` in `src/tui/hooks/conversation.test.ts`: newest-first ordering; assistant messages excluded; multi-text-part user message joined; consecutive duplicates collapsed; non-adjacent duplicates preserved as two entries; empty store returns `[]`.

## 2. The recall key layer

- [x] 2.1 Add an exported `historyRecallLayer(deps)` pure factory to `src/tui/app.tsx`, beside `retractLayer`/`paneRetractLayer` and following the same exported-factory convention so tests drive the config `App` installs. Keep it in `app.tsx` per the single-caller rule.
- [x] 2.2 Give it a `createSignal<number | null>` recall position owned by the factory's caller (`App`), `null` meaning "not in recall" — a stored index, never an `indexOf` search over the entries (design decision 1; the non-adjacent-duplicate trap).
- [x] 2.3 Gate it: `mode: MODE_BASE`, `target` the composer, `enabled: !conversation.canRetract() && (buffer === "" || buffer === entries()[index()])`. The `!canRetract()` term makes it mutually exclusive with `retractLayer` by construction — do not resolve the overlap with layer priority (design decision 5).
- [x] 2.4 Bind `KEYS.up`: from an empty buffer set the position to `0` (always the newest, discarding any stale position — design decision 3) and seed; while in recall step to `index + 1`, clamped at the last entry; do nothing when there are no entries. Use `desc`/`group` metadata consistent with the retract bindings.
- [x] 2.5 Bind `KEYS.down` in the SAME layer: while in recall at index `0`, clear the buffer and set the position to `null`; at index > 0 step to `index - 1` and seed. Build the `bindings` array per keystroke so `down` is bound ONLY while a recall is in progress and `up` only when its target index has an entry — a matched binding is `preventDefault`ed and stops dispatch, so binding a chord to run a no-op steals it from the editor (design decision 6, revised during implementation).
- [x] 2.6 Seed recalled text with `setText` + `gotoBufferEnd` and NO focus grab or empty-buffer re-check. If sharing with `seedComposerFromRetract` is awkward, factor out its set-and-move-cursor tail rather than calling it and undoing the focus (design decision 7).
- [x] 2.7 Register it in `App` via `useBindings(() => historyRecallLayer({ ... }))` alongside the existing retract/interrupt registrations.
- [x] 2.8 Do NOT add the chords to `KEYBIND_DEFAULTS` — they are structural `KEYS` entries, like the retract `up` they share.

## 3. Behavior coverage

- [x] 3.1 Add a rendered dispatch test for `historyRecallLayer` following `src/tui/keymap_interrupt_retract.render.test.tsx` — real keyboard bus through `useKeymapRoot`, the exported factory, an injected fake for the `canRetract`/entries seams.
- [x] 3.2 Cover entering and stepping: up from empty seeds the newest; a second up reaches the next-older; up at the oldest leaves the buffer unchanged.
- [x] 3.3 Cover leaving: editing a recalled entry makes the layer inert so up is cursor movement again; down from index 0 restores the empty buffer; down while not in recall does not recall.
- [x] 3.4 Cover re-entry: recall several back, clear the buffer, press up — the newest entry is seeded, not the abandoned position.
- [x] 3.5 Cover the retract boundary: with `canRetract()` true, up retracts and does not recall; with it false during a busy turn, up recalls and submits nothing.
- [x] 3.6 Cover the non-adjacent-duplicate case explicitly (the trap decision 1 avoids): send A, B, A; recall to the older A; up reaches the prompt before it, not the one before the newer A.
- [x] 3.7 Cover the exclusions. The retract exclusion is tested directly (`conversation.interrupt_retract.test.ts`: a retracted prompt leaves `promptHistory()` empty). The ask-answer and `/quit` exclusions are NOT separately testable at this level — they hold because those paths never call `send`, and reaching them needs `App.handleSubmit`, which the render harnesses deliberately do not mount (the whole workspace/DB/boot stack). Their precedence is already pinned by `ask_answer.test.ts`; the structural property is recorded on `promptHistory`'s doc comment.
- [x] 3.8 Cover the empty history: up on an empty composer in a session with no sent prompts does nothing.

## 4. Spec and docs reconciliation

- [x] 4.1 Confirm the pane's `up`/`down` still scroll in every state — no pane-targeted layer is added and `paneRetractLayer` is untouched.
- [x] 4.2 Update the `src/tui/app.tsx:111` comment on `retractLayer` that says the idle chord is "free for future recall" — it now passes to `historyRecallLayer`.
- [x] 4.3 Run `bun run format:file` on the changed `src/` files, then `bun run typecheck` and `bun run lint`.
- [x] 4.4 Run the TUI test suite and confirm no existing retract/interrupt/scroll test regressed.
- [ ] 4.5 `openspec validate prompt-history-recall --strict` PASSES. Archive is deliberately left for the user to run (`/opsx:archive`) — it rewrites the main `key-bindings` spec, which is worth a review beat.

## 5. Review follow-ups (PR #249)

- [x] 5.1 Multi-line navigability (review finding 1, HIGH): step history only from the buffer edge the chord moves away from — `up` from the first row, `down` from the last, caret movement in between. Read logical rows via `editBuffer.getCursorPosition()`/`getLineCount()`, never wrapped display lines (design decision 9).
- [x] 5.2 Cover it: recall a multi-line entry and assert `up` walks the caret row-by-row before stepping history, `down` mirrors it, and a single-line entry still recalls in one press per direction.
- [x] 5.3 Guard the entry read so `promptHistory()` is not walked on every keystroke app-wide — `activeLayers` evaluates every layer's thunk before filtering (design decision 11).
- [x] 5.4 Replace the comma-operator ternary in the `down` handler with a statement body, and comment the redundant `index`/`target` checks as tsc narrowing.
- [x] 5.5 Discoverability (review finding 4): add `ChatBar.canRecall`, append the affordance to the empty-buffer placeholder labelled from a new `RECALL_LABEL` in `keymap.ts`, and gate it behind history existing, the retract not owning the chord, and no boot gate (design decision 10).
- [x] 5.6 Cover the placeholder: affordance present with history, absent without, and outranked by a boot gate.
- [x] 5.7 Update the specs — `key-bindings` gains the caret rule and its scenarios; a new `tui-layout` delta owns the placeholder affordance.

## 6. Second review pass (PR #249, bot reviewer)

- [x] 6.1 Fix the stuck-position perf hole: the `index !== null` guard from 5.3 never goes false again once a recall is abandoned (a position deliberately outlives its recall — decision 3), so the transcript walk returned to every keystroke for the rest of the session. The position now carries its seeded text (`RecallPosition = { index, text }`) so liveness is an O(1) compare; `entries()` moved into the bindings' `run` (design decision 11, rewritten).
- [x] 6.2 Add `hasPromptHistory()` to `conversation.ts` — the cheap config-time existence check that keeps `up` unbound (and falling through) when history is empty, returning at the first qualifying turn instead of building the list.
- [x] 6.3 Cover it: a call-count test asserting that after a recall is abandoned by editing, further keystrokes never rebuild the entry list; plus unit tests pinning `hasPromptHistory()` in agreement with `promptHistory().length > 0`.

## 7. Third review pass (PR #249, bot reviewer)

- [x] 7.1 Make the hold at history-top a true no-op: `step` short-circuits when the resolved index AND text match the live position, so a clamped `up` at the oldest entry no longer re-seeds and drags the caret to the buffer end. Gated on `inRecall` so a stale position cannot suppress a fresh entry addressing the same place (design decision 9, extended).
- [x] 7.2 Cover it with a MULTI-LINE oldest entry — invisible on single-line fixtures, where the caret's end and its row-0 position coincide, which is why the existing oldest-entry test missed it. Written first and confirmed failing against the previous implementation (caret row 2, expected 0).
- [x] 7.3 Strengthen the spec's "Up at the oldest entry stays put" scenario to pin the caret as well as the buffer.
