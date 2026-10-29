# planning-enhancements Specification

## Purpose

Analysis plans are produced by the `generate_plan` tool
(`src/tools/research/generate-plan.ts`), which the conversation agent calls with
structured context. The tool does not make a single structured model call — it
drives an internal `planner` sub-agent (`AgentDefinition`, id `"planner"`)
through `runWithSalvage` (the salvage wrapper around `runLoop`). The planner
communicates results EXCLUSIVELY through tool calls; its text reply is
discarded, and the tool selects the outcome from the recorded results of the
terminal tool calls.

The planner's inner tools divide by whether they record an outcome. The terminal
set is `submit_plan` (check a candidate), `request_clarification`, and
`report_blocker` (the planner's honest "no viable plan" exit); everything else is
non-terminal and may be called freely — `list_available_refs` (reference-store
discovery, so a step is only
committed to reference data the environment actually holds). That split, not the
size of either set, is the invariant: a plan reaches the caller only through a
terminal call, and non-terminal tools record no outcome. The whole
invocation is bounded by one wall-clock guard, merged with the caller's abort
signal. The guard is 1800s, or the advertised provider request timeout when
larger; the planner loop is iteration-capped at 300. There is no per-attempt
timeout, no internal retry counter, and no `adaptive` thinking or `budget_tokens`
anywhere in the planning path.

## Requirements

### Requirement: Plan generation runs as an internal planner sub-agent loop

The conversation agent SHALL generate plans by calling the `generate_plan` tool,
which SHALL drive an internal `planner` `AgentDefinition` via `runWithSalvage`
(wrapping `runLoop`) under a child session derived with
`forSubAgent(ctx.session, "planner")`. The planner SHALL communicate its result
only through terminal tool calls; its text reply SHALL be discarded.

#### Scenario: Conversation agent invokes generate_plan

- **WHEN** the conversation agent needs an analysis plan
- **THEN** it calls `generate_plan` with `{ dataContext, researchQuestion, priorRuns?, userConstraints?, parentPlanId? }`
- **AND** the tool runs the planner sub-agent via `runWithSalvage` under a `forSubAgent` child session

#### Scenario: Planner outcome selected from the recorded tool results

- **WHEN** the planner finishes its loop
- **THEN** the tool selects the outcome from the recorded results of the terminal tool calls, not from the planner's text reply

### Requirement: A single wall-clock guard bounds the whole invocation

The tool MUST bound the entire invocation with a single wall-clock guard,
merged with the caller's abort signal through `AbortSignal.any`. The guard value
MUST be the maximum of 1800s (`PLAN_TIMEOUT_MS = 1_800_000`) and the
`requestTimeoutMs` that the planner provider advertises. There MUST be no
per-attempt timeout and no internal retry counter.

#### Scenario: Invocation times out

- **WHEN** plan generation exceeds the wall-clock guard
- **THEN** the planner is aborted and the tool returns an `error` event indicating a timeout

#### Scenario: A slow provider raises the guard

- **GIVEN** a planner provider that advertises a `requestTimeoutMs` above 1800s
- **WHEN** the tool arms its wall-clock guard
- **THEN** the guard value is the advertised value, not 1800s

#### Scenario: Caller abort cancels the planner

- **WHEN** the caller's abort signal fires
- **THEN** the planner is cancelled and the tool returns an `error` event indicating cancellation

### Requirement: The tool returns a typed outcome and never throws

The tool SHALL translate the recorded outcome into a `PlanningAgentOutput` whose
`event` is one of `"plan_complete"`, `"clarification_needed"`, or `"error"`, and
SHALL return it as a data result (`ok(...)`) in every case — it SHALL NOT throw.

The tool SHALL also **record** that outcome through an injected `Logger`, exactly once per
invocation, carrying the outcome kind, the elapsed wall-clock of the invocation, and the
`analysisId`. Returning the outcome is not recording it: `generate_plan` is a conversation-layer
tool that runs outside a workflow, so it writes no ledger row and owns no durable stream, and the returned
string is otherwise the entire evidence that the tool ran at all.

The record's level SHALL follow the outcome rather than the return type, which is uniformly
`ok(...)`: a submitted plan and a clarification request are both the tool working as designed and
SHALL be recorded at `info`; a reported blocker SHALL be recorded at `warn`; and an invocation that
produced no plan through failure — the wall-clock guard elapsing, the invocation being cancelled, a
thrown loop error, a persistence failure, or a run that ended with no terminal outcome recorded —
SHALL be recorded at `error`, distinguishing which of those occurred.

The elapsed wall-clock is recorded because it is what separates a planner that gave up early from
one still working when the guard cut it, and the fixed guard makes the number interpretable
without any other context.

#### Scenario: Successful plan

- **WHEN** the planner submits a valid plan
- **THEN** the output is `{ event: "plan_complete", planId, plan }`

#### Scenario: Clarification needed

- **WHEN** the planner calls `request_clarification`
- **THEN** the output is `{ event: "clarification_needed", question, questionContext? }`

#### Scenario: Blocker or failure

- **WHEN** the planner calls `report_blocker`, or persistence fails, or the invocation times out or is cancelled
- **THEN** the output is an `{ event: "error", error }` data result and no exception is thrown

#### Scenario: A successful invocation is recorded once

- **WHEN** the planner submits a valid plan
- **THEN** exactly one outcome record is written at `info`, carrying the outcome kind, the elapsed wall-clock, and the `analysisId`

#### Scenario: Each failure shape is distinguishable in the record

- **GIVEN** an invocation that ends without a terminal outcome, and one whose wall-clock guard elapses
- **WHEN** each is recorded
- **THEN** both are written at `error` and the records distinguish the two causes from each other

#### Scenario: A blocker is recorded as degraded, not failed

- **WHEN** the planner calls `report_blocker`
- **THEN** the outcome record is written at `warn`

### Requirement: The agent catalog is injected into the planner prompt

The planner system prompt SHALL be built by `plannerPrompt(formatAgentCatalog())`,
substituting the rendered `PLANNABLE_AGENT_CATALOG` for the prompt's
`{{AGENT_CATALOG}}` placeholder, so the planner can only route to plannable
agents.

#### Scenario: Planner prompt carries the rendered catalog

- **WHEN** the planner system prompt is assembled
- **THEN** its `{{AGENT_CATALOG}}` placeholder is replaced with the markdown rendered from `PLANNABLE_AGENT_CATALOG`

### Requirement: Each plan step names its packages

In `PlanStepSchema`, the `packages` array MUST be a necessary field of every
planned step. Each entry MUST be a query in the one grammar of the
`package-identity` capability: an optional track prefix, a spelling, and
an optional exact version. The prefix names the track of the pool that the
link pass searches. A bare spelling searches both tracks. The persistence
schema MUST keep the field optional, thus a stored plan from before this
change still parses. The briefing MUST withhold the `packages` field from
the rendered task, because the link pass consumes it and a step agent must
not re-litigate it.

#### Scenario: A new plan carries packages on every step

- **WHEN** the planner submits a plan
- **THEN** every step holds a `packages` array, possibly empty

#### Scenario: An old stored plan still parses

- **GIVEN** a persisted plan whose steps have no `packages` field
- **WHEN** the plan loads
- **THEN** the load succeeds

#### Scenario: The briefing withholds the field

- **GIVEN** a step with a non-empty `packages` array
- **WHEN** the briefing renders the task
- **THEN** the rendered text does not name the array

#### Scenario: An entry parses into a query

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR", "scanpy", "numpy==1.26.4"]`
- **WHEN** the link pass parses the entries
- **THEN** the queries carry the tracks `python`, `r`, none, and none, with the spellings `igraph`, `decoupleR`, `scanpy`, and `numpy`

### Requirement: The plan validation refuses a package location

The shared plan validation MUST parse each package entry with `parseQuery`,
and it MUST report one issue for each parse error. The two callers of the
validation are the re-validation of `submit_plan` and the pre-launch
re-validation of a stored plan. The issue MUST name the step and the
offending entry. An absent `packages` array MUST pass, because the stored
plans from before this change carry none. The validation holds no parser
of its own, thus it cannot disagree with the link pass.

A `location` error refuses a path, a URL, or a store directory. An
`unsupported_specifier` error refuses a version specifier that is not
`==`, because a range such as `numpy>=1.26` otherwise becomes a package
name. An `unknown_prefix` error refuses a prefix that is not `python:` or
`r:`, and the issue MUST name the two permitted prefixes.

#### Scenario: A path is refused

- **GIVEN** a candidate plan step whose packages include `/mnt/libs/store/scanpy-1.12.3-e71bae79`
- **WHEN** the planner submits the plan
- **THEN** the submit is rejected, with an issue that names the step and the entry

#### Scenario: A requirement form passes

- **GIVEN** a step whose packages are `["scanpy", "numpy==1.26.4"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: A range specifier is refused

- **GIVEN** a step whose packages include `numpy>=1.26`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names the `==` form

#### Scenario: A prefixed form passes

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR==2.17.0"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: An unknown prefix is refused

- **GIVEN** a step whose packages include `bioc:fgsea`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names `python:` and `r:` as the permitted prefixes

#### Scenario: A leading space does not defeat the prefix guard

- **GIVEN** a step whose packages include `" bioc:fgsea"`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry

### Requirement: The planner prompt teaches the package field

The planner system prompt MUST carry a section on the packages of each step.
It MUST instruct: name each package as a requirement, never a path or a URL.
It MUST state that the set is not a promise of completeness, because the
execution agent can still link a missing package. It MUST instruct: when
the census shows a name under the Python section and under the R section,
write the prefixed form that the census shows. It MUST state that a bare
both-track name refuses the launch. The matched anti-pattern list MUST gain
the location form.

#### Scenario: The prompt names the requirement form

- **WHEN** the planner system prompt is assembled
- **THEN** it instructs the planner to name each package as a requirement and never as a location

#### Scenario: The prompt names the prefix

- **WHEN** the planner system prompt is assembled
- **THEN** it instructs the planner to write `python:<name>` or `r:<name>` for a name that both sections show

### Requirement: A plan's packages link before the launch

When the farm-extension seam is bound, the launch MUST link the plan's
packages before the run reserves anything. The linked set is the union of
the queries of each step, and it goes into the farm of the analysis. The
union MUST dedupe equal queries only: two entries are one request when
their spelling, their track, and their version are equal. A bare entry
and a qualified entry of one spelling are two requests. The pass MUST pass
each query to the seam as it was parsed.

A pool miss MUST refuse the launch with an error that names the missing
spellings. A `collision` outcome MUST refuse the launch with an error that
names the two store directories and the two prefixed forms, written with
`formatQuery`. The harness MUST NOT name a remedy command, because the
remedy belongs to the embedder. The prefix is a plan form and not a
command, thus the refusal names it. Without a bound seam, the pass MUST
return at once.

#### Scenario: The link pass runs before the run

- **GIVEN** a bound seam and a plan whose packages the pool holds
- **WHEN** the launch runs
- **THEN** every named package links into the farm before the first sandbox action

#### Scenario: A pool miss refuses the launch

- **GIVEN** a plan that names a package the pool does not hold
- **WHEN** the launch runs
- **THEN** the launch refuses with the missing spellings, and no run starts

#### Scenario: No seam means no pass

- **GIVEN** no bound farm-extension seam
- **WHEN** the launch runs
- **THEN** the link pass returns at once, and the launch continues

#### Scenario: A prefixed entry reaches the seam with its track

- **GIVEN** a plan whose steps name `python:igraph` and `r:igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives two queries with the spelling `igraph`, one with the track `python` and one with the track `r`

#### Scenario: Equal queries make one request

- **GIVEN** a plan whose steps name `scanpy` two times
- **WHEN** the link pass runs
- **THEN** the seam receives one query with the spelling `scanpy`

#### Scenario: A bare entry beside a qualified entry keeps its own refusal

- **GIVEN** a plan whose steps name `python:igraph` and `igraph`, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, and the launch refuses on the bare one with `python:igraph` and `r:igraph` in the message

#### Scenario: Two spellings of one fold make two requests

- **GIVEN** a plan whose steps name `decoupler` and `decoupleR`, both bare
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, `decoupler` and `decoupleR`, each with no track

#### Scenario: A collision refusal names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the launch refuses, and the message names the two store directories, `python:igraph`, and `r:igraph`

### Requirement: Validation rejections are recorded

A rejecting `submit_plan` SHALL record each rejection at `debug` through the tool's `Logger`,
carrying the issue count and the issues themselves.

A rejection is the direct evidence of why plan generation is struggling, and it is otherwise
unrecoverable: the issue list is handed to the model and then discarded. Since the planner's tool
surface is the terminal set alone, a rejected submit is the only validation feedback it ever
receives, and each one costs a real iteration out of a bounded budget. A planner that exhausts
that budget is otherwise indistinguishable from one that never tried.

The issues are already structured (`path`, `code`, `message`) and already model-facing, so
recording them exposes nothing the conversation transcript does not hold.

#### Scenario: A rejecting submit records its issues

- **GIVEN** a planner that calls `submit_plan` with a plan that fails re-validation
- **WHEN** the tool returns `{accepted: false, issues}`
- **THEN** a record is written at `debug` carrying the issue count and the issues

#### Scenario: An accepted plan records no rejection

- **GIVEN** a planner whose first `submit_plan` call validates
- **WHEN** the tool returns `{accepted: true, plan}`
- **THEN** no rejection record is written

### Requirement: The planner prompt states the cross-step feature-selection rule

The Translational Considerations of the planner prompt MUST state the
two-clause leakage rule beside the biomarker-evaluation guidance. Clause one:
a feature list from a supervised contrast on the same samples is already a
selection. Clause two: the modeling step MUST select again inside
cross-validation, from the full feature matrix. If it cannot, the plan MUST
demand that the step reports the estimate as optimistic.

#### Scenario: A biomarker plan does not chain a full-cohort contrast into a panel

- **WHEN** the planner writes a plan with a differential-expression step and a
  later biomarker-panel step over the same samples
- **THEN** the plan instructs the modeling step to select features again
  inside cross-validation, or to report the estimate as optimistic

### Requirement: Each plan step can carry a grounding

The planner output schema MUST accept an optional `grounding` object on each step. The description of the field MUST tell the planner to fill it from the answer of `knowledge_recommend` when that tool is attached, and to omit it otherwise. Phase 0 MUST validate the shape only.

#### Scenario: A grounded plan persists the field

- **GIVEN** a submitted plan whose steps carry a grounding
- **WHEN** the plan is persisted and loaded
- **THEN** each step carries its grounding unchanged

### Requirement: The planner submits through tools that do not end its run

The planner MUST declare its search tools first and the terminal tools `submit_plan`, `request_clarification`, and `report_blocker` last. `submit_plan` checks a candidate and gives back the accepted plan or the structured issues. A candidate that arrives as a JSON-encoded string MUST be decoded before the check. No terminal tool ends the run, and no terminal tool writes to the database.

#### Scenario: A refused candidate gets its issues

- **WHEN** the planner submits a candidate that fails the check
- **THEN** the call gives back the issues, and the planner can submit again

#### Scenario: A plan that arrives as a JSON-encoded string

- **WHEN** the planner submits a valid plan as a JSON-encoded string
- **THEN** the call decodes it and gives back the accepted plan

#### Scenario: The knowledge tools ride with the search tools

- **GIVEN** a `GeneratePlanDeps` with a knowledge client
- **WHEN** the planner tools are built
- **THEN** the list holds `knowledge_recommend` and `knowledge_check` before the terminal tools

### Requirement: The tool persists the selected plan after the run

After the run, `generate_plan` MUST select the outcome: the last accepted plan, else the last clarification, else the first blocker. It MUST persist an accepted plan once, under an id that a rerun gives again. The host MUST fill the snapshot and the template of each step from the knowledge answer of the run. The model does not copy them.

#### Scenario: A rerun persists no second plan

- **WHEN** the persist of a selected plan runs two times for the same call
- **THEN** the database holds one plan for that call

#### Scenario: The host fills the grounding

- **GIVEN** a run whose `knowledge_recommend` answer named a snapshot and a template
- **WHEN** the plan persists
- **THEN** each grounded step carries that snapshot and that template, whatever the candidate held

### Requirement: The planner run is capped, with one salvage request

The planner run MUST have a step cap that `PLANNER_MAX_ITERATIONS` owns. When the run ends with no outcome, and it was not aborted, one salvage request MUST follow. Only the terminal tools can run in it. When the salvage gives no outcome, the tool returns an `error` event that states that the planner produced no outcome.

#### Scenario: A salvage after the cap

- **WHEN** the planner reaches its cap with no outcome
- **THEN** one salvage request follows, and only `submit_plan`, `request_clarification`, and `report_blocker` can run in it

### Requirement: generate_plan shows the card of the plan that it makes

When the planner of `generate_plan` ends with an accepted plan, the tool MUST emit one `data-plan` part for that plan, with the provenance of the caller. It MUST build the card from the result of the planner, with no read of the plan store, thus a replay gives the same card under the same id. Any other outcome MUST emit no plan card.

#### Scenario: A completed plan shows its card

- **WHEN** `generate_plan` ends with `plan_complete` for the plan `pln-1a2b3c4d`
- **THEN** the call emits one `data-plan` part whose `planId` is `pln-1a2b3c4d`
- **AND** the part carries the provenance of the conversation agent

#### Scenario: A blocker shows no card

- **WHEN** the planner reports a blocker
- **THEN** `generate_plan` emits no `data-plan` part

### Requirement: show_plan shows an earlier plan again

The conversation prompt and the description of `show_plan` MUST NOT tell the agent to show a new plan with `show_plan`, because `generate_plan` shows it. `show_plan` shows a stored plan again.

#### Scenario: The prompt has no show step after a new plan

- **WHEN** the conversation prompt and the `show_plan` description are read
- **THEN** neither tells the agent to call `show_plan` for the plan that `generate_plan` just made

### Requirement: The planner reads the workspace and writes nothing

The planner MUST declare the read tools of the workspace after its search tools: `read_file`, `list_files`, `file_stat`, `grep`, `workspace_search` when an embedding provider is bound, and `inspect_data_profile`. `read_table` and `read_pdf` MUST be script tools of `run_script`. The planner MUST hold no tool that writes. A paper or a protocol that the user staged can decide the steps of a plan.

#### Scenario: The planner holds the read tools

- **WHEN** the tools of the planner are resolved
- **THEN** they hold `read_file` and `inspect_data_profile`, and no `write_file`
- **AND** the script tools are `read_table` and `read_pdf`
