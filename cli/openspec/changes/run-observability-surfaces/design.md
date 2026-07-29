## Context

The panel resolves its activity label through `readNewestWorkflowStep`, which selects the newest row of `dbos.operation_outputs` for the run's workflow family and passes the raw `function_name` through `friendlyStepLabel`. Three independent things are wrong with that path, and they compound:

1. **The table records completions.** A row is written when a step returns, carrying its output. An in-flight step has no row. The label therefore always names what finished last — and the step immediately before the slowest operation in a run (container provisioning) is an instantaneous identity checkpoint, which is why the observed label was `sandbox.mint`.
2. **The emit calls pollute the same table.** Every `DBOS.writeStream` allocates a function id and records a row named `DBOS.writeStream`. The sandbox step emits one per loop iteration, per tool start, per tool finish, per activity, and per file-tree delta, so in steady state the newest row is almost always that — and it passes through verbatim.
3. **The label vocabulary cannot match.** The sandbox step overrides the loop's step-name formatter to colon-delimited names, while `friendlyStepLabel` matches only the hyphen-delimited defaults used by the data-profile workflow — which is exactly what its test pins. Every assertion passes while the analysis path degrades to raw identifiers.

The harness change `run-event-stream-read-seam` supplies the correct source: a subscription delivering the run's typed parts, including a `data-step-activity` emitted on every tool call whose payload is already a human phrase.

Separately, the panel is the only docked surface painting `theme().bg` — the status bar, the sidebar, the ask prompt, and dialog panels all paint `theme().bgRaised`, the app's established "chrome, not content" surface.

## Goals / Non-Goals

**Goals:**

- The panel's activity line describes current work and changes as the work changes.
- The panel stops depending on durability-engine internals.
- The panel is recognisable as chrome at a glance, without competing with the composer.
- One live progress figure on screen per run, not three.
- A stalled data feed is visibly stalled.

**Non-Goals:**

- Rewiring the headless `inflexa run` wait. It shares the retired reader but is a non-interactive spinner where a coarse label is adequate; changing it here widens the blast radius for no user-visible gain.
- Showing sandbox command output. The sandbox server does not emit it (see the harness change).
- Replacing the ledger poll wholesale. It answers *which runs exist*, including runs started by another process; the stream answers *what is happening*. Both are needed.
- The terminal glyph artifact. Independent, reproduces on `main`, tracked separately.

## Decisions

### D1 — The stream feeds the activity label; the ledger keeps feeding the run list

**Decision.** Subscribe to the focused run's event stream and take the activity label from the folded `data-step-activity` for the running step. Leave the runs list and its `done/total` counters on the existing ledger reads.

**Why.** The two questions have different shapes. "Which runs exist for this analysis" must include a run launched by `inflexa run` in a separate process and must work before any subscription exists — that is a ledger query. "What is this step doing right now" is a per-tool-call event that only the stream carries. Moving the list onto the stream too would mean subscribing before knowing what to subscribe to.

**Rejected.** Driving `done/total` from `data-dag-state` in this change. It would work and would make the counters push-based, but the ledger already yields correct counts at step boundaries — which is the only granularity those counters change at anyway — so the swap buys nothing user-visible and enlarges the change. Left as a natural follow-on once the subscription is proven.

**Known limit of this decision.** A run was observed showing `0/5` and a frozen elapsed time for its whole duration. Two candidate causes were identified and neither was confirmed: a refresh that latched its in-flight guard permanently (addressed by D7), or a run genuinely stuck before its first step completed, in which case `0/5` was the ledger's honest answer. Keeping the counters on the ledger means this change fixes that reading **only** if the guard was the cause. If a run still shows a frozen count after D6 and D7 land — with elapsed now visibly advancing, which is what makes the two distinguishable — the remaining explanation is the run itself, and the next move is the step ledger for that run id, not more panel work.

### D1a — Known limit: one activity line, several frontier rows

The panel renders every running step as its own frontier row but carries a **single** activity line beneath them. When one step is running that is unambiguous. When several run concurrently — which the scheduler does whenever dependencies allow, and which the gallery exhibits — the line describes one of them with nothing tying it to its row.

The implementation resolves this by liveness and recency: a step whose latest reported phase is terminal has stopped, and among those still working the newest report wins. So the line always describes a step that really is running; only *which* of several is chosen by recency rather than by position.

Attributing activity per row is the better answer and is deliberately deferred. It needs `stepId` on `RunStepView`, which today is a pure display shape (`label`/`state`/`agent`/`startedAt`/`attempts`) whose `label` is already the plan's human name rather than an id — so there is no key to join an activity to a row. That is a one-field addition plus a prop-shape change across the panel, its tests, the gallery, and the shell, and it is not worth destabilising this change for a case the current behaviour reports truthfully if imprecisely. Recorded so the gap is a decision rather than an oversight.

