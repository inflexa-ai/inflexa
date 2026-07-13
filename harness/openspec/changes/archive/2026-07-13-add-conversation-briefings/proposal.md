# Proposal: add-conversation-briefings

## Why

Context that an agent loop needs from its first turn — the data profile, a prior run's results, a plan handoff — is today injected ad hoc: the planner hand-assembles a giant first `user` message by string concatenation (`src/tools/research/generate-plan.ts`), while the main conversation has no way to receive such context at all short of stuffing it into the system prompt (where it would occupy cache-hostile, always-loaded space) or the tail (which is reserved for volatile per-turn state). There is no shared, inspectable definition of these injectable blocks, no persistence of what the model actually saw, and no way for the chat UI to show that the agent was given context it didn't type.

Briefings make this a first-class harness concept: declaratively defined, typed, testable-in-isolation context blocks with an explicit placement policy — grounded in prompt-cache prefix economics and position/recency evidence (strict-prefix caching, Lost-in-the-Middle and follow-ups, the first-message injection pattern used by production agents).

## What Changes

- New `BriefingDefinition<TInput>` contract: a pure, declarative definition of one injectable context block — `name`, `description`, `mode: "standing" | "rolling"`, `render(input) → { content, caption }` — one definition per file under `src/prompts/briefings/`, each with a colocated fixture so it can be snapshot-tested and previewed in isolation.
- **Standing briefings**: injected once at conversation start, immutable for the thread's lifetime (no supersede; a mid-session data-profile re-run announces itself as a regular message instead), persisted verbatim, and always pinned above the history window so they never fall out of `loadRecent`'s token budget.
- **Rolling briefings**: re-rendered every turn at the tail, never persisted — the formalization of what working memory / analysis context already do (their retrofit is follow-up work, not this change).
- `mode` is a single field by design: `prefix + every-turn` (cache-destroying) and `tail + pinned` (degenerate — just a regular message) are unrepresentable.
- Composition is explicit, no auto-discovery: the caller (chat-turn orchestration for the main conversation; each tool for its sub-agent loops) binds typed inputs and passes briefings in array order (deterministic, cache-stable). An unavailable input (profile still running / failed) means the briefing is omitted, never placeholder-rendered.
- Wire format: one `user` message per briefing, wrapped by the harness (not the definition) in a uniform `<briefing name="...">` tag.
- Storage: new `briefing` envelope kind alongside `ai-sdk-model-message`, persisted verbatim (what the model saw is what is stored — later template changes need no migration).
- Thread loading: `loadRecent` returns `[...briefings, ...window]`; turn-boundary detection consults the envelope kind so a briefing (role `user`) is never mistaken for a turn start.
- Stream surface: the harness emits a briefing-card event (name + caption) when standing briefings are injected, so hosts can render a one-line "agent was briefed" marker. (The CLI-side `briefing-card` part and render is a companion change in `cli/`.)
- First producer: the data profile becomes a standing briefing consumed by the main conversation. The planner's hand-built prompt migrating to composed briefings is a follow-up change.

Deferred deliberately: per-briefing token budgets/priorities, trust labeling of briefing content, working-memory/analysis-context retrofits, planner migration.

## Capabilities

### New Capabilities

- `conversation-briefings`: the briefing concept — definition contract and registry directory, standing/rolling mode semantics, composition rules (caller-composed, ordered, omit-on-missing-input), uniform wire wrapping, immutability of standing briefings, the briefing-card stream event, and the data profile as the first standing briefing.

### Modified Capabilities

- `ai-sdk-message-storage`: the versioned envelope gains a `briefing` kind (name + caption + wrapped model message) alongside `ai-sdk-model-message`.
- `harness-thread-history`: standing briefings persist with the thread and are pinned above the windowed history — `loadRecent` always returns them first regardless of token budget, and turn-boundary snapping treats briefing rows as non-turn-starting.

## Impact

- **Harness code**: new `src/prompts/briefings/` (contract, registry, data-profile briefing + fixture); `src/memory/ai-sdk-message-storage.ts` (envelope kind); `src/memory/thread-history.ts` (pinned prefix, kind-aware boundaries, briefing append); `src/app/chat-turn.ts` / `src/app/message-assembly.ts` (compose + inject on first turn); the emit/stream adapter surface for the briefing-card event.
- **Embedder (separate change in `cli/`)**: `Part` union gains `briefing-card`; `message_block.tsx` renders one muted line per standing briefing; the harness-stream adapter reads the new event. Rolling briefings render nothing in chat.
- **Storage**: no schema migration — the `messages` table already stores opaque envelopes; only the envelope union widens.
- **Naming**: "briefing" was chosen over "seed" to avoid colliding with `seedInputFileIds` in `src/state/data-profile.ts` (the profiled input file set).
