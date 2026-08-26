# Design: block-capped-out-empty-steps

## Context

The step body reads the blocker holder at `src/workflows/sandbox-step.ts:745`,
and it walks the artifact tree at `:799-809`, after the branch. Thus the
branch cannot see the manifest today. The walk is wrapped in `safeRunValue`,
and it is not a `DBOS.runStep`. The loop already returns `finishReason` and
`hitMaxSteps`, and the mark-complete write persists them.

## Goals / Non-Goals

**Goals:**

- A capped-out step with an empty manifest terminates `blocked`, and its
  dependents do not run.
- A step that finishes on its own initiative keeps the current contract. No
  artifact-count inference applies to it.

**Non-Goals:**

- No failure taxonomy work. That is roadmap item 24.
- No salvage of a failed step. That is roadmap item 31.
- No deadline or budget exit. Those are roadmap items 27 and 47.

## Decisions

- **Hoist the walk above the blocked branch.** The predicate needs the
  manifest, and the walk is inline, thus the hoist shifts no DBOS function
  id. The blocker path then pays one extra directory walk, which is a
  host-side read.
- **Route into the existing branch, not a new one.** The capped-out empty
  case reuses the `mark-blocked` step, the `blocked_reason` column and the
  `data-step-blocked` part. A second terminal path would double the surface
  that the parent and the readers must understand.
- **The reason is deterministic prose, not model output.** The branch writes
  a fixed reason that names the cap and the empty manifest. The summarizer
  does not run, because the model loop is what just capped out.
- **The predicate is `hitMaxSteps` and an empty manifest, and no blocker.**
  An agent that called `report_blocker` keeps its own reason. A capped-out
  step with artifacts stays `completed`, because partial output is real
  output, and the summary reports it.

## Risks / Trade-offs

- [An in-flight capped-out child replays across the deploy and takes the new
  branch] → DBOS raises a step mismatch on that narrow class. The run then
  blocks its dependents, which is the intended correction. Accepted, and the
  proposal marks it.
- [A legitimate empty step that hits the cap on its last iteration blocks] →
  Correct by contract. The deliverable of a step is its persisted files, per
  `src/prompts/sandbox-standards.ts:141-142`.

## Migration Plan

- Land the spec delta and the branch in one commit.
- No data migration. The `blocked` status and its column exist.
- Rollback is a revert. A step that blocked under the new rule stays
  `blocked` in the ledger, which stays a true record.
