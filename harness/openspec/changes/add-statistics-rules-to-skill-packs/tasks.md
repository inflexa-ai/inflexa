# Tasks: add-statistics-rules-to-skill-packs

## 1. Immune profiling (roadmap item 1)

- [x] 1.1 Add a Statistics section to `skills/immune-profiling/SKILL.md`. Demand BH FDR over every score-by-condition comparison, and the maxstat corrected p-value for a cutpoint.
- [x] 1.2 Amend the survival-integration lines of the pack. Remove the uncorrected "median split or optimal cutpoint" recommendation.
- [x] 1.3 Add `statistical-modeling` to `skills` in `src/agents/sandbox/immune-profiling-agent.ts`.
- [x] 1.4 Correct the Skills line of `src/prompts/sandbox/immune-profiling-agent.ts` so that it names each pack of `meta.skills`.

## 2. Cross-step feature-selection leakage (roadmap item 2)

- [x] 2.1 Add the two-clause leakage rule to the Translational Considerations of `src/prompts/planner.ts`, beside the biomarker-evaluation point.
- [x] 2.2 Add the cross-step clause to the panel-development guidance of `skills/statistical-modeling/SKILL.md`.

## 3. Replication floor for bulk differential expression (roadmap item 6)

- [x] 3.1 Add the floor to the decision tree of `skills/bulk-transcriptomics/SKILL.md`. With no biological replication in any group, descriptive fold changes only.
- [x] 3.2 Add the floor to the anti-pattern list of the pack. Mirror the wording of `skills/chromatin-regulation/SKILL.md`.
- [x] 3.3 Mirror the floor in the method-selection summary of `src/prompts/sandbox/bulk-transcriptomics-agent.ts`.

## 4. Cox proportional-hazards failure path (roadmap item 20)

- [x] 4.1 Add the failure path to `skills/statistical-modeling/SKILL.md`. On a violation, stratify or add a time-varying term, and report the hazard ratio as time-averaged.

## 5. Verify

- [x] 5.1 Run `npx tsc --noEmit` in `harness/` and make sure that it is clean.
- [x] 5.2 Run `bun test src/agents/sandbox/` and make sure that the skill validation passes.
- [x] 5.3 Run `bun run format:file` on the changed `src/` files.
- [x] 5.4 Read each edited pack section against the delta spec, one requirement at a time.
