## Context

The harness stores each append's display projection and replays it. The producer is a recorder that wraps an `EmitFn` and forwards every event unchanged while folding it into ordered display messages; the consumer is a synchronous read over stored projections. Neither exists in this host yet.

The turn engine (`runChatTurn`) is shared by the TUI and the clack REPL, so both surfaces inherit whatever it does here.

## Goals / Non-Goals

**Goals:**

- Every turn this host runs stores what it displayed.
- No event a user saw reaches the surface by a path the recorder did not observe.
- The transcript read consults stored projections and nothing else.

**Non-Goals:**

- Changing what the live surface renders. The emit reducer is untouched.
- A new design-system state. See D3.

## Decisions

### D1 — `chat` and `ask` take the sink, rather than closing over it

`RunChatTurnArgs.chat` becomes `(emit: EmitFn) => AgentChat` and `ask` becomes `(request, emit) => Promise<AskApproval>`.

This is the load-bearing decision, and it is not cosmetic. `createStreamingChat` forwards each provider text delta by calling `emit({type: "text-delta", …})`, and the ask gateway emits its `data-ask` parts the same way. Built over the raw sink, both reach the live surface correctly and are invisible to the recorder — so a reloaded turn would be missing its assistant text and its approval cards, which is to say most of what the user saw. Passing the sink in is what makes the recorded path the only path.

Alternative rejected: construct the recorder in each caller and let it pass a pre-wrapped sink as `emit`. It works, but it puts the obligation in two places and makes "did this caller wrap it?" a question a reader has to answer per call site; the engine owning it makes the wrapping unconditional.

### D2 — `finish` runs before the append, on all three phases

The projection is taken once, immediately before `appendTurn`, with `fallbackText` on the `ok` branch and `interrupted` on the `aborted` branch.

Not inside the `ok` branch, for the same reason the usage rollup rides all three: an aborted turn displayed real work, and its projection is what the retract window renders. A failed turn likewise displayed whatever it produced before it threw.

### D3 — An interrupted call replays as `running`

A call in flight when a turn was cut off replays with `status: "started"` and no outcome — the harness records what it observed and does not invent an outcome. The local part type has four statuses and none of them means this.

It maps to `running`. That does not read as live here because the message carries the interruption badge: the pair says "in flight when the turn was cut off". **The two must not be separated** — the marker alone would look like a call still in progress.

Alternative rejected: a fifth `interrupted` status. It is self-describing at the call, but it is a new design-system state — shared type, tool block, gallery exhibit — to distinguish a case the message badge already distinguishes.

Alternative rejected: keep reporting `ok`. It claims a result the tool never returned, which is the false-success defect the harness redesign removed one layer down.

### D4 — The reload seam loses its parameters, its `Promise`, and its error channel

`toCortex` becomes `(messages) => CortexMsg[]`.

Every parameter it dropped existed to serve reconstruction: the pool and analysis id resolved a workspace root for card rebuilding, and the tool roster built the detail resolver. Replay needs none of them, cannot touch the database or filesystem, and cannot fail — so `ResultAsync.fromPromise` around it wrapped something with no failure mode, and its error branch was unreachable.

Consequence accepted: the workspace-root degradation branch goes with it. A moved or deleted anchor used to downgrade preview cards to chips on reload; now it has no effect on a transcript read at all, which is strictly better and one less place local-state desync can surface.

Consequence checked: the seam going synchronous costs no test coverage. The load-interleaving tests gate on `loadPage`, which is still async; `toCortex` fakes were trivially async and never used to sequence anything.

### D5 — A record carries its own projection

`run_completion` appends through the harness's record constructor, which builds both the model message and its `system`-role projection.

The harness owns that mapping for the same reason it owns the synthetic marker: a hand-assembled record can be a message the turn-boundary predicates fail to recognise. Appending one without a projection is the quiet failure mode here — it is stored, the model reads it, and the transcript never shows it.

## Risks / Trade-offs

- **A future call site adds an emit path that bypasses the recorder** → The engine owns the wrapping and both `chat` and `ask` take the sink as a parameter, so a bypass requires deliberately capturing the raw sink rather than merely forgetting to wrap.
- **An interrupted call's marker is read as live if the badge is missed** → Accepted, and stated at both the renderer and here (D3). The alternative costs a design-system state for a case already distinguished.
- **The transcript no longer degrades when the workspace moves** → Not a risk; it is the point. Recorded in D4 so the removed branch is not mistaken for a regression.
