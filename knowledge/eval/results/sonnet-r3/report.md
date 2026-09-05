# Phase 0 campaign `sonnet-r3`

Judge: claude-opus-5.

Runs: 32. Judge verdicts: 32. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 16 | 100% | 92.4 | 1.4 | 99% | 100% | 63% | 100% | 441/441 | 0 (0) | 100% | 17.3 | 1303332 | 9436 | 1108991 | 115 |
| without--claude-sonnet-5 | 16 | 100% | 65.7 | 3.9 | 99% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 11.6 | 765682 | 4535 | 651415 | 84 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 9.3 | 9.1 | 9.1 | 9.8 | 9.6 | 9.3 | 8.1 | 9.6 |
| without--claude-sonnet-5 | 8.2 | 6.9 | 4.6 | 7.5 | 7.4 | 6.1 | 5.3 | 6.6 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: difference 26.7 points over 8 tasks, 95% bootstrap interval [19.7, 32.3], margin 5: non-inferior

## Contrast of two arms, paired by task (with--claude-sonnet-5 minus without--claude-sonnet-5)

- difference 26.7 points over 8 tasks, 95% bootstrap interval [19.7, 32.3], margin 5: non-inferior, and superior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 30 (30 resolve) | 1 | 0 | 15225 | 185.4 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 96 | 4/4 | 7/0/0 | 29 (29 resolve) | 1 | 1 | 6568 | 73 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 91 | 4/4 | 6/1/0 | 29 (29 resolve) | 1 | 1 | 8622 | 88.7 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 91 | 4/4 | 4/1/0 | 29 (29 resolve) | 1 | 0 | 15228 | 192.7 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 96 | 4/4 | 7/0/0 | 28 (28 resolve) | 1 | 1 | 8515 | 90.1 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 96 | 4/4 | 6/0/0 | 29 (29 resolve) | 1 | 0 | 14806 | 176.6 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 79 | 6/6 | 5/1/0 | 17 (17 resolve) | 1 | 2 | 6687 | 75.4 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 81 | 5/6 | 4/2/0 | 18 (18 resolve) | 2 | 2 | 8976 | 111.1 | must not match /Wald test/ |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 98 | 3/3 | 5/0/0 | 29 (29 resolve) | 1 | 1 | 7446 | 110.4 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 95 | 3/3 | 5/0/0 | 29 (29 resolve) | 1 | 0 | 5810 | 61.3 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 83 | 3/3 | 7/0/0 | 28 (28 resolve) | 1 | 4 | 13134 | 205.7 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 90 | 3/3 | 7/0/0 | 26 (26 resolve) | 1 | 0 | 6532 | 82.2 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 95 | 5/5 | 5/0/0 | 30 (30 resolve) | 1 | 1 | 8012 | 113 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 94 | 5/5 | 7/0/0 | 29 (29 resolve) | 1 | 1 | 6865 | 90.1 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 99 | 6/6 | 6/0/0 | 31 (31 resolve) | 1 | 1 | 12234 | 116.9 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 98 | 6/6 | 7/0/0 | 30 (30 resolve) | 1 | 0 | 6311 | 63.6 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 78 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2260 | 26.8 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 71 | 4/4 | 0/0/4 | 0 | 0 | 0 | 2639 | 33.8 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 64 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2695 | 31.2 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 73 | 4/4 | 0/0/4 | 0 | 0 | 0 | 3364 | 38.7 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 65 | 4/4 | 0/0/3 | 0 | 0 | 0 | 3556 | 49.7 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 56 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2167 | 23.9 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 45 | 6/6 | 0/0/2 | 0 | 0 | 0 | 12333 | 370.6 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 44 | 5/6 | 0/0/5 | 0 | 0 | 0 | 4098 | 63.9 | must not match /FDR < 0\.05/ |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 64 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2255 | 25.1 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 65 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5387 | 50.9 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 85 | 3/3 | 0/0/4 | 0 | 0 | 0 | 15283 | 406.6 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 75 | 3/3 | 0/0/3 | 0 | 0 | 0 | 3639 | 72 |  |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 68 | 5/5 | 0/0/4 | 0 | 0 | 0 | 3138 | 36.9 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 73 | 5/5 | 0/0/4 | 0 | 0 | 0 | 3320 | 38.4 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 65 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3954 | 45 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 63 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2478 | 34.7 |  |
