# Phase 0 campaign `head-to-head`

Judge: claude-sonnet-5 (tag sonnet).

Runs: 48. Judge verdicts: 48. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 24 | 96% | 88.8 | 8.4 | 94% | 100% | 75% | 97% | 586/586 | 0 (0) | 92% | 18.6 | 1500357 | 8979 | 1307147 | 118 |
| without--claude-opus-5 | 24 | 100% | 90.3 | 1.5 | 99% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 3.1 | 98567 | 7117 | 24206 | 95 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 9.2 | 9.1 | 8.4 | 9.2 | 8.9 | 8.9 | 7.9 | 9.4 |
| without--claude-opus-5 | 9.3 | 9.0 | 8.7 | 9.3 | 9.1 | 8.7 | 8.9 | 9.3 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: no judged pair of arms
- claude-opus-5: no judged pair of arms

## Contrast of two arms, paired by task (with--claude-sonnet-5 minus without--claude-opus-5)

- difference -1.5 points over 8 tasks, 95% bootstrap interval [-13.0, 8.2], margin 5: not shown

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 91 | 4/4 | 0/0/5 | 0 | 2 | 0 | 16293 | 230.5 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 96 | 4/4 | 7/0/0 | 27 (27 resolve) | 1 | 1 | 6840 | 68.5 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 3 | plan_submitted | 98 | 4/4 | 5/0/0 | 28 (28 resolve) | 1 | 0 | 5663 | 63.5 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 96 | 4/4 | 6/1/0 | 27 (27 resolve) | 1 | 0 | 6401 | 72 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 94 | 4/4 | 7/1/0 | 24 (24 resolve) | 1 | 3 | 9828 | 106.7 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 3 | plan_submitted | 93 | 4/4 | 7/1/0 | 24 (24 resolve) | 1 | 3 | 9003 | 100.2 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 29 (29 resolve) | 1 | 4 | 9591 | 116.3 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 93 | 4/4 | 5/0/0 | 32 (32 resolve) | 1 | 4 | 20866 | 410.8 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 3 | plan_submitted | 98 | 4/4 | 6/1/0 | 27 (27 resolve) | 1 | 0 | 8025 | 91.9 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 83 | 5/6 | 5/1/0 | 15 (15 resolve) | 1 | 3 | 8644 | 103.8 | must not match /Wald test/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 86 | 4/6 | 5/1/0 | 17 (17 resolve) | 1 | 1 | 7308 | 115.5 | must not match /FDR < 0\.05/; must not match /Wald test/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 3 | plan_submitted | 89 | 6/6 | 6/1/0 | 14 (14 resolve) | 1 | 2 | 6662 | 64.6 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 96 | 3/3 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 6610 | 103.8 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 96 | 3/3 | 6/0/0 | 31 (31 resolve) | 1 | 1 | 7222 | 94.4 |  |
| with--claude-sonnet-5 | paired-n5 | 3 | plan_submitted | 96 | 3/3 | 7/0/0 | 33 (33 resolve) | 1 | 4 | 10719 | 113.7 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | clarification_needed | 0 | 0/3 | 0/0/0 | 0 | 1 | 0 | 1117 | 33.8 | must match /(likelihood ratio|LRT|reduced model|interaction|spline)/; must match /time/; must match /DESeq2|edgeR|limma/ |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 76 | 3/3 | 9/0/0 | 24 (24 resolve) | 1 | 2 | 10155 | 119.3 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 3 | plan_submitted | 94 | 3/3 | 4/1/0 | 31 (31 resolve) | 1 | 0 | 14658 | 225.6 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 96 | 5/5 | 6/1/0 | 28 (28 resolve) | 2 | 3 | 9871 | 118.1 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 96 | 5/5 | 5/1/0 | 29 (29 resolve) | 1 | 1 | 7554 | 112.4 |  |
| with--claude-sonnet-5 | two-group-n3 | 3 | plan_submitted | 98 | 5/5 | 7/1/0 | 29 (29 resolve) | 1 | 4 | 11386 | 134.1 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 93 | 6/6 | 6/0/0 | 31 (31 resolve) | 1 | 1 | 6621 | 77.9 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 94 | 6/6 | 6/0/0 | 29 (29 resolve) | 1 | 1 | 6641 | 77.1 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 3 | plan_submitted | 84 | 6/6 | 6/1/0 | 25 (25 resolve) | 1 | 3 | 7818 | 82 |  |
| without--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 98 | 4/4 | 0/0/3 | 0 | 0 | 0 | 4434 | 61.4 |  |
| without--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 98 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6054 | 84.9 |  |
| without--claude-opus-5 | batch-balanced-n6 | 3 | plan_submitted | 99 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6211 | 83.6 |  |
| without--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 95 | 4/4 | 0/0/4 | 0 | 0 | 0 | 5963 | 87.3 |  |
| without--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 94 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6273 | 87.5 |  |
| without--claude-opus-5 | confounded-batch-n6 | 3 | plan_submitted | 95 | 4/4 | 0/0/4 | 0 | 0 | 0 | 7241 | 103.5 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 0/0/5 | 0 | 0 | 0 | 15531 | 177.4 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 93 | 4/4 | 0/0/5 | 0 | 0 | 0 | 7109 | 95.4 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 3 | plan_submitted | 93 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6681 | 89.2 |  |
| without--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 60 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5090 | 70 |  |
| without--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 61 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4939 | 68.8 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | no-replicates-1v1 | 3 | plan_submitted | 66 | 5/6 | 0/0/2 | 0 | 0 | 0 | 4415 | 63.7 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | paired-n5 | 1 | plan_submitted | 98 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6265 | 87.2 |  |
| without--claude-opus-5 | paired-n5 | 2 | plan_submitted | 96 | 3/3 | 0/0/4 | 0 | 0 | 0 | 11681 | 139 |  |
| without--claude-opus-5 | paired-n5 | 3 | plan_submitted | 96 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6585 | 92.8 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 93 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5930 | 81.6 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 91 | 3/3 | 0/0/5 | 0 | 0 | 0 | 7621 | 106.3 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 3 | plan_submitted | 90 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5400 | 73.6 |  |
| without--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 96 | 5/5 | 0/0/4 | 0 | 0 | 0 | 13740 | 160.7 |  |
| without--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 95 | 5/5 | 0/0/5 | 0 | 0 | 0 | 7221 | 101.4 |  |
| without--claude-opus-5 | two-group-n3 | 3 | plan_submitted | 94 | 5/5 | 0/0/3 | 0 | 0 | 0 | 6054 | 85.8 |  |
| without--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 91 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7639 | 106.7 |  |
| without--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 89 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6733 | 90 |  |
| without--claude-opus-5 | two-group-n6-enrich | 3 | plan_submitted | 90 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5988 | 84.5 |  |
