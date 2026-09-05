# Phase 0 campaign `sonnet-r2`

Runs: 32. Judge verdicts: 32. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 16 | 100% | 93.6 | 1.3 | 100% | 100% | 100% | 100% | 431/431 | 0 (0) | 100% | 18.3 | 1568709 | 9428 | 1394407 | 122 |
| without--claude-sonnet-5 | 16 | 81% | 55.5 | 11.0 | 79% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 41.6 | 6073917 | 5491 | 5861168 | 167 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 9.8 | 9.1 | 9.5 | 9.9 | 9.7 | 9.6 | 7.6 | 9.7 |
| without--claude-sonnet-5 | 6.9 | 6.1 | 4.1 | 6.7 | 6.0 | 4.8 | 4.4 | 5.5 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: difference 38.1 points over 8 tasks, 95% bootstrap interval [25.2, 56.7], margin 5: non-inferior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 95 | 4/4 | 5/0/0 | 28 (28 resolve) | 1 | 3 | 7311 | 81.3 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 95 | 4/4 | 7/0/0 | 28 (28 resolve) | 1 | 1 | 8142 | 92.1 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 96 | 4/4 | 5/1/0 | 24 (24 resolve) | 1 | 2 | 8412 | 96.9 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 91 | 4/4 | 6/1/0 | 28 (28 resolve) | 1 | 2 | 8825 | 88 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 94 | 4/4 | 7/0/0 | 34 (34 resolve) | 1 | 1 | 6683 | 66.6 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 95 | 4/4 | 6/0/0 | 24 (24 resolve) | 1 | 4 | 13927 | 237.8 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 79 | 6/6 | 6/1/0 | 12 (12 resolve) | 1 | 2 | 11283 | 99.6 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 83 | 6/6 | 5/1/0 | 16 (16 resolve) | 2 | 2 | 11670 | 123.7 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 95 | 3/3 | 6/0/0 | 29 (29 resolve) | 1 | 1 | 6999 | 71 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 96 | 3/3 | 6/0/0 | 27 (27 resolve) | 1 | 1 | 7187 | 85.5 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 94 | 3/3 | 7/0/0 | 31 (31 resolve) | 1 | 1 | 8332 | 96.2 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 96 | 3/3 | 8/1/0 | 31 (31 resolve) | 1 | 4 | 18927 | 453.4 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 96 | 5/5 | 6/0/0 | 30 (30 resolve) | 2 | 4 | 10564 | 119.7 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 96 | 5/5 | 7/0/0 | 32 (32 resolve) | 1 | 3 | 10001 | 111.3 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 98 | 6/6 | 5/0/0 | 29 (29 resolve) | 1 | 1 | 6135 | 64.2 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 99 | 6/6 | 5/0/0 | 28 (28 resolve) | 1 | 1 | 6453 | 66.5 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 74 | 4/4 | 0/0/2 | 0 | 0 | 0 | 2544 | 31.4 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 84 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2848 | 34.7 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 56 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2138 | 26.3 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 61 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2123 | 23.8 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 91 | 4/4 | 0/0/3 | 0 | 0 | 0 | 19626 | 596.3 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | error | 0 | 0/4 | 0/0/0 | 0 | 0 | 0 | 14356 | 600.1 | must match /interaction/; must match /genotype/; must match /treatment/; must match /DESeq2|edgeR|limma/ |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 45 | 5/6 | 0/0/3 | 0 | 0 | 0 | 3388 | 66.3 | must match /(descriptive|fold change)/ |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 56 | 5/6 | 0/0/3 | 0 | 0 | 0 | 2399 | 27.6 | must match /(descriptive|fold change)/ |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 74 | 3/3 | 0/0/2 | 0 | 0 | 0 | 2071 | 25.5 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 71 | 3/3 | 0/0/2 | 0 | 0 | 0 | 2433 | 30.6 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | clarification_needed | 0 | 0/3 | 0/0/0 | 0 | 0 | 0 | 11046 | 488.1 | must match /(likelihood ratio|LRT|reduced model|interaction|spline)/; must match /time/; must match /DESeq2|edgeR|limma/ |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | error | 0 | 0/3 | 0/0/0 | 0 | 0 | 0 | 11826 | 600.1 | must match /(likelihood ratio|LRT|reduced model|interaction|spline)/; must match /time/; must match /DESeq2|edgeR|limma/ |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 74 | 5/5 | 0/0/4 | 0 | 0 | 0 | 2334 | 26.5 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 71 | 5/5 | 0/0/3 | 0 | 0 | 0 | 2880 | 36.2 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 66 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3366 | 36.9 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 64 | 6/6 | 0/0/4 | 0 | 0 | 0 | 2477 | 27.6 |  |
