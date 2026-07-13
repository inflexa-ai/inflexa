# Design: add-conversation-briefings

## Context

Agent loops need context that is relevant from the first turn but does not belong in the system prompt (which is agent-lifetime, cache-hostile to change, and always loaded) nor in the volatile tail (which is reserved for per-turn state like working memory). Today this need is met ad hoc: `generate-plan.ts` string-concatenates a giant first `user` message (data profile, prior runs, constraints, prior plan); the main conversation has no mechanism at all; working memory and analysis context are two more one-off injection conventions in `message-assembly.ts`. Nothing is inspectable in isolation, persisted, or visible to the user in chat.

External grounding for the placement model:

- Prompt caching is strict-prefix; cached reads are ~0.1x price. Stable-prefix / append-only context is the dominant production pattern (Manus calls KV-cache hit rate "the single most important metric").
- Position studies (Lost in the Middle and follow-ups) show start and end of context beat the middle; modern models weaken the position effect but length-driven degradation persists — so the *cache* argument, not primacy alone, drives front placement.
- Production agents inject session context around the first user message rather than the system prompt (Claude Code's CLAUDE.md/env injection), and refresh volatile state at the tail (Manus recitation; Claude Code system-reminders).

## Goals / Non-Goals

**Goals:**

- One declarative, typed, pure contract (`BriefingDefinition`) for every injectable context block, inspectable and snapshot-testable in isolation.
- Standing (pinned-prefix, persisted, immutable) and rolling (tail, per-turn, ephemeral) modes with placement/refresh/persistence/caching all derived from the one `mode` field.
- Standing briefings never fall out of the history window and are never mistaken for turn starts.
- A stream surface so hosts can render "the agent was briefed" markers.
- Data profile as the first standing briefing in the main conversation.

**Non-Goals:**

- Retrofitting working memory / analysis context onto rolling briefings (follow-up change; the contract must merely be shaped so they fit).
- Migrating the planner's hand-built prompt to composed briefings (follow-up change).
- Per-briefing token budgets, priority-based degradation, trust labeling.
- Any auto-discovery/registry-scanning mechanism.
- CLI rendering (companion change in `cli/`; the harness only emits the event).

## Decisions

### D1: A single `mode: "standing" | "rolling"` field, not separate placement + refresh fields

The four combinations of `placement: prefix|tail` × `refresh: pinned|every-turn` contain two degenerate cells: `prefix + every-turn` rewrites the cached prefix each turn (invalidates the entire prompt cache — the exact anti-pattern the caching evidence warns against), and `tail + pinned` is just a regular message after one turn. `mode` names the two real behavior bundles and makes the illegal states unrepresentable. *Alternative considered*: independent fields for future flexibility — rejected; there is no future combination to hold the door open for.

### D2: TypeScript modules with a pure `render`, not markdown-with-frontmatter files

Briefing inputs are typed harness state (`DataProfileResult`, prior-run records). A TS contract keeps input binding type-checked with zero new dependencies; a dotprompt-style file format would duplicate schemas into picoschema and add a template engine. Inspectability — the actual requirement — comes from purity: `render(input) → { content, caption }` does no I/O, so each definition ships a colocated fixture, gets a snapshot test, and can be previewed standalone. *Alternative considered*: `.prompt`/markdown files (dotprompt, skills-style) — rejected for v1; runtime-loadable definitions remain a future door since the contract doesn't preclude a file-backed loader.

### D3: Caller-composed, ordered, omit-on-missing — no auto-discovery

The composition site (chat-turn preparation for the main conversation; each tool for its sub-agent loops) binds inputs and passes briefings as an ordered array. Array order is the injection order — deterministic across turns and resumes, which cache stability requires. If an input is unavailable (profile still running or failed), the briefing is omitted: a standing briefing is immutable, so injecting a "pending" placeholder would pin a stale statement into the prefix forever. *Alternative considered*: registry-driven auto-inclusion by scope — rejected as magic; the set of briefings a loop receives should be readable at its call site.

### D4: One `user` message per briefing, harness-wrapped in a uniform tag

Each briefing becomes its own `user` message wrapped by the injection path — not by the definition — in `<briefing name="...">…</briefing>`. Definitions stay plain content; the wire convention lives in exactly one place; briefings remain independently addressable in storage and on the wire. The conversation system prompt gains one sentence explaining briefing blocks.

### D5: Persist standing briefings verbatim as a new `briefing` envelope kind

Stored shape: `{ kind: "briefing", name, caption, message }` alongside `kind: "ai-sdk-model-message"` in the existing versioned envelope union — validation stays fail-closed for unknown kinds. What the model saw is what is stored, so template changes never require migration; old threads simply keep the text they were briefed with. No DB schema change: the `messages` table already stores opaque envelopes.

### D6: Pinned-prefix loading with kind-aware turn boundaries

`loadRecent` returns `[...briefings, ...window]`: briefing rows are always returned first, exempt from the token budget, and the newest-first window walk treats a briefing row (role `user`, kind `briefing`) as non-turn-starting so window snapping never lands on or splits the briefing prefix. This is the main integration risk (see R1). Standing briefings are appended once, idempotently, at thread start (before the first turn's rows) so their `seq` precedes all turns.

### D7: No supersede — standing briefings are immutable for the thread's lifetime

If the data profile re-runs mid-thread, the update arrives as a regular message from the re-run flow (recency-placed, which is where the evidence says an *update* belongs); new threads and new sub-agent loops pick up the fresh profile at their own start. This deletes the hardest problem (refresh/versioning/cache-invalidation semantics) and keeps the prefix permanently cache-stable. The caption carries the profile version for provenance.

### D8: Stream event for standing briefings only

The harness emits a briefing-card event (`name`, `caption`) when standing briefings are injected, via the same typed-part surface as plan-card/run-card (`src/contracts/`). Rolling briefings emit nothing — rendering an every-turn block would clutter chat history with no information.

### D9: Naming — "briefing", not "seed"

"Seed" implies planted-once (wrong for rolling mode) and collides with `seedInputFileIds` in `src/state/data-profile.ts` (the profiled input file set). "Standing briefing" / "rolling briefing" name the behavior bundles directly.

### D10: Sub-agent loops use the same definitions, unpersisted

Sub-agents (planner, literature reviewer) have ephemeral transcripts (no thread history), so for them briefings are just structured `initial` messages built from the same definitions — same contract, same wrapping, no storage. Nothing in `runAgent` changes.

## Risks / Trade-offs

- **R1: Window-boundary logic regression** — briefing rows are role `user`; if boundary snapping doesn't consult the envelope kind, a briefing could be treated as a turn start (mid-thread windows silently anchoring to the briefing, or the briefing being evicted). → Mitigation: boundary predicate keys on envelope kind, with dedicated tests: window cut landing exactly at the briefing/turn seam, thread whose only content is briefings + one oversized turn, eviction metrics excluding pinned rows.
- **R2: First-turn race** — two concurrent first requests could both try to append the standing briefings. → Mitigation: idempotent briefing append (same discipline as `createThread`; append only if the thread has no briefing rows, in one transaction).
- **R3: Unbounded briefing size** — a huge data profile summary pins a huge prefix. → Accepted for v1 (profile summaries are already size-disciplined); per-briefing token budgets are deferred and the metric added in R1 testing gives observability.
- **R4: Omit-on-missing means early threads never get the profile briefing** — a thread started before profiling completes has no profile in its prefix for its whole lifetime. → Accepted: the re-run/completion announcement path covers it as a regular message; consistent with immutability.
- **Trade-off**: persisting briefings verbatim duplicates content across threads of the same analysis rather than referencing a shared blob — chosen for auditability ("what did this model actually see") and zero-migration template evolution.

## Migration Plan

Purely additive: new envelope kind (fail-closed validation already tolerates unknown kinds by rejecting them, and no existing rows carry the new kind), new thread-history operations, new composition in chat-turn. No backfill, no schema migration, no rollback steps beyond reverting the code. Existing threads simply have zero briefing rows.

## Open Questions

- Whether the briefing append happens inside `prepareChatTurn` (first call wins) or at thread creation — leaning `prepareChatTurn`, since that is where the data-profile status is already loaded and thread creation is UI-initiated without analysis context.
- Exact event name/part shape for the briefing card in `src/contracts/` — align with plan-card/run-card conventions during implementation.
