# Phase 0 campaign `wider-check`

Judge: claude-fable-5-1 (tag fable).

Runs: 14. Judge verdicts: 14. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 14 | 100% | 81.2 | 0.0 | 100% | 93% | 93% | 85% | 295/296 | 0 (0) | 93% | 13.6 | 1099529 | 7767 | 928503 | 97 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 8.1 | 8.0 | 7.9 | 8.3 | 8.1 | 7.8 | 8.8 | 8.0 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: no judged pair of arms

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | classifier-n60 | 1 | plan_submitted | 76 | 7/7 | 4/0/1 | 32 (32 resolve) | 1 | 2 | 9389 | 108.6 |  |
| with--claude-sonnet-5 | clustering-n60 | 1 | plan_submitted | 81 | 7/7 | 5/0/0 | 12 (12 resolve) | 1 | 1 | 7131 | 80.3 |  |
| with--claude-sonnet-5 | coexpression-n60 | 1 | plan_submitted | 78 | 7/7 | 3/1/1 | 22 (22 resolve) | 1 | 1 | 9711 | 125.1 |  |
| with--claude-sonnet-5 | coexpression-too-few-n3 | 1 | plan_submitted | 93 | 6/6 | 5/0/0 | 18 (17 resolve) | 1 | 4 | 11257 | 121.4 |  |
| with--claude-sonnet-5 | de-plus-tf-activity-n6 | 1 | plan_submitted | 88 | 7/7 | 3/0/1 | 32 (32 resolve) | 1 | 1 | 6778 | 74.4 |  |
| with--claude-sonnet-5 | deconvolution-mouse-n6 | 1 | plan_submitted | 89 | 7/7 | 2/0/0 | 20 (20 resolve) | 2 | 2 | 10599 | 143.9 |  |
| with--claude-sonnet-5 | deconvolution-tpm-n6 | 1 | plan_submitted | 83 | 8/8 | 2/0/0 | 11 (11 resolve) | 1 | 4 | 8408 | 98.1 |  |
| with--claude-sonnet-5 | pathway-activity-n6 | 1 | plan_submitted | 91 | 7/7 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 8937 | 226.2 |  |
| with--claude-sonnet-5 | signature-scores-n6 | 1 | plan_submitted | 85 | 7/7 | 5/0/0 | 10 (10 resolve) | 1 | 1 | 6178 | 61.6 |  |
| with--claude-sonnet-5 | survival-n60 | 1 | plan_submitted | 78 | 7/7 | 4/0/1 | 10 (10 resolve) | 2 | 1 | 4922 | 53.1 |  |
| with--claude-sonnet-5 | tf-activity-n6 | 1 | plan_submitted | 93 | 7/7 | 3/0/1 | 28 (28 resolve) | 1 | 1 | 8276 | 85.9 |  |
| with--claude-sonnet-5 | tf-activity-python-n6 | 1 | plan_submitted | 86 | 8/8 | 3/0/1 | 30 (30 resolve) | 1 | 2 | 8654 | 95.5 |  |
| with--claude-sonnet-5 | transcript-usage-n6 | 1 | clarification_needed | 33 | 6/6 | 0/0/0 | 0 | 0 | 0 | 492 | 9.9 |  |
| with--claude-sonnet-5 | variance-partition-n6 | 1 | plan_submitted | 85 | 7/7 | 4/0/1 | 37 (37 resolve) | 1 | 2 | 8005 | 77.5 |  |
