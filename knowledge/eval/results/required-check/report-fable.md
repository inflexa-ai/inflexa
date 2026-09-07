# Phase 0 campaign `required-check`

Judge: claude-fable-5-1 (tag fable).

Runs: 3. Judge verdicts: 3. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 3 | 100% | 81.7 | 0.0 | 100% | 100% | 100% | 100% | 54/54 | 0 (0) | 100% | 7.0 | 469695 | 6634 | 275206 | 74 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 8.3 | 8.7 | 8.3 | 8.7 | 7.7 | 7.7 | 8.0 | 8.0 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: no judged pair of arms

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | classifier-n60 | 1 | plan_submitted | 71 | 7/7 | 4/1/0 | 34 (34 resolve) | 2 | 1 | 7291 | 84.6 |  |
| with--claude-sonnet-5 | coexpression-n60 | 1 | plan_submitted | 83 | 7/7 | 4/0/0 | 11 (11 resolve) | 1 | 1 | 6834 | 75.4 |  |
| with--claude-sonnet-5 | survival-n60 | 1 | plan_submitted | 91 | 7/7 | 5/0/0 | 9 (9 resolve) | 1 | 1 | 5778 | 61.8 |  |
