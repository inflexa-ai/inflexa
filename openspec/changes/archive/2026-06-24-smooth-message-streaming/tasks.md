## 1. Capped recent-messages query (db)

- [x] 1.1 Add a capped query in `src/db/primary_query.ts` returning the newest `limit` messages with parts, oldest→newest (`ORDER BY id DESC LIMIT $limit` then reverse; parts scoped to the kept message ids via `IN (...)`). Leave `listSessionMessages` unchanged.
- [x] 1.2 Add a `MESSAGE_CAP = 200` constant in `src/tui/hooks/conversation.ts` (the UI owns the window size) and reference it from the load path.

## 2. Live streaming (engine + render)

- [x] 2.1 In `src/modules/intelligence/chat.ts`, after creating the assistant message + empty part and emitting `message.created`, emit `Bus.emit("inf", { type: "part.updated", part: assistantPart })` before the stream loop — symmetric with the user-part broadcast.
- [x] 2.2 Pin `<markdown streaming={true}>` in `src/tui/layout/message_block.tsx` (was `streaming={isStreaming()}`). Found during live verification: in @opentui/core 0.4.0 a `<markdown streaming={false}>` renders nothing (verified headlessly), so finalized/reloaded text vanished the moment the stream ended. Added `message_block.test.tsx` render guards (finalized part shows stored text; streaming part shows live text).
- [x] 2.3 Store owns its `Part` copies in `src/tui/hooks/conversation.ts` (clone in the `part.updated` handler; replace-with-fresh-object in the idle flush instead of in-place `.text =`). The engine reuses ONE `Part` object across emits and mutates `.text` out-of-band before persisting (`chat.ts:130`); storing that reference let untracked mutations leak in and made the final same-reference assignment a no-op Solid skips under the renderer's scheduling, so the finalized text was blank even though the data looked right in a store-only test. Added `conversation.render.test.tsx` (a render-level regression — verified it fails pre-fix, passes post-fix).

## 3. Bounded mount (store)

- [x] 3.1 Point `loadMessages` in `src/tui/hooks/conversation.ts` at the capped query (newest `MESSAGE_CAP`), replacing the uncapped `listSessionMessages` call.
- [x] 3.2 In `applyBusEvent`'s `message.created` case, after pushing, drop the oldest message while the store exceeds `MESSAGE_CAP`.

## 4. Tests

- [x] 4.1 `conversation.test.ts`: cap-trim case added (205 inserts → length 200, oldest dropped). The placeholder→render→flush path is already covered by the existing "session.status idle flushes" test, which injects the placeholder the engine now emits.
- [x] 4.2 `storage.test.ts`: capped-query tests added (newest-N oldest-first with parts; fewer-than-limit; empty). Verified `randomUUIDv7` is monotonic in-process so id order == creation order.
- [~] 4.3 Engine-emit-ordering test NOT added: the emit is a synchronous `Bus.emit` inside the `assistantTurn` success branch, structurally before the `for await` delta loop, and `chat.test.ts` deliberately tests only pure helpers (the engine's IO path — proxy `/models` fetch, `streamText`, api-key file read — would need heavy brittle mocking). Covered by structure + the 4.1 render path instead.

## 5. Smooth reveal (typewriter)

- [x] 5.1 Measured the real stream: CLIProxyAPI delivers coarse chunks (~85 chars every ~150ms; whole replies in ~4 deltas), so rendering each delta verbatim jumps a sentence at a time. opencode reads "as written" because it talks to providers directly and gets fine token deltas at 60fps.
- [x] 5.2 Added a paced reveal in `conversation.ts`: `streamText` accumulates raw deltas (the target); a `revealLen` ticker (~16ms) advances a `streamDisplay()` prefix by `max(1, ceil(backlog/10))` chars/tick; `chat.tsx` renders `streamDisplay`. The `session.status` idle commit is deferred until the reveal drains so the last chunk types out instead of popping. Bumped chat `targetFps` 30→60 (matches opencode; renderer is on-demand so idle costs nothing).
- [x] 5.3 Verified the pacing headlessly: a 96-char chunk reveals over ~28 frames (`0→10→19→…→96`), the decelerating typing curve. Updated `conversation.test.ts` + `conversation.render.test.tsx` to await the deferred drain.
- [x] 5.4 Capped the per-frame reveal (`REVEAL_MAX_STEP = 10`) so a big chunk couldn't dump in one frame.
- [x] 5.5 REVERTED the typewriter reveal. The sub-delta reveal rewrote the `<markdown>` content ~60×/s, which races the renderable's async treesitter parse and left inline syntax (`**bold**`) as raw literal `**` inconsistently (user-reported, screenshot). Now mirrors opencode exactly: `streamText` accumulates deltas, `chat.tsx` renders it directly (updates only per coarse proxy delta), and `message_block.tsx` uses `<markdown streaming={true} internalBlockMode="top-level">` — the block-mode prop we were missing. Removed `streamDisplay`/`revealLen`/ticker/`finishing`; idle commits synchronously again. `targetFps` stays 60 (opencode parity). Tests updated to poll frames (internalBlockMode parses async). NOTE: the raw-`**` symptom could not be reproduced in the headless testRender harness (its markdown always resolved), so this was verified by matching opencode's proven config, not headlessly — needs live confirmation.

## 6. Verify

- [x] 6.1 `bun run typecheck`, `bun run lint`, and `bun test` (190 pass, 0 fail) all green.
- [x] 6.2 `bun run format:file` ran on the changed `src/` files.
- [ ] 6.3 Run `bun run dev`, send a long prompt, and confirm the text types out smoothly (not a sentence at a time). — manual; needs a live proxy session.