### D2 — One subscription, following the focused run

**Decision.** The panel shows one run at a time; the subscription follows that focus, tearing down when focus moves or the run terminates.

**Why.** It matches what is on screen, and it bounds cost to one run's streams regardless of how many are active. Subscribing to every active run would multiply long-lived readers for data the user cannot see.

**Consequence.** Switching focus re-subscribes and replays that run's history. The harness seam folds reconciling parts, so the label converges immediately rather than replaying stale intermediates.

### D3 — Retire the internals reader from this path rather than repair it

**Decision.** The panel stops calling `readNewestWorkflowStep`. The function and its label mapper stay in the tree for the headless run wait, unchanged.

**Why.** Repair would mean unifying two step-name formatters, filtering engine bookkeeping rows out of the query, and extending a test to pin analysis-run names — and after all of it the source still only reports completed steps, so the panel would remain one step behind. The defect is the choice of source, so the fix is to stop using it.

### D4 — Chrome: a raised surface capped by one top rule

**Decision.** Paint the panel `bgRaised`, add a top-only border in the panel stroke weight, and carry a `RUN` label on that rule. The frame colour never changes with run state.

**Why.** `bgRaised` is the surface every other docked element already uses; the panel opting out is precisely why it read as transcript. A full four-sided frame was measured and rejected: its bottom rule lands one row above the composer's top rule, producing two parallel hairlines around an empty row, and it puts a second full box directly above the composer — whose border colour *is* its focus signal, so a matching frame dilutes it. A left rule was rejected because that idiom is already the transcript's own (user turns, reasoning, step lists), and one component explicitly reserves it for user-authored content; answering "stop looking like a transcript block" with the transcript's most-used device is self-defeating.

The frame stays a constant colour for the same reason the full box was rejected: a state-coloured frame here would read as a second focus ring. Run state lives in the header glyph's role and in the words.

**Cost.** One row, while a run is active. The tint alone is not enough to carry the design — surface separation is as low as 1.06:1 on the lightest theme — so the rule is the load-bearing cue and the tint supports it.

### D5 — The card records the launch; the panel and rail carry live progress

**Decision.** The run card drops its live meter entirely. It renders the launch, then the settled outcome.

**Why.** The card's own documentation said this before it regressed: it renders the fields the launch record carries, "not a live progress meter, which the rail renders". Three surfaces showing one figure is not redundancy that helps, and the panel already argues its own counts are bare text specifically so they do not read as a second meter — an argument that fails once a third meter exists.

### D6 — Elapsed gets its own ticker

**Decision.** Drive the panel's relative ages from a periodic signal rather than recomputing them incidentally when the data object changes.

**Why.** They are currently computed inline during render, so they advance only when the progress object's identity changes. That couples a *clock* readout to a *data* refresh: when the feed stalls, elapsed freezes at its last value and the panel reads as a run that is not progressing rather than as a view that is not updating. Other live indicators in the app already own tickers; this follows them.

### D7 — A refresh that cannot finish must not disable future refreshes

**Decision.** Bound the refresh so its in-flight guard is always released.

**Why.** The guard is set before the reads and cleared in a completion handler. Any read that never settles leaves it set for the process lifetime, disabling the poll and every lifecycle-triggered refresh at once — one stall silently freezing every live surface. The capability already requires that a slow refresh "SHALL complete and write its snapshots"; nothing implements it. The harness change bounds connection acquisition, which removes the most likely cause; this bounds the guard, which removes the consequence regardless of cause.

## Risks / Trade-offs

- **A long-lived subscription in the TUI process** → Bounded to one run by D2, torn down on focus change and termination. The harness seam isolates its failures, so a stream fault degrades the label rather than the app.
- **The panel costs a row it did not before** → Only while a run is active, and the panel is dismissable. Verified across a terminal-height sweep that the stream yields the space, not the composer.
- **Two sources feed one panel** (ledger counts, stream activity) → Accepted and drawn deliberately in D1. The risk is a reader assuming they are consistent at an instant; they are not, and nothing in the panel implies it — counts change at step boundaries, activity changes within a step.
- **Replay on focus switch costs work proportional to run history** → Paid once per switch, and the fold means the user sees converged state rather than a replay. Acceptable for a human-driven action.
- **The retired reader stays in the tree** for the headless wait → Two callers of one function, only one of them rewired, is a state that invites confusion. Mitigated by making the panel's non-use explicit in the code comment, and by the headless path's own spec continuing to describe it.
