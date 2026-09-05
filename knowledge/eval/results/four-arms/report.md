# Phase 0 campaign `four-arms`

Judge: claude-opus-5.

Runs: 96. Judge verdicts: 96. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 24 | 100% | 96.7 | 0.8 | 99% | 100% | 100% | 97% | 816/816 | 56 (56) | 100% | 4.3 | 272412 | 10423 | 142509 | 126 |
| with--claude-sonnet-5 | 24 | 100% | 94.1 | 1.7 | 99% | 100% | 92% | 85% | 721/721 | 0 (0) | 100% | 11.6 | 909446 | 7574 | 753119 | 86 |
| without--claude-opus-5 | 24 | 100% | 89.5 | 2.4 | 99% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 3.3 | 106153 | 7775 | 33649 | 101 |
| without--claude-sonnet-5 | 24 | 96% | 63.3 | 8.9 | 97% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 11.7 | 915160 | 4485 | 796461 | 75 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 10.0 | 9.7 | 9.4 | 10.0 | 9.9 | 9.8 | 8.5 | 10.0 |
| with--claude-sonnet-5 | 9.8 | 9.1 | 9.4 | 9.3 | 9.8 | 9.8 | 8.3 | 9.9 |
| without--claude-opus-5 | 9.4 | 9.3 | 8.7 | 9.4 | 9.5 | 8.9 | 8.2 | 8.2 |
| without--claude-sonnet-5 | 8.3 | 6.0 | 4.7 | 6.6 | 7.2 | 5.8 | 5.6 | 6.5 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-opus-5: difference 7.1 points over 8 tasks, 95% bootstrap interval [4.0, 11.4], margin 5: non-inferior
- claude-sonnet-5: difference 30.7 points over 8 tasks, 95% bootstrap interval [24.7, 37.3], margin 5: non-inferior

## Contrast of two arms, paired by task (with--claude-sonnet-5 minus without--claude-opus-5)

