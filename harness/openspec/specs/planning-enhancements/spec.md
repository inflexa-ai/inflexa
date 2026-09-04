# planning-enhancements Specification

## Purpose

Analysis plans are produced by the `generate_plan` tool
(`src/tools/research/generate-plan.ts`), which the conversation agent calls with
structured context. The tool does not make a single structured `ChatProvider.chat`
call — it drives an internal `planner` sub-agent (`AgentDefinition`, id
`"planner"`) through `runToTerminal` (the terminal-salvage wrapper around
`runAgent`). The planner communicates results EXCLUSIVELY through tool calls; its
text reply is discarded, and the outcome is read from a closure cell that the
terminal tools write.

The planner's inner tools divide by whether they end the loop. The terminal set
is `submit_plan` (re-validate and persist), `request_clarification`, and
`report_blocker` (the planner's honest "no viable plan" exit); everything else is
non-terminal and may be called freely — `list_available_refs` (reference-store
discovery, so a step is only
committed to reference data the environment actually holds). That split, not the
size of either set, is the invariant: a plan reaches the caller through exactly
one terminal call, and non-terminal tools record no outcome. The whole
invocation is bounded by one wall-clock guard, merged with the caller's abort
signal. The guard is 600s, or the advertised provider request timeout when
larger; the planner loop is iteration-capped at 13. There is no per-attempt
timeout, no internal retry counter, and no `adaptive` thinking or `budget_tokens`
anywhere in the planning path.

## Requirements

### Requirement: Plan generation runs as an internal planner sub-agent loop

The conversation agent SHALL generate plans by calling the `generate_plan` tool,
which SHALL drive an internal `planner` `AgentDefinition` via `runToTerminal`
(wrapping `runAgent`) under a child session derived with
`forSubAgent(ctx.session, "planner")`. The planner SHALL communicate its result
only through terminal tool calls; its text reply SHALL be discarded.

#### Scenario: Conversation agent invokes generate_plan

- **WHEN** the conversation agent needs an analysis plan
- **THEN** it calls `generate_plan` with `{ dataContext, researchQuestion, priorRuns?, userConstraints?, parentPlanId? }`
- **AND** the tool runs the planner sub-agent via `runToTerminal` under a `forSubAgent` child session

#### Scenario: Planner outcome read from a closure cell

- **WHEN** the planner finishes its loop
- **THEN** the tool reads the recorded outcome from the shared closure cell, not from the planner's text reply

### Requirement: The planner separates non-terminal tools from a terminal outcome set

The planner MUST be given the terminal tools `submit_plan`,
`request_clarification`, and `report_blocker`, and non-terminal tools that
include `list_available_refs` (reference-store discovery). `submit_plan`
MUST re-validate and persist the plan, and a rejected candidate MUST return
the structured issues, thus the planner corrects the plan and submits again.
Exactly one terminal outcome MUST be recorded per invocation, and a later
terminal call MUST be rejected. A non-terminal tool records no outcome, and
the planner can call it any number of times.

#### Scenario: A rejected submit returns the issues and records no outcome

- **WHEN** the planner submits a candidate plan that fails validation
- **THEN** the call returns `{ accepted: false, issues }` and records no terminal outcome
- **AND** the planner can submit again

#### Scenario: The planner can see what reference data is staged

- **WHEN** the planner calls `list_available_refs`
- **THEN** it receives the current reference inventory and records no outcome
- **AND** the planner can ground the reference needs of a step in that result, or take a terminal `request_clarification` exit when data the analysis cannot continue without is absent

#### Scenario: submit_plan re-validates and persists

- **WHEN** the planner calls `submit_plan` with a plan that passes validation
- **THEN** the plan is persisted and the outcome is recorded as a submitted plan with its `planId`

#### Scenario: A second terminal call is rejected

- **WHEN** a terminal outcome has already been recorded and `submit_plan` is called again
- **THEN** the call is rejected and the recorded outcome is left unchanged

### Requirement: A single wall-clock guard bounds the whole invocation

The tool MUST bound the entire invocation with a single wall-clock guard,
merged with the caller's abort signal through `AbortSignal.any`. The guard value
MUST be the maximum of 600s (`PLAN_TIMEOUT_MS = 600_000`) and the
`requestTimeoutMs` that the planner provider advertises. There MUST be no
per-attempt timeout and no internal retry counter.

#### Scenario: Invocation times out

- **WHEN** plan generation exceeds the wall-clock guard
- **THEN** the planner is aborted and the tool returns an `error` event indicating a timeout

#### Scenario: A slow provider raises the guard

- **GIVEN** a planner provider that advertises a `requestTimeoutMs` above 600s
- **WHEN** the tool arms its wall-clock guard
- **THEN** the guard value is the advertised value, not 600s

#### Scenario: Caller abort cancels the planner

- **WHEN** the caller's abort signal fires
- **THEN** the planner is cancelled and the tool returns an `error` event indicating cancellation

### Requirement: The planner loop is iteration-capped with one salvage continuation

The planner loop SHALL be capped at `PLANNER_MAX_ITERATIONS = 13`. If the planner
ends without a terminal outcome, `runToTerminal` SHALL grant exactly one salvage
continuation whose only tools are the terminal tools, opened by a corrective
nudge.

#### Scenario: Salvage continuation on a missing terminal outcome

- **WHEN** the planner reaches its iteration cap without recording a terminal outcome
- **THEN** `runToTerminal` runs one salvage continuation offering only `submit_plan`, `request_clarification`, and `report_blocker`

#### Scenario: Still no outcome after salvage

- **WHEN** the salvage continuation also ends without a terminal outcome
- **THEN** the tool returns an `error` event stating the planner produced no terminal outcome

### Requirement: The tool returns a typed outcome and never throws

The tool SHALL translate the recorded outcome into a `PlanningAgentOutput` whose
`event` is one of `"plan_complete"`, `"clarification_needed"`, or `"error"`, and
SHALL return it as a data result (`ok(...)`) in every case — it SHALL NOT throw.

The tool SHALL also **record** that outcome through an injected `Logger`, exactly once per
invocation, carrying the outcome kind, the elapsed wall-clock of the invocation, and the
`analysisId`. Returning the outcome is not recording it: `generate_plan` is a conversation-layer
tool on `passthroughStep`, so it writes no ledger row and owns no durable stream, and the returned
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

### Requirement: The planner prompt carries the host resource limits

The planner system prompt's Resource Estimation guidance SHALL, when a resource
policy is supplied, be built with the concrete per-step ceilings
(`perStep.maxCpu`, `perStep.maxMemoryGb`) and the machine budget substituted
into the prompt (same injection mechanism as `{{AGENT_CATALOG}}`). The guidance
SHALL instruct the planner that no step may declare resources above the
per-step ceiling, and that concurrent steps share the machine budget so heavy
steps are better serialized via `depends_on` than fanned out. When no policy is
supplied, the existing default guidance (4 CPU / 8 GB) SHALL be used unchanged.

#### Scenario: Planner prompt carries the concrete ceilings

- **GIVEN** a policy with `perStep: { maxCpu: 4, maxMemoryGb: 8 }` and `budget: { cpu: 8, memoryGb: 16 }`
- **WHEN** the planner system prompt is assembled
- **THEN** the Resource Estimation section states the 4 CPU / 8 GB per-step ceiling and the 8 CPU / 16 GB machine budget

#### Scenario: No policy preserves the default guidance

- **GIVEN** no resource policy at the composition root
- **WHEN** the planner system prompt is assembled
- **THEN** the Resource Estimation section carries the existing default guidance

### Requirement: The plan validation enforces the per-step resource ceiling

The shared plan validation MUST, when a resource policy is supplied, report
an issue for every step whose declared `resources` exceed `perStep.maxCpu`
or `perStep.maxMemoryGb`. The issue MUST name the step, its declared values,
and the ceiling, thus the planner can resize or restructure. The check is
deterministic validation feedback, not a terminal outcome — the run-time
clamp at sandbox creation stays the backstop for plans that predate this
validation.

#### Scenario: An over-ceiling step is reported with actionable feedback

- **GIVEN** a per-step ceiling of `{ maxCpu: 4, maxMemoryGb: 8 }` and a candidate plan step that declares `{ cpu: 4, memoryGb: 16 }`
- **WHEN** the planner submits the plan
- **THEN** the submit is rejected with an issue that names the step, the declared 16 GB, and the 8 GB ceiling

#### Scenario: A plan within the ceiling passes

- **GIVEN** every step declares resources at or under the per-step ceiling
- **WHEN** the plan validates
- **THEN** no resource-ceiling issue is reported

### Requirement: Each plan step names its packages

In `PlanStepSchema`, the `packages` array MUST be a necessary field of every
planned step. Each entry MUST be a requirement: a bare name, or a name with
one exact version. An entry can carry an ecosystem prefix before the name,
`python:` or `r:`. The prefix names the track of the pool that the link
pass searches. A bare name searches both tracks. The persistence schema
MUST keep the field optional, thus a stored plan from before this change
still parses. The briefing MUST withhold the `packages` field from the
rendered task, because the link pass consumes it and a step agent must not
re-litigate it.

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

#### Scenario: A prefixed entry parses into a qualified request

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR", "scanpy", "numpy==1.26.4"]`
- **WHEN** the link pass parses the entries
- **THEN** the requests carry the ecosystems `python`, `r`, none, and none, with the names `igraph`, `decoupleR`, `scanpy`, and `numpy`

### Requirement: The plan validation refuses a package location

The shared plan validation MUST report an issue for every package entry that
names a path, a URL, or a store directory. The two callers of the validation
are the re-validation of `submit_plan` and the pre-launch re-validation of a
stored plan. The issue MUST name the step and the offending entry. An absent
`packages` array MUST pass, because the stored plans from before this change
carry none.

The validation MUST also refuse a version specifier that is not `==`. The
two permitted forms are a bare name and `name==version`. A range such as
`numpy>=1.26` otherwise becomes a package NAME, and the link pass then
refuses a package that the pool holds.

The validation MUST also refuse a prefix that is not `python:` or `r:`. An
entry such as `bioc:fgsea` otherwise becomes a package NAME, and the pool
refuses a package that it holds. The issue MUST name the two permitted
prefixes.

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
- **THEN** an issue names the step and the entry, and it names the two permitted forms

#### Scenario: A prefixed form passes

- **GIVEN** a step whose packages are `["python:igraph", "r:decoupleR==2.17.0"]`
- **WHEN** the plan validates
- **THEN** no package-form issue is reported

#### Scenario: An unknown prefix is refused

- **GIVEN** a step whose packages include `bioc:fgsea`
- **WHEN** the plan validates
- **THEN** an issue names the step and the entry, and it names `python:` and `r:` as the permitted prefixes

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
the packages of each step, and it goes into the farm of the analysis. The
union keys entries by their exact spelling, because two spellings are two
identities: `decoupler` and `decoupleR` name two packages. A prefixed
entry and a bare entry of one spelling make one request, and the request
carries the prefix. Two entries of one spelling with two prefixes make two
requests, because the plan names two packages.
The pass MUST pass the ecosystem of a prefixed entry to the seam.

A pool miss MUST refuse the launch with an error that names the missing
packages. A `collision` outcome MUST refuse the launch with an error that
names the two store directories and the two prefixed forms to write. The
harness MUST NOT name a remedy command, because the remedy belongs to the
embedder. The prefix is a plan form and not a command, thus the refusal
names it. Without a bound seam, the pass MUST return at once.

#### Scenario: The link pass runs before the run

- **GIVEN** a bound seam and a plan whose packages the pool holds
- **WHEN** the launch runs
- **THEN** every named package links into the farm before the first sandbox action

#### Scenario: A pool miss refuses the launch

- **GIVEN** a plan that names a package the pool does not hold
- **WHEN** the launch runs
- **THEN** the launch refuses with the missing names, and no run starts

#### Scenario: No seam means no pass

- **GIVEN** no bound farm-extension seam
- **WHEN** the launch runs
- **THEN** the link pass returns at once, and the launch continues

#### Scenario: A prefixed entry reaches the seam with its ecosystem

- **GIVEN** a plan whose steps name `python:igraph` and `r:igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives two requests for `igraph`, one with `ecosystem: "python"` and one with `ecosystem: "r"`

#### Scenario: A prefixed entry absorbs a bare entry of the same name

- **GIVEN** a plan whose steps name `python:igraph` and `igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives one request for `igraph`, with `ecosystem: "python"`

#### Scenario: Two spellings of one fold make two requests

- **GIVEN** a plan whose steps name `decoupler` and `decoupleR`, both bare
- **WHEN** the link pass runs
- **THEN** the seam receives two requests, `decoupler` and `decoupleR`, each with no ecosystem

#### Scenario: A collision refusal names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the launch refuses, and the message names the two store directories, `python:igraph`, and `r:igraph`

### Requirement: Resource-infeasible analyses exit via report_blocker

The planner prompt SHALL instruct the planner that an analysis that genuinely
cannot be performed within the stated resource limits — no restructuring or
downsizing yields a viable plan — MUST exit via the existing `report_blocker`
terminal tool with the resource shortfall as the reason. No new terminal tool or
outcome variant SHALL be introduced; the existing `error` outcome carries the
infeasibility to the conversation agent.

#### Scenario: An analysis that cannot fit is honestly refused

- **GIVEN** an analysis whose smallest viable step requires more memory than the per-step ceiling allows
- **WHEN** the planner concludes no viable plan exists within the limits
- **THEN** it calls `report_blocker` with a reason naming the resource shortfall, and the tool returns the `error` outcome to the conversation agent

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

- **GIVEN** a planner whose first `submit_plan` call validates and persists
- **WHEN** the tool returns `{accepted: true, planId}`
- **THEN** no rejection record is written
