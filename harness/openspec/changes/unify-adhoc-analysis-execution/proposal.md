## Why

The turn-scoped ephemeral executor frequently reaches its short deadline, blocks
the conversation while it runs, and cannot persist the files that make an
analysis useful or reproducible. Targeted computational requests should use the
same durable, writable, observable execution path as approved plans without
making the user approve a synthetic one-step plan.

## What Changes

- **BREAKING**: replace `execute_plan` and `run_ephemeral` with the unified
  `execute_analysis` conversation tool and a flat, explicit mode:
  approved stored plans continue to launch by `planId`, while an ad hoc request
  launches one mechanically constructed analysis step from the user's request.
- Treat an explicit user request to run a computation as consent for an ad hoc
  launch. The conversation agent must ask before launching computation it merely
  believes would improve its answer; no additional plan-card approval is added.
- Route each ad hoc request with a bounded utility-model call that selects from
  the plannable specialist catalog and independently recommends step resources
  within the configured bounds. Invalid, absent, timed-out, or failed decisions
  fall back deterministically; `scientific-executor` is fallback-only.
- Persist the routing decision in an internal one-step plan and run it through
  the ordinary durable analysis lifecycle: writable sandbox, artifacts,
  summaries, run tracking, machine-budget enforcement, authorization, recovery,
  billing, cancellation, and pull-based result inspection.
- Make synthesis a replay-stable per-run input and disable it for ad hoc runs, so
  an ad hoc run has exactly one visible execution step. Approved plan execution
  retains synthesis.
- Define invocation-level idempotency: duplicate delivery of one tool call
  resolves to one run/workflow, while a deliberate second tool call creates a
  new run even when the request text is identical.
- **BREAKING**: remove `run_ephemeral`, the ephemeral workflow/agent/prompt,
  read-only ephemeral sandbox path, `ResourcePolicy.ephemeral`, and the
  embedder's ephemeral resource configuration. Retain only the migration
  handling needed to settle legacy ephemeral workflow state safely.
- Require a harness-owned utility provider/model input. Embedders resolve and
  supply it under the same contract as their conversation and sandbox models;
  the CLI adds a `models.agents.utility` tier with the same fallback,
  validation, live-switching, and status behavior as the existing tiers.

## Capabilities

### New Capabilities

- `adhoc-analysis-execution`: consent, routing, internal one-step plan
  construction, fallback behavior, durable launch semantics, and the boundary
  between ad hoc and approved-plan execution.

### Modified Capabilities

- `harness-durable-runtime`: remove the turn-scoped ephemeral workflow and make
  ad hoc computation use the recoverable analysis workflow, including safe
  treatment of legacy ephemeral state.
- `harness-tools`: expose a stable request-scoped invocation identity so durable
  tool launches can distinguish duplicate delivery from a new agent call.
- `agent-roster`: remove the ephemeral agent and constrain ad hoc selection to
  plannable specialists with `scientific-executor` as fallback only.
- `harness-sandbox-agents`: remove the ephemeral sandbox-agent definition while
  preserving the normal writable specialist execution contract.
- `resource-budgeted-scheduling`: remove ephemeral resource policy and define
  bounded utility-model recommendations plus ordinary scheduler enforcement for
  the generated step.
- `run-state-persistence`: reserve ad hoc runs idempotently by invocation-derived
  identity while preserving deliberate re-execution semantics.
- `step-execution-tracking`: snapshot synthesis enablement in workflow input and
  omit the synthesis row for ad hoc runs.
- `workflow-failure-lifecycle`: generalize launch/finalization language from
  `executePlan` and preserve successful one-step completion when synthesis is
  disabled.

## Impact

- Harness tool/API surface, tool context, runtime composition, model/provider
  dependencies, agent catalog, analysis launcher, workflow input, resource
  policy, run reservation, and legacy ephemeral cleanup.
- Removal of ephemeral source modules and tests; additions for ad hoc routing,
  structured-output validation, fallbacks, replay, invocation idempotency, and
  one-step artifact persistence.
- CLI composition and configuration require a coordinated subsystem-local
  change for the utility model tier and removal of ephemeral resource wiring.
- Existing approved plans and running analysis workflows retain their current
  behavior. Rollout must account for legacy persisted ephemeral workflows before
  deleting their registration and cleanup path.