- difference 4.5 points over 8 tasks, 95% bootstrap interval [1.8, 8.3], margin 5: non-inferior, and superior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 9430 | 115.2 |  |
| with--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 96 | 4/4 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 10571 | 126.2 |  |
| with--claude-opus-5 | batch-balanced-n6 | 3 | plan_submitted | 96 | 4/4 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 9726 | 121.5 |  |
| with--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 96 | 4/4 | 4/1/0 | 32 (32 resolve) | 1 | 1 | 10106 | 125 |  |
| with--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 96 | 4/4 | 4/1/0 | 34 (34 resolve) | 1 | 1 | 10961 | 133.6 |  |
| with--claude-opus-5 | confounded-batch-n6 | 3 | plan_submitted | 98 | 4/4 | 4/1/0 | 33 (33 resolve) | 1 | 1 | 9183 | 113 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 99 | 4/4 | 5/0/0 | 37 (37 resolve) | 1 | 1 | 10001 | 119.2 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 98 | 4/4 | 5/0/0 | 38 (38 resolve) | 1 | 1 | 9823 | 120.5 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 3 | plan_submitted | 96 | 4/4 | 4/0/0 | 38 (38 resolve) | 1 | 1 | 9778 | 118.2 |  |
| with--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 93 | 5/6 | 2/2/0 | 24 (24 resolve) | 1 | 1 | 8350 | 109 | must not match /Wald test/ |
| with--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 91 | 6/6 | 1/2/1 | 23 (23 resolve) | 1 | 1 | 7926 | 98.9 |  |
| with--claude-opus-5 | no-replicates-1v1 | 3 | plan_submitted | 89 | 6/6 | 2/2/0 | 23 (23 resolve) | 1 | 1 | 8352 | 110.4 |  |
| with--claude-opus-5 | paired-n5 | 1 | plan_submitted | 98 | 3/3 | 4/0/1 | 33 (33 resolve) | 1 | 1 | 10315 | 127.6 |  |
| with--claude-opus-5 | paired-n5 | 2 | plan_submitted | 98 | 3/3 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 11740 | 139.1 |  |
| with--claude-opus-5 | paired-n5 | 3 | plan_submitted | 98 | 3/3 | 4/0/1 | 35 (35 resolve) | 1 | 1 | 11138 | 139.6 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 95 | 3/3 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 10007 | 121.3 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 99 | 3/3 | 6/0/0 | 39 (39 resolve) | 1 | 1 | 12213 | 145.6 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 3 | plan_submitted | 96 | 3/3 | 4/0/0 | 40 (40 resolve) | 1 | 1 | 9459 | 117.9 |  |
| with--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 99 | 5/5 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 19337 | 213.4 |  |
| with--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 99 | 5/5 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 9933 | 119.3 |  |
| with--claude-opus-5 | two-group-n3 | 3 | plan_submitted | 99 | 5/5 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 9955 | 124.2 |  |
| with--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 99 | 6/6 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 10649 | 129.4 |  |
| with--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 99 | 6/6 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 10664 | 124.3 |  |
| with--claude-opus-5 | two-group-n6-enrich | 3 | plan_submitted | 99 | 6/6 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 10546 | 123.4 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 95 | 4/4 | 3/0/1 | 35 (35 resolve) | 1 | 1 | 6913 | 75.3 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 96 | 4/4 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 7865 | 96.3 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 3 | plan_submitted | 95 | 4/4 | 3/0/1 | 30 (30 resolve) | 1 | 3 | 8775 | 84.2 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 95 | 4/4 | 2/1/1 | 29 (29 resolve) | 1 | 1 | 7396 | 96.5 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 89 | 4/4 | 2/1/1 | 26 (26 resolve) | 1 | 3 | 8645 | 109 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 3 | plan_submitted | 94 | 4/4 | 1/2/1 | 25 (25 resolve) | 1 | 2 | 6736 | 67.8 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 94 | 4/4 | 4/0/2 | 35 (35 resolve) | 1 | 1 | 7122 | 77.1 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 95 | 4/4 | 3/0/1 | 37 (37 resolve) | 1 | 0 | 5620 | 67.8 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 3 | plan_submitted | 91 | 4/4 | 3/0/1 | 38 (38 resolve) | 1 | 1 | 6948 | 86.3 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 88 | 5/6 | 2/2/0 | 18 (18 resolve) | 1 | 1 | 6340 | 71.9 | must not match /Wald test/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 88 | 5/6 | 3/2/0 | 17 (17 resolve) | 1 | 1 | 6872 | 77.8 | must not match /Wald test/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 3 | plan_submitted | 85 | 6/6 | 1/2/1 | 20 (20 resolve) | 1 | 1 | 5489 | 68 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 96 | 3/3 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 6797 | 75.6 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 93 | 3/3 | 3/0/1 | 30 (30 resolve) | 1 | 3 | 7060 | 78.9 |  |
| with--claude-sonnet-5 | paired-n5 | 3 | plan_submitted | 96 | 3/3 | 3/0/1 | 33 (33 resolve) | 1 | 1 | 6680 | 66 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 94 | 3/3 | 5/0/1 | 28 (28 resolve) | 1 | 3 | 12276 | 160.3 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 98 | 3/3 | 7/0/0 | 33 (33 resolve) | 1 | 4 | 12927 | 144.7 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 3 | plan_submitted | 94 | 3/3 | 4/0/1 | 38 (38 resolve) | 1 | 1 | 8682 | 106.1 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 95 | 5/5 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 6909 | 69.7 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 98 | 5/5 | 4/0/1 | 30 (30 resolve) | 1 | 1 | 7778 | 81.6 |  |
| with--claude-sonnet-5 | two-group-n3 | 3 | plan_submitted | 96 | 5/5 | 4/1/0 | 30 (30 resolve) | 1 | 0 | 7402 | 86.5 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 98 | 6/6 | 3/0/1 | 29 (29 resolve) | 1 | 1 | 5629 | 57.3 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 99 | 6/6 | 3/0/1 | 29 (29 resolve) | 1 | 1 | 7279 | 82.2 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 3 | plan_submitted | 99 | 6/6 | 6/0/0 | 32 (32 resolve) | 1 | 1 | 7643 | 81.4 |  |
| without--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 96 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6231 | 85 |  |
| without--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 93 | 4/4 | 0/0/4 | 0 | 0 | 0 | 5659 | 77.6 |  |
| without--claude-opus-5 | batch-balanced-n6 | 3 | plan_submitted | 93 | 4/4 | 0/0/3 | 0 | 0 | 0 | 5056 | 68.2 |  |
| without--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 86 | 4/4 | 0/0/4 | 0 | 0 | 0 | 5062 | 72.9 |  |
| without--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 90 | 4/4 | 0/0/5 | 0 | 0 | 0 | 6803 | 96.7 |  |
| without--claude-opus-5 | confounded-batch-n6 | 3 | plan_submitted | 84 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6173 | 86.7 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 93 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6647 | 91.5 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 89 | 4/4 | 0/0/5 | 0 | 0 | 0 | 8060 | 110.9 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 3 | plan_submitted | 96 | 4/4 | 0/0/4 | 0 | 0 | 0 | 7650 | 102.3 |  |
| without--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 71 | 5/6 | 0/0/3 | 0 | 0 | 0 | 5268 | 75.4 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 69 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4777 | 68 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | no-replicates-1v1 | 3 | plan_submitted | 70 | 6/6 | 0/0/2 | 0 | 0 | 0 | 4120 | 60.8 |  |
| without--claude-opus-5 | paired-n5 | 1 | plan_submitted | 93 | 3/3 | 0/0/4 | 0 | 0 | 0 | 12073 | 137 |  |
| without--claude-opus-5 | paired-n5 | 2 | plan_submitted | 91 | 3/3 | 0/0/3 | 0 | 0 | 0 | 5677 | 80.5 |  |
| without--claude-opus-5 | paired-n5 | 3 | plan_submitted | 95 | 3/3 | 0/0/4 | 0 | 0 | 0 | 14036 | 161.1 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 94 | 3/3 | 0/0/5 | 0 | 0 | 0 | 6946 | 95.1 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 96 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6478 | 89.4 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 3 | plan_submitted | 91 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5887 | 80.9 |  |
| without--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 96 | 5/5 | 0/0/4 | 0 | 0 | 0 | 12126 | 140.1 |  |
| without--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 95 | 5/5 | 0/0/4 | 0 | 0 | 0 | 13975 | 159.6 |  |
| without--claude-opus-5 | two-group-n3 | 3 | plan_submitted | 93 | 5/5 | 0/0/5 | 0 | 0 | 0 | 7141 | 101.3 |  |
| without--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 95 | 6/6 | 0/0/3 | 0 | 0 | 0 | 11204 | 133.9 |  |
| without--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 91 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6510 | 86.8 |  |
| without--claude-opus-5 | two-group-n6-enrich | 3 | plan_submitted | 90 | 6/6 | 0/0/4 | 0 | 0 | 0 | 13030 | 152.2 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 79 | 4/4 | 0/0/2 | 0 | 0 | 0 | 2698 | 31 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 68 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2298 | 29.3 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 3 | plan_submitted | 81 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2576 | 34.6 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | error | 25 | 2/4 | 0/0/0 | 0 | 0 | 0 | 688 | 10.1 | must match /confound/; must match /(label|caveat|caution|assumption|cannot (be )?separate|not (be )?separable|ask|clarif)/ |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 60 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2914 | 37.6 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 3 | plan_submitted | 63 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2591 | 30.5 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 75 | 4/4 | 0/0/3 | 0 | 0 | 0 | 12684 | 253.2 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 53 | 4/4 | 0/0/2 | 0 | 0 | 0 | 2075 | 21.8 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 3 | plan_submitted | 75 | 4/4 | 0/0/4 | 0 | 0 | 0 | 5552 | 73.9 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 43 | 6/6 | 0/0/4 | 0 | 0 | 0 | 5349 | 97.5 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 53 | 5/6 | 0/0/4 | 0 | 0 | 0 | 15146 | 326.2 | must not match /FDR < 0\.05/ |
| without--claude-sonnet-5 | no-replicates-1v1 | 3 | plan_submitted | 26 | 6/6 | 0/0/2 | 0 | 0 | 0 | 2469 | 29.9 |  |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 61 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2122 | 25.6 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 58 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2492 | 26.6 |  |
| without--claude-sonnet-5 | paired-n5 | 3 | plan_submitted | 66 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2902 | 36.2 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 70 | 3/3 | 0/0/4 | 0 | 0 | 0 | 2445 | 25.9 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 76 | 3/3 | 0/0/5 | 0 | 0 | 0 | 18330 | 408.3 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 3 | plan_submitted | 80 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5812 | 100.9 |  |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 70 | 5/5 | 0/0/3 | 0 | 0 | 0 | 3513 | 40.5 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 65 | 5/5 | 0/0/3 | 0 | 0 | 0 | 2434 | 42.9 |  |
| without--claude-sonnet-5 | two-group-n3 | 3 | plan_submitted | 68 | 5/5 | 0/0/3 | 0 | 0 | 0 | 2207 | 25 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 69 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2586 | 30.8 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 74 | 6/6 | 0/0/4 | 0 | 0 | 0 | 2804 | 30.8 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 3 | plan_submitted | 65 | 6/6 | 0/0/5 | 0 | 0 | 0 | 2956 | 37.7 |  |
