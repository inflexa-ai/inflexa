# Tasks: add-conversation-briefings

## 1. Briefing contract and registry

- [x] 1.1 Create `src/prompts/briefings/types.ts` with `BriefingDefinition<TInput>` (`name`, `description`, `mode: "standing" | "rolling"`, pure `render(input) → { content, caption }`) and the rendered-briefing value type
- [x] 1.2 Create the uniform wire wrapper (one `user` message per briefing, `<briefing name="...">` envelope) in the injection path — definitions carry plain content
- [x] 1.3 Create `src/prompts/briefings/data-profile.ts`: standing briefing rendering `DataProfileResult` (content = profile summary block; caption = file count, assay kinds, profile version)
- [x] 1.4 Add colocated fixture + snapshot test for the data-profile briefing (render in isolation, determinism)

## 2. Storage envelope

- [x] 2.1 Widen the envelope union in `src/memory/ai-sdk-message-storage.ts` with `kind: "briefing"` (`name`, `caption`, `aiSdkMajor`, wrapped `user` `ModelMessage`); keep validation fail-closed on unknown kinds
- [x] 2.2 Tests: briefing envelope round-trips verbatim; unknown kind still rejected; template change requires no row rewrite (stored content is authoritative)

## 3. Thread history — pinned prefix

- [x] 3.1 Add idempotent `appendBriefings(threadId, briefings)` to `src/memory/thread-history.ts`: one transaction, `seq` preceding all turns, no-op when briefing rows exist (first writer wins)
- [x] 3.2 Make `loadRecent` return `[...briefings, ...window]`: briefing rows always first, exempt from token budget
- [x] 3.3 Make turn-boundary detection consult envelope kind so a briefing row (role `user`) is never a turn start and window snapping never anchors on or splits the briefing prefix
- [x] 3.4 Tests: briefings survive eviction on an over-budget thread; identical turn windows with/without briefings under the same budget; window cut at the briefing/turn seam; concurrent first-turn append yields one briefing set; eviction metric counts turns only

## 4. Composition and stream surface

- [x] 4.1 Compose standing briefings in `src/app/chat-turn.ts` (`prepareChatTurn`): on a thread's first turn, render available briefings in array order, omit briefings with unavailable inputs (data profile pending/failed), persist via `appendBriefings`
- [x] 4.2 Emit one typed briefing-card event (`name`, `caption`) per injected standing briefing; add the part type to `src/contracts/` following the plan-card/run-card conventions
- [x] 4.3 Add the one-sentence `<briefing>` convention note to the conversation system prompt (`src/prompts/conversation.ts`)
- [x] 4.4 Tests: first turn with completed profile assembles briefing-first messages and emits the card event; pending profile omits the briefing with no placeholder; second turn re-injects nothing

## 5. Verification and follow-ups

- [x] 5.1 `tsc -p tsconfig.json` and `bun test` green; `bun run format:file` on touched `src/` files
- [x] 5.2 Confirm rolling mode is representable but unused (contract-level test only) — working-memory/analysis-context retrofit stays out of scope
- [x] 5.3 Open the companion `cli/` change (Part union `briefing-card`, one-line muted render in `message_block.tsx`, stream-adapter reader) — separate change in `cli/openspec/changes/`
