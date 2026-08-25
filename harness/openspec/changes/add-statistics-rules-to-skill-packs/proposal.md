# Proposal: add-statistics-rules-to-skill-packs

## Why

Four statistical defects sit in the skill packs and in the planner prompt. Each
one can change a scientific conclusion. They are items 1, 2, 6 and 20 of
`ROADMAP-2026-2027.md`, wave 1.

- `skills/immune-profiling/SKILL.md:138-140` recommends an optimal cutpoint
  with no corrected p-value. `skills/statistical-modeling/SKILL.md:155-160`
  holds the correction rule. But the roster of the immune agent
  (`src/agents/sandbox/immune-profiling-agent.ts:33`) does not grant that pack.
  Thus the agent cannot reach the rule that guards it.
- `src/prompts/planner.ts:203-208` chains a differential-expression step into a
  biomarker-panel step. No layer states that a gene list from a full-cohort
  contrast is already a feature selection on the same samples. The panel AUC
  inflates, and the panel fails external validation.
- `skills/bulk-transcriptomics/SKILL.md:21` routes `n < 3` per group to edgeR
  QLF with no lower bound. A one-against-one design then gets p-values with no
  inferential basis. Two sibling packs set a floor
  (`skills/chromatin-regulation/SKILL.md:58,126-128`,
  `skills/single-cell/SKILL.md:345-347`).
- `skills/statistical-modeling/SKILL.md:21` demands the Cox
  proportional-hazards check, and it stops there. No pack names the remedy for
  a violation.

## What Changes

- Add a Statistics section to the immune-profiling pack. It demands BH FDR over
  every score-by-condition comparison, and the maxstat corrected p-value for a
  cutpoint. Amend the survival-integration lines that recommend an uncorrected
  cutpoint.
- Add `statistical-modeling` to the roster of the immune agent. Correct the
  Skills line of the immune agent prompt, which also omits `single-cell`.
- Add the two-clause leakage rule to the Translational Considerations of the
  planner prompt, and to the statistical-modeling pack. Clause one: a feature
  list from a supervised contrast on the same samples is already a selection.
  Clause two: the modeling step must then select again inside cross-validation,
  from the full feature matrix, or report the estimate as optimistic.
- Add the replication floor to the bulk-transcriptomics decision tree and
  anti-patterns. With no biological replication in any group, refuse
  inferential differential expression, and report descriptive fold changes
  only. Mirror the floor in the agent prompt summary.
- Add the Cox failure path to the statistical-modeling pack. On a violation,
  stratify on the covariate at fault, or add a time-varying term. Report the
  hazard ratio as time-averaged.

## Capabilities

### New Capabilities

- `skill-statistics-standards`: the statistical rules that the skill packs
  state, and the roster wiring that makes each rule reachable by the agent
  that it guards.

### Modified Capabilities

- `planning-enhancements`: the planner prompt states the cross-step
  feature-selection rule beside the biomarker-evaluation guidance that it
  already carries.

## Impact

- `skills/immune-profiling/SKILL.md` — a new Statistics section, amended
  survival-integration lines.
- `skills/statistical-modeling/SKILL.md` — the cross-step leakage clause, and
  the Cox failure path.
- `skills/bulk-transcriptomics/SKILL.md` — the replication floor.
- `src/agents/sandbox/immune-profiling-agent.ts` — the roster gains
  `statistical-modeling`.
- `src/prompts/sandbox/immune-profiling-agent.ts` — the corrected Skills line.
- `src/prompts/sandbox/bulk-transcriptomics-agent.ts` — the mirrored floor.
- `src/prompts/planner.ts` — the leakage rule in Translational Considerations.
- The roster entry and the prompt edits invalidate the prompt-cache prefix of
  the two touched agents one time. Nothing else about the change is durable
  state. No schema, no database column, and no DBOS step change.
