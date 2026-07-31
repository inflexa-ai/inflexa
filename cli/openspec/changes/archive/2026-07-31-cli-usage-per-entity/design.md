## Context

The ledger already holds everything this change displays. `llm_usage` carries `thread_id`, `run_id`, `step_id`, `agent_id`, `served_model_id` and five nullable quantities per row, and `usage-breakdown` already built read paths at the session, run, and step grains. What is missing is placement: those figures are collected into one dialog and one analysis-wide rail line, and nowhere near the entity a reader is actually looking at.

A real ledger from a single analysis is the shape the design has to fit:

| rows | `run_id` | `thread_id` | calls | input | output |
|-|-|-|-|-|-|
| the run | `0182…d70ae` | `019f…c2974` | 47 | 809.2k | 40.4k |
| the data profile | `data-profile` | *(none)* | 4 | 55.5k | 3.2k |
| the conversation | *(none)* | `019f…c2974` | 1 | 11.1k | 2.9k |

Three facts follow, and each one forces a decision below. A run's calls **carry the thread that launched them**, so "this session" is ambiguous by a factor of 74. The data profile **carries no thread at all**, so it belongs to no session and its figure has exactly one possible home — its own section. And the profile's `run_id` is a synthetic literal with no `cortex_runs` row, so any "by run" grouping is already mixing two kinds of thing.

The constraint that shapes the rendering is the rail: roughly 30 columns, already carrying six sections, with model names wrapping today.

## Goals / Non-Goals

**Goals:**
- Each entity the TUI tracks reports its own spend, beside its own other properties.
- The rail's figure is current within the poll interval while work is running, and correct the moment a turn ends.
- The data profile is legible as itself rather than as an unnamed run.
- One token-figure notation, narrow enough for the rail, used by every surface.

**Non-Goals:**
- A cost or currency figure. Tokens only, as decided when the ledger was built.
- Any combined "total tokens" number. The five quantities are not summable — `cacheCreationInputTokens`/`cacheReadInputTokens` are breakdowns *of* input and `reasoningTokens` of output (`providers/ai-sdk.ts:242-251`), which is why `ChatUsage` has no total field.
- Per-message figures surviving a reload. That needs the harness's persisted rollup and is its own change.
- Schema change. Every column this needs exists.
- Wiring figures into the sidebar MODELS section (see Decision 7).

## Decisions

### Decision 1: The rail reports the working context; the aggregate moves to the switcher

Every rail section reports the entity it names, scoped to the open session. The analysis-wide total moves to the Switch analysis picker.

*Why:* the rail is the open working context — SESSION, DATA PROFILE, RUNS all describe what is in front of you — and a single analysis-wide figure among them was the one section answering a different question. An aggregate earns its keep where things are compared, and analyses are compared exactly once, in the switcher. The alternative, keeping an analysis total in the rail alongside per-entity figures, puts a number and its parts in one narrow column where they will be read as inconsistent whenever the parts do not visibly sum (which is always, because the profile is outside every session).

### Decision 2: "This session" means the conversation and the work it launched

The USAGE section sums every row stamped with the open `thread_id`, runs included.

