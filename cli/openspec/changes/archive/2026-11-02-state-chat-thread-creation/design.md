# Design

## Context

`POST {A}/chat` calls `startChatTurn` (`src/server/routes/conversation.ts`), and that function opens the turn through the chat turns of the harness. The route does no read of the thread before the open. The `not_found` result of the harness comes back as `thread_gone` (`src/modules/harness/turn.ts`), and `refusalOf` maps it to 404. The open of the harness claims a thread only when it is live, thus an archived thread already gets 404. The TUI mints a thread id when no thread exists (`src/tui/hooks/thread.ts`), and the first turn makes the row.

## Goals / Non-Goals

**Goals:**

- The spec states the behavior that the route has with the current harness pin.

**Non-Goals:**

- A route that makes a thread.
- A change to the route code or to the TUI. The TUI already shows "This conversation thread is no longer available." for a refused 404.

## Decisions

### D1. The spec follows the harness, and the route code stays

The harness decides which thread a turn can write into, thus the route keeps no thread rule of its own. The spec names the result that the route gives for each case. A route read of the thread before the open would duplicate the rule of the harness, and the two rules could disagree.

## Risks / Trade-offs

- [No cli test opens a turn on a real archived thread] → The route test of the `thread_gone` mapping covers the 404. The harness tests of the preparation cover the refusal.
- [The harness change `refuse-archived-turn-thread` makes a failed make of the thread a `prepare_failed`] → The route then gives 500 for that fault, which this requirement already names.
