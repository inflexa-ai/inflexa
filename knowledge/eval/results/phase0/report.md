# Phase 0 campaign `phase0`

Runs: 64. Judge verdicts: 64. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 16 | 100% | 96.4 | 0.4 | 100% | 100% | 100% | 100% | 362/362 | 0 (0) | 100% | 6.5 | 198075 | 13025 | 141750 | 154 |
| with--claude-sonnet-5 | 16 | 88% | 81.5 | 16.7 | 92% | 100% | 75% | 94% | 247/247 | 0 (0) | 81% | 53.0 | 3772113 | 11464 | 3662814 | 181 |
| without--claude-opus-5 | 16 | 100% | 85.9 | 3.0 | 98% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 3.7 | 47688 | 6351 | 30155 | 89 |
| without--claude-sonnet-5 | 16 | 100% | 67.5 | 4.6 | 98% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 20.2 | 867867 | 4838 | 825571 | 77 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 10.0 | 9.7 | 9.3 | 10.0 | 9.8 | 9.8 | 8.6 | 9.9 |
| with--claude-sonnet-5 | 8.5 | 7.9 | 8.2 | 8.3 | 8.3 | 8.5 | 7.2 | 8.3 |
| without--claude-opus-5 | 9.3 | 9.3 | 8.4 | 8.7 | 9.1 | 8.2 | 7.3 | 8.5 |
| without--claude-sonnet-5 | 8.5 | 6.8 | 5.4 | 7.5 | 6.9 | 6.8 | 5.3 | 6.9 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-opus-5: difference 10.5 points over 8 tasks, 95% bootstrap interval [7.3, 14.8], margin 5: non-inferior
- claude-sonnet-5: difference 14.0 points over 8 tasks, 95% bootstrap interval [-1.2, 25.5], margin 5: non-inferior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 24 (24 resolve) | 1 | 2 | 9987 | 116 |  |
| with--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 98 | 4/4 | 5/0/0 | 26 (26 resolve) | 1 | 1 | 10640 | 128.9 |  |
| with--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 96 | 4/4 | 4/1/0 | 23 (23 resolve) | 1 | 1 | 9605 | 119.2 |  |
| with--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 98 | 4/4 | 4/1/0 | 22 (22 resolve) | 1 | 19 | 21450 | 240.1 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 24 (24 resolve) | 1 | 1 | 12160 | 149.5 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 98 | 4/4 | 6/0/0 | 25 (25 resolve) | 1 | 1 | 21243 | 226.6 |  |
| with--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 89 | 6/6 | 3/1/0 | 15 (15 resolve) | 1 | 2 | 9370 | 116.5 |  |
| with--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 90 | 6/6 | 3/1/0 | 16 (16 resolve) | 1 | 1 | 8817 | 118.6 |  |
| with--claude-opus-5 | paired-n5 | 1 | plan_submitted | 98 | 3/3 | 5/0/0 | 23 (23 resolve) | 1 | 1 | 10905 | 134.1 |  |
| with--claude-opus-5 | paired-n5 | 2 | plan_submitted | 96 | 3/3 | 5/0/0 | 22 (22 resolve) | 1 | 1 | 9866 | 118.2 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 98 | 3/3 | 4/0/0 | 23 (23 resolve) | 1 | 1 | 18466 | 203.5 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 96 | 3/3 | 6/0/0 | 24 (24 resolve) | 1 | 1 | 11155 | 140.6 |  |
| with--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 99 | 5/5 | 4/1/0 | 24 (24 resolve) | 1 | 2 | 11918 | 140.4 |  |
| with--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 99 | 5/5 | 4/1/0 | 24 (24 resolve) | 1 | 1 | 10906 | 137.6 |  |
| with--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 98 | 6/6 | 4/1/0 | 24 (24 resolve) | 1 | 1 | 21019 | 233.2 |  |
| with--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 98 | 6/6 | 3/2/0 | 23 (23 resolve) | 1 | 1 | 10892 | 133.1 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 94 | 4/4 | 7/1/0 | 18 (18 resolve) | 2 | 4 | 17359 | 362.2 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 98 | 4/4 | 8/0/0 | 21 (21 resolve) | 1 | 1 | 6283 | 56.8 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 91 | 4/4 | 2/1/0 | 20 (20 resolve) | 1 | 2 | 22068 | 572.8 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 90 | 4/4 | 4/2/0 | 17 (17 resolve) | 1 | 2 | 7214 | 76.4 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 93 | 4/4 | 8/0/0 | 21 (21 resolve) | 1 | 1 | 12319 | 104.5 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 95 | 4/4 | 6/0/0 | 22 (22 resolve) | 1 | 1 | 6562 | 64.3 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | error | 0 | 4/6 | 0/0/0 | 0 | 3 | 155 | 53712 | 600.1 | must match /(no|without|lack of|absence of) (biological )?replicat/; must match /(descriptive|fold change)/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 80 | 6/6 | 3/2/0 | 10 (10 resolve) | 1 | 0 | 4362 | 50.1 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 96 | 3/3 | 7/0/0 | 20 (20 resolve) | 1 | 1 | 6648 | 61.2 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 94 | 3/3 | 6/0/0 | 19 (19 resolve) | 1 | 1 | 5586 | 52.8 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 94 | 3/3 | 5/1/0 | 20 (20 resolve) | 1 | 0 | 5860 | 73.4 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | error | 0 | 0/3 | 0/0/0 | 0 | 1 | 2 | 13905 | 600 | must match /(likelihood ratio|LRT|reduced model|interaction|spline)/; must match /time/; must match /DESeq2|edgeR|limma/ |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 98 | 5/5 | 6/0/0 | 20 (20 resolve) | 1 | 1 | 5978 | 62.4 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 96 | 5/5 | 6/0/0 | 18 (18 resolve) | 1 | 1 | 6881 | 69.7 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 95 | 6/6 | 0/0/5 | 0 | 1 | 0 | 3697 | 37.7 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 91 | 6/6 | 6/0/0 | 21 (21 resolve) | 1 | 0 | 4996 | 54.9 |  |
| without--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 89 | 4/4 | 0/0/3 | 0 | 0 | 0 | 5101 | 69.9 |  |
| without--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 86 | 4/4 | 0/0/3 | 0 | 0 | 0 | 5095 | 67.9 |  |
| without--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 89 | 4/4 | 0/0/5 | 0 | 0 | 0 | 9033 | 136.2 |  |
| without--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 93 | 4/4 | 0/0/5 | 0 | 0 | 0 | 6937 | 95.5 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 95 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6492 | 89.2 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 89 | 4/4 | 0/0/4 | 0 | 0 | 0 | 5999 | 81.6 |  |
| without--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 66 | 5/6 | 0/0/4 | 0 | 0 | 0 | 6052 | 87.3 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 64 | 6/6 | 0/0/3 | 0 | 0 | 0 | 4737 | 68.1 |  |
| without--claude-opus-5 | paired-n5 | 1 | plan_submitted | 89 | 3/3 | 0/0/3 | 0 | 0 | 0 | 4920 | 68.3 |  |
| without--claude-opus-5 | paired-n5 | 2 | plan_submitted | 90 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6457 | 89.4 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 88 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6116 | 84.2 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 91 | 3/3 | 0/0/5 | 0 | 0 | 0 | 8079 | 111.9 |  |
| without--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 88 | 5/5 | 0/0/4 | 0 | 0 | 0 | 6424 | 90.2 |  |
| without--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 83 | 5/5 | 0/0/3 | 0 | 0 | 0 | 4729 | 68.7 |  |
| without--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 93 | 5/6 | 0/0/5 | 0 | 0 | 0 | 7812 | 106.5 | must not match /KEGG/ |
| without--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 84 | 6/6 | 0/0/5 | 0 | 0 | 0 | 7640 | 103.4 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 68 | 4/4 | 0/0/4 | 0 | 0 | 0 | 3043 | 37.9 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 69 | 4/4 | 0/0/3 | 0 | 0 | 0 | 3184 | 40 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 61 | 4/4 | 0/0/3 | 0 | 0 | 0 | 3567 | 54.2 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 70 | 4/4 | 0/0/3 | 0 | 0 | 0 | 6585 | 73.6 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 83 | 4/4 | 0/0/5 | 0 | 0 | 0 | 21143 | 503.1 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 76 | 4/4 | 0/0/3 | 0 | 0 | 0 | 4723 | 71.1 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 40 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3636 | 48.1 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 55 | 5/6 | 0/0/3 | 0 | 0 | 0 | 3722 | 49.1 | must match /(descriptive|fold change)/ |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 73 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2826 | 36.3 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 58 | 3/3 | 0/0/2 | 0 | 0 | 0 | 2513 | 32.1 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 73 | 3/3 | 0/0/4 | 0 | 0 | 0 | 4218 | 48.7 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 75 | 3/3 | 0/0/4 | 0 | 0 | 0 | 3962 | 60.1 |  |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 71 | 5/5 | 0/0/4 | 0 | 0 | 0 | 4241 | 56.7 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 74 | 5/5 | 0/0/4 | 0 | 0 | 0 | 3684 | 48.1 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 68 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3477 | 38.2 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 69 | 5/6 | 0/0/3 | 0 | 0 | 0 | 2877 | 38.5 | must not match /KEGG/ |