*Why:* the conversation's own calls alone were 11.1k against the 809.2k the run it launched spent. A headline that reports the smaller number moments after the user pressed enter on the larger one is not conservative, it is wrong — and the rail already shows the run's own figure directly above, so the containment relationship is visible rather than hidden. The alternative (the conversation's own calls, which is the partition the grain reports use) is defensible in a table where every partition is present and sums to a stated total, and indefensible as a lone headline.

### Decision 3: The grain partition and the rail's containment are both kept, and named apart

`inflexa usage sessions` keeps reporting a session WITHOUT its runs, so the grains still partition the analysis total. The rail reports a session WITH them.

*Why:* they answer different questions and both are legitimate. The partition exists so a reader can add the grains up and land on the headline — an invariant `usage-breakdown` already pins with a scenario, and one that breaks the moment a session absorbs a run that also appears under runs. The rail has no total to reconcile against and one question to answer. The real risk is not that both exist, it is that both are called "session usage" and the numbers appear to contradict; so each surface states which reading it is showing, and the design says so here rather than leaving a future reader to discover a 74× discrepancy and file a bug against it.

### Decision 4: The data profile is a grain, not a run

`run_id = <the harness's data-profile literal>` is excluded from every run grouping and reported as its own thing.

*Why:* it is not a run. It has no `cortex_runs` row, the Runs picker does not list it, and the sidebar has always treated DATA PROFILE and RUNS as separate entities — only the ledger's single `run_id` column conflates them. Leaving it in the runs grouping was already producing a row (`rofile`) that a reader cannot cross-reference against anything. The alternative — keep the grouping, special-case the label — is one line, and it leaves `inflexa usage runs` reporting something that is not a run, which is a category error that then has to be remembered at every future call site.

The partition stays total: a call belongs to its step, else its run, else the profile, else its session, else the unattributed bucket.

### Decision 5: The profile's run id is imported from the harness

The CLI recognises profile rows by a constant exported from the harness, never by a string literal in CLI code.

*Why:* the value is authored by the harness at the point it stamps the frame, and a copy in the CLI is a silent coupling — the harness could rename it and nothing would fail, the profile's rows would simply start appearing as an unnamed run again with no test going red. Exporting it makes the coupling a compile-time one. This is the same reason the ledger stores the scope discriminant rather than assuming: a value the CLI did not author is a value the CLI must be told.

### Decision 6: USAGE rides the existing poll, and the trigger becomes turn completion

The section refreshes from `sidebar_live`'s bounded interval (armed only while work is active) plus the chat status transition to idle. The message-count dependency is removed.

*Why:* the current trigger is a proxy for "a turn completed" that does not hold — the assistant message is pushed at turn START, so the last read of a turn happens before its calls are recorded, and past `MESSAGE_CAP` the push-and-shift leaves the length unchanged and the memo never fires again. `chatStatus` going `busy → idle` IS turn completion, stated directly rather than inferred from a store's length. A second timer was rejected: `sidebar_live` already owns a poll with the arming discipline (only while work is active) that keeps it from spinning on an idle rail, and two timers on one rail is two things to keep armed and disarmed together.

The existing `run.observed` bus trigger is kept — it is free and it fires on run progress edges the poll would otherwise round off.

### Decision 7: The sidebar MODELS section is left alone; models move into the dialog

No figures are hung on the MODELS rows. By-model attribution lives in the usage dialog, scoped to the session.

*Why:* MODELS rows are `role → configured model` (`chat claude-opus-4-8`), while the ledger groups by `served_model_id` — what the endpoint said it actually ran. The two are stored as separate columns precisely because they can disagree, and there is already a label for calls where the endpoint reported no served id at all. Figures hung on role rows would fail to reconcile with the section total whenever a proxy substitutes, and the failure would be silent. Grouping by `requested_model_id` instead would make the rows line up by construction, but it would report what was asked for rather than what was billed, which is the wrong answer to "where did my tokens go".

### Decision 8: The dialog keeps by-model and by-agent, and loses the rest

Session-scoped, two groupings, no drill-down.

*Why:* a model and an agent are the two dimensions with no entity to hang off — there is no model card and no agent card in the TUI, and there never will be, because neither is a thing the user creates or opens. Every other grouping the dialog carried (session, run, step) now has an entity that shows it in place, so keeping the table too would mean two sources for one number. `inflexa usage` remains the full audit surface: a wide, scriptable, non-interactive medium is where an exhaustive table belongs, and it already has every grain.

### Decision 9: One notation, `↑767.6k ↓33.1k`, in one module

A single formatter renders a figure; every surface calls it.

*Why:* eight surfaces rendering "a token figure" is exactly the situation where a convention stated in prose drifts — the same reason `Date.relativeAge`/`Date.formatDuration` exist rather than per-call-site formatting. The arrows are already in `GLYPHS` (U+2191/U+2193), so no glyph is added, and they are unambiguous from the user's seat: you send up, you get back down. `→`/`←` was rejected as reading relative to the model rather than the reader; a bare `767.6k/33.1k` was rejected because absent-means-not-reported makes half-figures normal, and a missing arm in a slash pair reads as a typo rather than as an absence. Width matters concretely: 15 columns against the current 26, in a 30-column rail.

Cache renders nested under input, never beside it, because cache read and cache write are parts OF the input total — a layout that puts them on the same visual level invites the reader to add them.

### Decision 10: Per-step figures are read per run, on the poll

A step's figure comes from the existing per-run step grouping, refreshed with the rest of the run's live data.

*Why:* it is a query the run's own refresh already has the run id for, and SQLite against a local WAL file at a 5-second cadence is not a cost worth designing around. Threading a figure onto the step view (rather than a second lookup at render time) keeps the run block a pure renderer of what it is handed, which is what lets the design gallery showcase it and the tests drive it offline.

## Risks / Trade-offs

- **The rail's session figure and `inflexa usage sessions` disagree by design**, and a reader who checks one against the other sees a contradiction. → Decision 3 states the two readings and each surface names which it shows. This is the most likely support question this change creates, and the mitigation is naming, not reconciliation — forcing them to agree would break either the partition invariant or the rail's honesty.
- **The rail grows.** Cache nesting under USAGE plus figures on DATA PROFILE and each run row adds rows to a column that already wraps. → The notation change buys back 11 columns per figure, and every added figure is verified on a short terminal against the design gallery rather than assumed to fit.
- **The poll makes the rail's figure eventually-consistent** rather than exact. → It is a cumulative figure, so lag understates and never misleads, and the turn-completion edge makes the case the user actually watches (a chat turn) exact rather than polled.
- **Removing the dialog's tables removes the only place the grains were visibly summed.** → `inflexa usage` keeps them, and the reconciliation scenario stays pinned there rather than in the TUI.
- **The harness export is a cross-subsystem dependency for one constant.** → Accepted: a hardcoded literal is the alternative, and it fails silently rather than loudly.

## Open Questions

None. The two ambiguities that were open — what "this session" counts, and whether the analysis aggregate survives — are settled in Decisions 2 and 1.
