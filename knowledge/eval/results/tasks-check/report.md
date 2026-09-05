# Phase 0 campaign `tasks-check`

Runs: 24. Judge verdicts: 0. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 24 | 100% | n/a | n/a | 98% | 100% | 92% | 87% | 637/637 | 1 (1) | 96% | 15.5 | 1169162 | 7578 | 1001522 | 96 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: no judged pair of arms

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | n/a | 7/7 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 8036 | 80.3 |  |
| with--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | n/a | 7/7 | 3/0/1 | 14 (14 resolve) | 1 | 1 | 4016 | 48.2 |  |
| with--claude-sonnet-5 | fastq-input | 1 | clarification_needed | n/a | 5/5 | 0/0/0 | 0 | 1 | 1 | 3746 | 86.7 |  |
| with--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | n/a | 6/6 | 3/0/0 | 16 (16 resolve) | 1 | 2 | 8373 | 120.3 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | n/a | 8/8 | 5/0/1 | 28 (28 resolve) | 1 | 3 | 11380 | 141.8 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | n/a | 7/7 | 4/0/0 | 24 (24 resolve) | 1 | 2 | 7519 | 83.2 |  |
| with--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | n/a | 7/7 | 5/0/0 | 29 (29 resolve) | 1 | 1 | 7371 | 68.8 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | n/a | 6/6 | 3/0/1 | 36 (36 resolve) | 1 | 0 | 6174 | 69.2 |  |
| with--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | n/a | 7/7 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 8208 | 94.7 |  |
| with--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | n/a | 6/6 | 6/0/0 | 29 (29 resolve) | 1 | 3 | 10141 | 131.6 |  |
| with--claude-sonnet-5 | population-n60 | 1 | plan_submitted | n/a | 6/6 | 5/0/0 | 33 (33 resolve) | 1 | 2 | 9142 | 91.4 |  |
| with--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | n/a | 7/7 | 4/0/0 | 13 (13 resolve) | 1 | 1 | 5346 | 71.9 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | n/a | 8/8 | 3/0/1 | 34 (34 resolve) | 2 | 2 | 10668 | 132.8 |  |
| with--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | n/a | 8/8 | 1/0/0 | 5 (5 resolve) | 1 | 1 | 2325 | 27.9 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | n/a | 6/6 | 3/0/1 | 31 (31 resolve) | 1 | 1 | 7810 | 93.8 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | n/a | 6/6 | 3/0/1 | 22 (22 resolve) | 1 | 1 | 5854 | 61.4 |  |
| with--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | n/a | 7/7 | 3/0/1 | 32 (32 resolve) | 1 | 1 | 6711 | 71.6 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | n/a | 6/6 | 4/0/1 | 34 (34 resolve) | 1 | 1 | 11585 | 229.1 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | n/a | 7/7 | 3/0/1 | 36 (36 resolve) | 1 | 1 | 7833 | 107 |  |
| with--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | n/a | 6/6 | 3/0/1 | 38 (38 resolve) | 1 | 1 | 7089 | 84.1 |  |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | n/a | 5/8 | 3/0/1 | 29 (29 resolve) | 1 | 3 | 7973 | 85 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/; must not match /dedup(licate)? (the )?(reads|BAM|library)/ |
| with--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | n/a | 7/7 | 4/0/0 | 20 (20 resolve) | 1 | 0 | 5471 | 60.5 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | n/a | 6/6 | 3/0/1 | 40 (40 resolve) | 1 | 1 | 8597 | 108.4 |  |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | n/a | 5/6 | 5/0/1 | 30 (30 resolve) | 1 | 1 | 10501 | 158.6 | must not match /KEGG/ |
