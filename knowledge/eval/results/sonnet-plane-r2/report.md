# Phase 0 campaign `sonnet-plane-r2`

Judge: claude-fable-5-1.

Runs: 128. Judge verdicts: 128. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 64 | 98% | 86.2 | 4.4 | 97% | 100% | 89% | 82% | 1635/1635 | 0 (0) | 94% | 17.4 | 1437884 | 8452 | 1259886 | 119 |
| without--claude-sonnet-5 | 64 | 98% | 62.5 | 7.4 | 95% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 16.7 | 959102 | 5689 | 844463 | 114 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | 8.9 | 8.2 | 8.4 | 8.8 | 8.8 | 8.8 | 8.0 | 8.9 |
| without--claude-sonnet-5 | 7.9 | 6.3 | 4.7 | 7.1 | 6.5 | 5.9 | 5.5 | 6.0 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-sonnet-5: difference 23.7 points over 32 tasks, 95% bootstrap interval [18.3, 28.5], margin 5: non-inferior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 91 | 4/4 | 2/1/1 | 27 (27 resolve) | 1 | 3 | 7635 | 83.5 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 89 | 4/4 | 3/0/1 | 28 (28 resolve) | 1 | 4 | 8304 | 103.7 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 91 | 4/4 | 3/1/1 | 31 (31 resolve) | 1 | 1 | 7700 | 91.4 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 91 | 4/4 | 2/1/1 | 31 (31 resolve) | 1 | 2 | 6660 | 85.9 |  |
| with--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 90 | 7/7 | 3/0/1 | 28 (28 resolve) | 1 | 4 | 10290 | 109.3 |  |
| with--claude-sonnet-5 | covariates-n6 | 2 | error | 0 | 2/7 | 0/0/0 | 0 | 2 | 4 | 9577 | 600.1 | must match /sex/; must match /age/; must match /(center|centre|scale)/; must match /(design|formula|covariate|~)/; must match /DESeq2|edgeR|limma/ |
| with--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 85 | 7/7 | 4/0/0 | 14 (14 resolve) | 2 | 1 | 6133 | 67.3 |  |
| with--claude-sonnet-5 | enrichment-only-ranked | 2 | plan_submitted | 78 | 7/7 | 4/0/0 | 14 (14 resolve) | 1 | 1 | 4873 | 56.7 |  |
| with--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 25 | 4/5 | 0/0/0 | 0 | 2 | 0 | 7101 | 141.1 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-sonnet-5 | fastq-input | 2 | clarification_needed | 38 | 4/5 | 0/0/0 | 0 | 1 | 0 | 7738 | 161 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 75 | 6/6 | 5/0/0 | 18 (18 resolve) | 1 | 1 | 7425 | 94.2 |  |
| with--claude-sonnet-5 | gene-list-ora | 2 | plan_submitted | 80 | 5/6 | 3/0/0 | 14 (14 resolve) | 1 | 1 | 5059 | 53.9 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 90 | 4/4 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 7401 | 92.6 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 91 | 4/4 | 4/0/1 | 29 (29 resolve) | 1 | 1 | 7985 | 94.6 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 85 | 8/8 | 3/0/1 | 37 (37 resolve) | 1 | 1 | 21343 | 480.6 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 2 | plan_submitted | 96 | 8/8 | 0/0/5 | 0 | 1 | 1 | 23945 | 513.3 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 88 | 7/7 | 3/0/1 | 20 (20 resolve) | 1 | 2 | 6546 | 63.4 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 2 | plan_submitted | 88 | 7/7 | 3/0/1 | 22 (22 resolve) | 1 | 2 | 7141 | 75.7 |  |
| with--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 96 | 6/7 | 3/0/1 | 31 (31 resolve) | 1 | 1 | 6458 | 67.8 | must match /(ortholog|homolog|msigdbr|species)/ |
| with--claude-sonnet-5 | mouse-two-group-n6 | 2 | plan_submitted | 99 | 7/7 | 3/0/1 | 28 (28 resolve) | 1 | 1 | 6583 | 61.9 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 90 | 6/6 | 4/0/1 | 32 (32 resolve) | 1 | 1 | 8049 | 91.8 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 2 | plan_submitted | 88 | 6/6 | 5/0/1 | 32 (32 resolve) | 1 | 1 | 7535 | 73.8 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 80 | 5/6 | 3/1/0 | 17 (17 resolve) | 2 | 4 | 10079 | 122.6 | must not match /Wald test/ |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 86 | 6/6 | 1/2/1 | 16 (16 resolve) | 1 | 1 | 11910 | 131.4 |  |
| with--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 91 | 7/7 | 4/0/0 | 25 (25 resolve) | 1 | 3 | 7337 | 76.2 |  |
| with--claude-sonnet-5 | outlier-n5 | 2 | plan_submitted | 90 | 7/7 | 5/0/0 | 35 (35 resolve) | 1 | 0 | 8238 | 95.5 |  |
| with--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 90 | 6/6 | 2/1/1 | 31 (31 resolve) | 1 | 3 | 7928 | 92.1 |  |
| with--claude-sonnet-5 | paired-3groups-n4 | 2 | plan_submitted | 96 | 6/6 | 6/0/1 | 30 (30 resolve) | 2 | 4 | 21790 | 306.1 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 96 | 3/3 | 3/0/1 | 33 (33 resolve) | 1 | 1 | 6445 | 65.9 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 95 | 3/3 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 6565 | 80.1 |  |
| with--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 88 | 6/6 | 5/0/0 | 31 (31 resolve) | 1 | 0 | 7621 | 86.4 |  |
| with--claude-sonnet-5 | population-n60 | 2 | plan_submitted | 84 | 6/6 | 3/1/1 | 31 (31 resolve) | 1 | 4 | 11352 | 125.3 |  |
| with--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 84 | 7/7 | 3/0/0 | 12 (12 resolve) | 1 | 1 | 4876 | 55.5 |  |
| with--claude-sonnet-5 | python-enrichment-only | 2 | plan_submitted | 78 | 7/7 | 2/0/1 | 18 (18 resolve) | 1 | 1 | 6696 | 96.3 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 94 | 8/8 | 4/0/1 | 27 (27 resolve) | 1 | 4 | 11873 | 149.3 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 2 | plan_submitted | 93 | 8/8 | 3/0/1 | 29 (29 resolve) | 1 | 2 | 7502 | 72.8 |  |
| with--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 80 | 8/8 | 1/0/0 | 2 (2 resolve) | 1 | 1 | 2489 | 26.2 |  |
| with--claude-sonnet-5 | qc-only-n6 | 2 | plan_submitted | 78 | 8/8 | 1/0/0 | 2 (2 resolve) | 1 | 1 | 2862 | 33.2 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 89 | 6/6 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 7839 | 103 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 2 | plan_submitted | 90 | 6/6 | 4/0/0 | 33 (33 resolve) | 2 | 3 | 12842 | 202.1 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 88 | 6/6 | 5/0/0 | 13 (13 resolve) | 1 | 1 | 6278 | 65.1 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 2 | plan_submitted | 89 | 6/6 | 5/0/0 | 15 (15 resolve) | 1 | 1 | 6596 | 76.9 |  |
| with--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 95 | 7/7 | 3/0/1 | 35 (35 resolve) | 1 | 1 | 6939 | 70.5 |  |
| with--claude-sonnet-5 | star-counts-n3 | 2 | plan_submitted | 93 | 7/7 | 3/0/1 | 35 (35 resolve) | 1 | 1 | 7055 | 82.8 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 84 | 6/6 | 3/1/1 | 34 (34 resolve) | 1 | 1 | 11239 | 233.6 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 2 | plan_submitted | 86 | 6/6 | 3/1/1 | 34 (34 resolve) | 1 | 1 | 11149 | 169.5 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 91 | 7/7 | 4/0/1 | 39 (39 resolve) | 1 | 1 | 9325 | 100.1 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 2 | plan_submitted | 93 | 7/7 | 4/0/1 | 35 (35 resolve) | 1 | 0 | 6435 | 83.2 |  |
| with--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 93 | 6/6 | 4/0/0 | 38 (38 resolve) | 1 | 1 | 7165 | 76.6 |  |
| with--claude-sonnet-5 | three-prime-n3 | 2 | plan_submitted | 95 | 6/6 | 3/0/1 | 37 (37 resolve) | 1 | 1 | 8129 | 94.7 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 94 | 3/3 | 5/0/0 | 30 (30 resolve) | 2 | 3 | 10722 | 136.4 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 91 | 3/3 | 4/0/1 | 36 (36 resolve) | 1 | 0 | 8588 | 173 |  |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 89 | 5/8 | 4/0/1 | 25 (25 resolve) | 1 | 1 | 7510 | 89.8 | must match /(rRNA|ribosomal)/; must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 2 | plan_submitted | 94 | 8/8 | 3/0/1 | 31 (31 resolve) | 1 | 1 | 7246 | 77.8 |  |
| with--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 88 | 7/7 | 4/0/0 | 17 (17 resolve) | 1 | 3 | 7300 | 81 |  |
| with--claude-sonnet-5 | tpm-input-n6 | 2 | plan_submitted | 93 | 7/7 | 3/0/1 | 23 (23 resolve) | 1 | 2 | 7082 | 87 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 94 | 5/5 | 3/0/1 | 31 (31 resolve) | 2 | 4 | 12100 | 135.7 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 93 | 5/5 | 4/0/0 | 34 (34 resolve) | 2 | 2 | 8414 | 99.1 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 100 | 6/6 | 3/0/1 | 32 (32 resolve) | 1 | 2 | 6566 | 91.9 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 98 | 6/6 | 3/0/1 | 25 (25 resolve) | 1 | 1 | 6272 | 63.9 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 86 | 6/6 | 3/0/1 | 35 (35 resolve) | 1 | 0 | 6123 | 66.8 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 2 | plan_submitted | 91 | 6/6 | 3/0/1 | 33 (33 resolve) | 1 | 3 | 7901 | 79.8 |  |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 90 | 6/6 | 3/1/1 | 29 (29 resolve) | 1 | 1 | 8571 | 115.8 |  |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 2 | plan_submitted | 91 | 5/6 | 3/0/1 | 31 (31 resolve) | 1 | 1 | 8492 | 110.1 | must not match /KEGG/ |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 73 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2651 | 30.7 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 61 | 4/4 | 0/0/2 | 0 | 0 | 0 | 2188 | 30.5 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 63 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2539 | 31.2 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 71 | 4/4 | 0/0/2 | 0 | 0 | 0 | 4263 | 46.5 |  |
| without--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 65 | 6/7 | 0/0/3 | 0 | 0 | 0 | 4402 | 70.7 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | covariates-n6 | 2 | plan_submitted | 73 | 6/7 | 0/0/4 | 0 | 0 | 0 | 3580 | 42.1 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 70 | 5/7 | 0/0/2 | 0 | 0 | 0 | 2620 | 32.7 | must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/; must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--claude-sonnet-5 | enrichment-only-ranked | 2 | plan_submitted | 64 | 6/7 | 0/0/4 | 0 | 0 | 0 | 3351 | 35.7 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 30 | 5/5 | 0/0/0 | 0 | 0 | 0 | 6311 | 134.5 |  |
| without--claude-sonnet-5 | fastq-input | 2 | clarification_needed | 45 | 5/5 | 0/0/0 | 0 | 0 | 0 | 12363 | 204.5 |  |
| without--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 80 | 6/6 | 0/0/2 | 0 | 0 | 0 | 2042 | 26.6 |  |
| without--claude-sonnet-5 | gene-list-ora | 2 | plan_submitted | 70 | 5/6 | 0/0/2 | 0 | 0 | 0 | 2280 | 32.3 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 66 | 4/4 | 0/0/4 | 0 | 0 | 0 | 3078 | 45.6 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 65 | 4/4 | 0/0/4 | 0 | 0 | 0 | 3412 | 43.7 |  |
| without--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 76 | 8/8 | 0/0/3 | 0 | 0 | 0 | 16335 | 565.4 |  |
| without--claude-sonnet-5 | interaction-python-n4 | 2 | plan_submitted | 69 | 8/8 | 0/0/4 | 0 | 0 | 0 | 22428 | 488.1 |  |
| without--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 65 | 7/7 | 0/0/2 | 0 | 0 | 0 | 11940 | 382.4 |  |
| without--claude-sonnet-5 | log-normalized-n6 | 2 | plan_submitted | 59 | 7/7 | 0/0/3 | 0 | 0 | 0 | 2342 | 26.6 |  |
| without--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 71 | 7/7 | 0/0/3 | 0 | 0 | 0 | 3313 | 44.1 |  |
| without--claude-sonnet-5 | mouse-two-group-n6 | 2 | plan_submitted | 74 | 7/7 | 0/0/4 | 0 | 0 | 0 | 2834 | 32.3 |  |
| without--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 70 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3153 | 36.6 |  |
| without--claude-sonnet-5 | multi-group-3x4 | 2 | plan_submitted | 75 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3875 | 40.6 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 29 | 6/6 | 0/0/2 | 0 | 0 | 0 | 1906 | 23.4 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 29 | 6/6 | 0/0/3 | 0 | 0 | 0 | 1723 | 20.1 |  |
| without--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 60 | 6/7 | 0/0/3 | 0 | 0 | 0 | 13733 | 367.9 | must match /(criterion|threshold|rule|justif|reason)/ |
| without--claude-sonnet-5 | outlier-n5 | 2 | plan_submitted | 66 | 6/7 | 0/0/4 | 0 | 0 | 0 | 3558 | 43.4 | must match /(down-?weight|arrayWeights|robust|Cook)/ |
| without--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 53 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4454 | 52.9 | must match /(likelihood ratio|LRT|joint|F-test|ANOVA|any condition)/ |
| without--claude-sonnet-5 | paired-3groups-n4 | 2 | plan_submitted | 63 | 5/6 | 0/0/4 | 0 | 0 | 0 | 3281 | 37.5 | must match /(likelihood ratio|LRT|joint|F-test|ANOVA|any condition)/ |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 59 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2840 | 35.3 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 69 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2572 | 29.7 |  |
| without--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 66 | 5/6 | 0/0/5 | 0 | 0 | 0 | 23331 | 439 | must match /limma|voom/ |
| without--claude-sonnet-5 | population-n60 | 2 | plan_submitted | 63 | 5/6 | 0/0/3 | 0 | 0 | 0 | 2649 | 35.6 | must match /limma|voom/ |
| without--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 56 | 7/7 | 0/0/1 | 0 | 0 | 0 | 1700 | 21.8 |  |
| without--claude-sonnet-5 | python-enrichment-only | 2 | plan_submitted | 71 | 7/7 | 0/0/2 | 0 | 0 | 0 | 2364 | 29.8 |  |
| without--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 75 | 8/8 | 0/0/4 | 0 | 0 | 0 | 3091 | 32.2 |  |
| without--claude-sonnet-5 | python-two-group-n6 | 2 | plan_submitted | 55 | 8/8 | 0/0/3 | 0 | 0 | 0 | 6073 | 62.1 |  |
| without--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 73 | 8/8 | 0/0/1 | 0 | 0 | 0 | 1622 | 19.3 |  |
| without--claude-sonnet-5 | qc-only-n6 | 2 | plan_submitted | 70 | 8/8 | 0/0/4 | 0 | 0 | 0 | 2276 | 24.5 |  |
| without--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 40 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3043 | 32.9 |  |
| without--claude-sonnet-5 | rsem-counts-n6 | 2 | plan_submitted | 55 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2660 | 36.3 |  |
| without--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 65 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2532 | 33.8 |  |
| without--claude-sonnet-5 | sample-scores-gsva | 2 | plan_submitted | 63 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3857 | 45.9 |  |
| without--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 68 | 7/7 | 0/0/2 | 0 | 0 | 0 | 2547 | 31.6 |  |
| without--claude-sonnet-5 | star-counts-n3 | 2 | plan_submitted | 74 | 7/7 | 0/0/2 | 0 | 0 | 0 | 2539 | 29.9 |  |
| without--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 59 | 6/6 | 0/0/5 | 0 | 0 | 0 | 17947 | 453.9 |  |
| without--claude-sonnet-5 | strandedness-unknown-n3 | 2 | plan_submitted | 65 | 6/6 | 0/0/4 | 0 | 0 | 0 | 17706 | 354.9 |  |
| without--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 68 | 7/7 | 0/0/4 | 0 | 0 | 0 | 4219 | 50.5 |  |
| without--claude-sonnet-5 | suspected-batch-n6 | 2 | plan_submitted | 58 | 7/7 | 0/0/4 | 0 | 0 | 0 | 3654 | 43.4 |  |
| without--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 60 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5188 | 76.3 |  |
| without--claude-sonnet-5 | three-prime-n3 | 2 | plan_submitted | 74 | 6/6 | 0/0/2 | 0 | 0 | 0 | 2242 | 27.5 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 70 | 3/3 | 0/0/4 | 0 | 0 | 0 | 13076 | 280.4 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 56 | 3/3 | 0/0/3 | 0 | 0 | 0 | 6542 | 209.7 |  |
| without--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 59 | 6/8 | 0/0/3 | 0 | 0 | 0 | 4070 | 63.1 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | total-rna-highdup-n6 | 2 | plan_submitted | 64 | 6/8 | 0/0/3 | 0 | 0 | 0 | 3532 | 48.9 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 79 | 7/7 | 0/0/3 | 0 | 0 | 0 | 13317 | 309.1 |  |
| without--claude-sonnet-5 | tpm-input-n6 | 2 | plan_submitted | 70 | 7/7 | 0/0/3 | 0 | 0 | 0 | 14294 | 345.4 |  |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 63 | 5/5 | 0/0/3 | 0 | 0 | 0 | 4991 | 49.6 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 66 | 5/5 | 0/0/4 | 0 | 0 | 0 | 2545 | 29.2 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 58 | 6/6 | 0/0/4 | 0 | 0 | 0 | 2368 | 26.7 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 71 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3197 | 36.9 |  |
| without--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 59 | 6/6 | 0/0/2 | 0 | 0 | 0 | 2411 | 26.2 |  |
| without--claude-sonnet-5 | two-timepoints-n3 | 2 | plan_submitted | 51 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2256 | 25.2 |  |
| without--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 79 | 5/6 | 0/0/4 | 0 | 0 | 0 | 17546 | 339.1 | must not match /KEGG/ |
| without--claude-sonnet-5 | zebrafish-two-group-n3 | 2 | error | 0 | 2/6 | 0/0/0 | 0 | 0 | 0 | 7343 | 600.1 | must match /DESeq2|edgeR/; must match /(zebrafish|Danio rerio)/; must match /(ortholog|Gene Ontology|\bGO\b|skip|no curated|not (available|served|exist))/; must match /(adjusted p|padj|FDR|false discovery|Benjamini)/ |
