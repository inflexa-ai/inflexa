# Design

## Context

`openThread` (`src/app/chat-turn.ts`) does its ownership test on `getThread`, and `getThread` hides an archived row. For an archived row, the test sees no row. Then the idempotent `createThread` gives back the archived row unchanged, and no code compares the analysis of that row. The message assembly reads the thread by its id only.

Two paths call `openThread`:

- The workflow open (`chatTurns.open`, `src/app/chat-turn-workflow.ts`) claims the thread after `openThread`. The claim reads only a live row (`src/state/active-turns.ts`), thus an archived row gives `no_thread`, and the open gives `not_found`.
- `prepareChatTurn` and the in-process turn (`src/app/in-process-turn.ts`) do no claim. They take the `ok` of `openThread`, and the turn reads and writes the archived thread.

`openThread` also runs `createThread` inside the best-effort catch of the title seed. Thus a failed `createThread` gives `ok` with no row to examine.

## Goals / Non-Goals

**Goals:**

- One refusal for each thread that a turn must not write into: a thread of a different analysis, live or archived, and an archived thread of the same analysis.
- No new store method, and no new result of the open.

**Non-Goals:**

- A turn that restores an archived thread.
- A check after the open. A turn that opened before an archive can continue to write its rounds.
- A data part and a renderer for the analogy report.

## Decisions

### D1. An archived thread is `not_found`, also for the same analysis

The preparation refuses an archived thread of the same analysis with `not_found`. The repository treats an archived thread as absent for each write:

- The workflow open already gives `not_found` for an archived thread, at the claim of the thread.
- `getThread` treats an archived row as absent (`harness-thread-store`).
- A report session does not spawn from an archived parent, because a spawn into hidden state is not permitted (`report-session-spawn`).
- The cli plan approval route gives 404 for an archived thread (cli `local-server`).
- Only `unarchiveThread` restores a thread, and a caller names the thread to restore it (`harness-thread-store`).

The TUI already shows "This conversation thread is no longer available." for a refused 404.

Alternatives:

- The turn restores the thread and continues. This makes a second restore path, against the rule that a caller restores an archived thread by its name.
- The turn writes into the archived thread, which is the current behavior. Each listing hides the thread, thus the user cannot see the new messages.

### D2. The refusal reads the row that `createThread` gives back

The open keeps its read of the live row and its ownership test on that row. When that read gives no row, the open calls the idempotent `createThread`. That call gives back the inserted row, or the existing row with no filter. The open refuses that row when its analysis is not the analysis of the turn, or when it has a tombstone. A conflict on the insert writes nothing, thus the refusal comes before each write of the turn.

The refusal must not go through the best-effort catch of the title seed. A failed `createThread` must fail `openThread` with a throw, thus each caller gives `prepare_failed`. Without a row, the open cannot tell an absent thread from a thread that it must refuse. A failed `setAutoTitle` stays non-fatal, because the title seed is the only best-effort write.

The workflow open keeps its claim unchanged. The claim then gives a second refusal of an archived row, for an archive that comes after `openThread`.

After this change, an archived row no longer reaches the emit of `create-session`. Thus the comment at the emit must state the current reason for its guard, and not the archived row.

Alternative: a new store read that includes archived rows, before the insert. It adds a store method for one caller, and it gives the same verdict.

### D3. The agent gives the analogy report in its reply

The tool has the view `"none"` (`tool-call-values`), no part carries its result, and no client renders it. Thus the prompt and the tool description tell the agent to give the report in its reply. The text states the behavior that the agent must show. It is not a "Do NOT" entry, because the prompt principles keep those for a failure that an agent showed.

Alternative: a `data-*` part and a TUI renderer. That is a new block in the design system of the cli. The cli rules make a new block a discussion with the user first. The issue accepts the prompt route.

## Risks / Trade-offs

- [A client holds the id of a thread that a different client archived] → The next turn gets `not_found`. The TUI shows that the thread is no longer available. The user can restore the thread or open a different one.
- [A database fault during the make of the thread] → The workflow open gives `prepare_failed` and not `not_found`. The cli maps that result to 500. The fault is not a missing thread, thus 500 is the correct answer.
