# Design: add-statistics-rules-to-skill-packs

## Context

The packs are the runtime knowledge of the sandbox agents
(`agent-skill-assignment` spec). `validateAgentSkills` reads only if each
`SKILL.md` is readable. It never reads the prose. Thus a statistical rule
exists only where a pack states it, and only for an agent whose roster grants
that pack. Four rules are absent or unreachable today. The proposal names them
with `file:line` references.

## Goals / Non-Goals

**Goals:**

- The immune agent can reach the cutpoint correction rule, and its own pack
  states the immune-specific application.
- The planner and the statistical-modeling pack both state the cross-step
  feature-selection rule.
- The bulk-transcriptomics pack refuses inferential differential expression
  with no biological replication.
- The statistical-modeling pack names the remedy for a violated Cox
  proportional-hazards assumption.

**Non-Goals:**

- No code-enforced acceptance gate. That is roadmap item 46, parked.
- No change to `validateAgentSkills`. Review stays the control for prose.
- No new pack. The 20-pack inventory of `agent-skill-assignment` stays.

## Decisions

- **Roster grant plus a pack section, not a copy of the full rule.** The
  immune agent gets `statistical-modeling` in `meta.skills`, thus the
  canonical cutpoint rule and its API references become searchable. The
  immune pack gets a short Statistics section that states the immune-specific
  application: BH FDR over 10 to 64 score-by-condition comparisons, and the
  corrected p-value for a cutpoint. A full copy was rejected, because a copy
  drifts. Prompt-pack drift is the exact failure mode of roadmap item 29.
- **The leakage rule lives in two layers.** The planner chains the steps,
  thus the planner prompt must state the rule at plan time. The
  statistical-modeling pack executes the modeling step, thus the pack must
  state the same rule at execution time. One layer alone leaves a hole: a
  plan can arrive from a prior run, and a pack rule cannot reshape a plan.
- **The replication floor mirrors the chromatin pack wording.** The
  chromatin pack already names a single-replicate analysis an anti-pattern
  (`skills/chromatin-regulation/SKILL.md:126-128`). The bulk pack uses the
  same shape: a decision-tree bound plus an anti-pattern entry. The floor is:
  if no group has biological replication, report descriptive fold changes
  only, and state why.
- **The prompt Skills line is corrected in the same pass.** The immune
  prompt names two packs, and `meta.skills` holds three. The roster edit
  touches the file pair anyway, and the prompt-cache prefix invalidates one
  time either way.

## Risks / Trade-offs

- [The roster entry and the prompt edits invalidate two prompt-cache
  prefixes] → The cost is one cache write for each agent, one time. No
  durable state changes.
- [The `statistical-modeling` pack widens the search surface of the immune
  agent] → The pack covers the survival and panel work of this agent. The
  bulk agent roster does not change.
- [A prose rule binds only through review] → Accepted. The spec records the
  rule, thus a later review has a target. Code enforcement is item 46.
