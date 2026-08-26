# Proposal: block-capped-out-empty-steps

## Why

A sandbox step that hits its iteration cap with no deliverables goes green.
`src/workflows/sandbox-step.ts:905-919` writes `status: "completed"`
unconditionally, and it carries `hitMaxSteps` as metadata only. An agent that
burns 50 iterations against a broken container thus reports success. The
post-step pipeline registers an empty manifest, and the parent schedules the
dependents on nothing. A dependent then improvises, and the signed PROV chain
attests the improvisation.

This contradicts the stated contract at
`src/prompts/sandbox-standards.ts:141-142`: the deliverable of a step is its
persisted files. This is roadmap item 3, wave 1.

## What Changes

- Hoist the `walkStepArtifacts` call above the blocked branch. The call is
  inline, not a `DBOS.runStep`, thus the hoist shifts no function id.
- Route the capped-out empty case into the blocked branch. A step with
  `hitMaxSteps` and an empty manifest terminates `blocked`, with a
  deterministic reason. The `blocked` status, the `blocked_reason` column and
  the `data-step-blocked` part all exist (`src/state/init.ts:112,567`).
- **BREAKING** for one narrow replay class: an in-flight capped-out child
  that replays across the deploy takes the new branch. Its recorded step
  sequence no longer matches, and DBOS raises a step mismatch. A run that
  went green now blocks its dependents. That is the intended change.
- The rule is narrow. A step that finishes on its own initiative with no
  files and no blocker stays `completed`. Only the capped-out empty case
  blocks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-sandbox-agents`: the no-inference requirement narrows. A capped-out
  step with an empty manifest is `blocked`. A step that finished on its own
  stays exempt from artifact-count inference.

## Impact

- `src/workflows/sandbox-step.ts` — the hoist and the routed branch.
- `openspec/specs/harness-sandbox-agents/spec.md` — the narrowed requirement.
- No schema change, no new column, no new `DBOS.runStep`.
- Dependent runs: a plan whose capped-out step now blocks does not schedule
  the dependents of that step. That is the correction, not a regression.
