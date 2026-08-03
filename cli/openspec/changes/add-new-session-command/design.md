## Context

Every mechanism the feature needs already exists; the change is wiring, not machinery.

- A thread id mint is an identity, not a row: nothing is written until the first turn, when `prepareChatTurn` creates the row — typed `conversation` by the harness default — and seeds its title from the message (harness `src/app/chat-turn.ts`, the store's own default).
- `ctx.openSession(threadId, workingDir, analysis)` is the sole scope writer. A same-analysis swap skips the lock exchange, and the `Chat` component resets messages/stream/status reactively on the `sessionId` change (`src/tui/contexts/workspace.ts`).
- The sidebar already renders a bound id with no row as the fresh-conversation placeholder (`ThreadSnapshot` kind `absent`, `src/tui/hooks/thread.ts`) and picks up the real title on the turn's `busy → idle` down-edge.
- `SelectItem` supports `pinned` rows that survive fuzzy ranking (`src/tui/components/list_core.tsx`), and `SelectDialog` takes `SelectItem<T>[]` unchanged.

The dev REPL already has new-by-default (`inflexa chat` with no `--thread`); the gap is TUI-only.

## Goals / Non-Goals

**Goals:**
- A deliberate "start a new conversation" action in the TUI: a palette command plus a pinned row in the Switch session picker.
- Conversation threads only, enforced by construction (no type parameter exists on this path).

**Non-Goals:**
- Report-session creation (issue #225 creates those harness-side with a type and parent; this command needs no change when that lands).
- Changes to `inflexa chat`, the harness, the schema, or any persistence.
- A default leader chord. `session.new` is reachable through the palette and remappable via `config.keybinds`; the single-key leader namespace is scarce (`n` is New analysis) and picking a key is a user decision for a follow-on.

## Decisions

**1. The command body is synchronous: mint inline, swap, done.**
`session.new` runs `ctx.openSession(randomUUIDv7(), ctx.workingDir, analysis)` (id minted inline at the call site per the house rule — no `newId()` helper). Unlike `openSwitchSession`, there is no Postgres round-trip before the swap, so the stale-analysis re-check that guards the picker's async gap is unnecessary — the scope cannot change mid-body.

**2. Boot-gated like its Session siblings, with the speak-don't-no-op refusal.**
`enabled: ctx.analysis !== null && bootState().phase === "ready"`. The mint itself needs nothing from Postgres, but a pre-`ready` chat cannot send a turn, and binding a fresh id pre-`ready` would also suppress the ready-edge resolution that opens the most-recent thread — a surprising loss for a command dispatched early by accident. A by-id dispatch (`runCommandById` calls `runCommand` with no `enabled` check) bypasses the predicate — a path live for tests today and for any future chord or keybind remap, since no binding names `session.new` — so the body carries the same phase refusal `openSwitchSession` documents: `failed` → warn, any other non-ready phase → "still booting" info notice.

**3. The Switch picker's creation row is a pinned sentinel item.**
The picker's items widen from `SelectItem<Thread>` to a union with a module-level sentinel (`NEW_SESSION`); `onSelect` branches on it. `pinned: true` keeps the row present under any filter query and when the analysis has zero listed threads — the row IS the empty state's actionable form, so the picker is never empty and the existing `emptyText` becomes unreachable (kept, harmlessly, as the contract for an items-empty render). Rejected alternative: a second dialog or a footer keybind — both add surface for what one list row expresses.

**4. Re-running New session from an already-fresh session mints again, no guard.**
The abandoned identity persisted nothing ("opening a chat and typing nothing persists nothing anywhere"), so a guard would couple the command to the thread snapshot for no observable benefit. The no-op is visually identical to the action's success.

**5. Conversation-only is a property of the path, not a check.**
No call in this chain accepts a thread type; `prepareChatTurn` defaults an absent thread to `conversation`. There is nothing to validate and nothing that can drift when report types land — and post-#299, a mistyped thread would end in the rendered `agent_unresolved` refusal rather than a mis-run.

## Risks / Trade-offs

- [Rapid repeat invocations mint several identities] → Harmless by design; identities without a first turn persist nothing anywhere.
- [User invokes New session, sees "nothing happen" because the current chat was already empty] → Accepted; the sidebar SESSION section already flips to the fresh-conversation placeholder, which is the honest render of what happened.
- [Switch picker with zero threads now opens a one-row list instead of the empty-state text] → Intended: the row is actionable where the text was advice.
