# Phase 0 campaign `four-models`

Judge: claude-fable-5-1 (tag fable).

Runs: 184. Judge verdicts: 182. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 46 | 100% | 91.7 | 0.0 | 98% | 100% | 96% | 99% | 1064/1066 | 26 (26) | 96% | 4.6 | 291114 | 9465 | 135849 | 117 |
| with--claude-sonnet-5 | 46 | 100% | 84.5 | 0.0 | 97% | 98% | 78% | 88% | 1191/1191 | 1 (1) | 96% | 17.6 | 1676373 | 9332 | 1436786 | 121 |
| without--claude-opus-5 | 46 | 100% | 82.1 | 0.0 | 96% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 4.0 | 144836 | 8155 | 63037 | 109 |
| without--claude-sonnet-5 | 46 | 98% | 61.3 | 0.0 | 93% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 14.9 | 937661 | 4375 | 827218 | 75 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 9.4 | 8.9 | 9.0 | 9.4 | 9.1 | 9.0 | 9.2 | 9.4 |
| with--claude-sonnet-5 | 8.6 | 8.2 | 8.2 | 8.9 | 8.5 | 8.5 | 8.0 | 8.6 |
| without--claude-opus-5 | 8.8 | 8.3 | 7.9 | 8.7 | 8.8 | 8.0 | 7.5 | 7.7 |
| without--claude-sonnet-5 | 7.9 | 6.0 | 4.6 | 6.8 | 6.6 | 5.7 | 5.4 | 5.9 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-opus-5: difference 9.5 points over 44 tasks, 95% bootstrap interval [7.3, 11.7], margin 5: non-inferior
- claude-sonnet-5: difference 23.2 points over 46 tasks, 95% bootstrap interval [19.0, 27.7], margin 5: non-inferior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 100 | 4/4 | 3/0/0 | 21 (21 resolve) | 1 | 1 | 7261 | 85.2 |  |
| with--claude-opus-5 | classifier-n60 | 1 | plan_submitted | 89 | 7/7 | 4/1/2 | 16 (16 resolve) | 2 | 1 | 11331 | 144.8 |  |
| with--claude-opus-5 | clustering-n60 | 1 | plan_submitted | 91 | 7/7 | 6/0/0 | 11 (11 resolve) | 1 | 1 | 9924 | 124.2 |  |
| with--claude-opus-5 | coexpression-n60 | 1 | plan_submitted | 84 | 6/7 | 5/0/0 | 18 (18 resolve) | 1 | 1 | 10812 | 136.1 | must match /\bsigned[- ](network|adjacency|hybrid)/ |
| with--claude-opus-5 | coexpression-too-few-n3 | 1 | plan_submitted | 73 | 5/6 | 4/0/0 | 18 (18 resolve) | 1 | 3 | 13217 | 170.4 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/ |
| with--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 98 | 4/4 | 4/1/0 | 35 (35 resolve) | 1 | 1 | 9894 | 120.8 |  |
| with--claude-opus-5 | covariates-n6 | 1 | plan_submitted | 98 | 6/7 | 5/0/0 | 19 (19 resolve) | 1 | 1 | 9471 | 112.3 | must not match /regress(es|ed)? (out )?(the )?(sex|age|covariates?)[^.]* (from|out of) the counts/ |
| with--claude-opus-5 | de-plus-tf-activity-n6 | 1 | plan_submitted | 91 | 7/7 | 6/0/0 | 23 (23 resolve) | 1 | 1 | 11684 | 144.1 |  |
| with--claude-opus-5 | deconvolution-mouse-n6 | 1 | plan_submitted | 93 | 7/7 | 2/0/0 | 13 (13 resolve) | 1 | 1 | 11325 | 137.2 |  |
| with--claude-opus-5 | deconvolution-tpm-n6 | 1 | plan_submitted | 95 | 8/8 | 2/0/0 | 18 (18 resolve) | 1 | 1 | 10629 | 131.2 |  |
| with--claude-opus-5 | enrichment-only-ranked | 1 | plan_submitted | 89 | 6/7 | 3/0/0 | 18 (18 resolve) | 1 | 1 | 7484 | 92.9 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| with--claude-opus-5 | fastq-input | 1 | clarification_needed | 33 | 4/5 | 0/0/0 | 0 | 1 | 0 | 2422 | 42.1 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-opus-5 | gene-list-ora | 1 | plan_submitted | 86 | 6/6 | 4/0/0 | 22 (22 resolve) | 1 | 1 | 8940 | 117.5 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 6/0/0 | 37 (37 resolve) | 1 | 1 | 12024 | 147.1 |  |
| with--claude-opus-5 | interaction-python-n4 | 1 | plan_submitted | 91 | 8/8 | 3/1/0 | 37 (37 resolve) | 1 | 1 | 9107 | 115.3 |  |
| with--claude-opus-5 | log-normalized-n6 | 1 | plan_submitted | 98 | 7/7 | 3/0/0 | 11 (11 resolve) | 1 | 1 | 7238 | 90.6 |  |
| with--claude-opus-5 | mouse-two-group-n6 | 1 | plan_submitted | 99 | 7/7 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 11029 | 127.9 |  |
| with--claude-opus-5 | multi-group-3x4 | 1 | plan_submitted | 98 | 6/6 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 10172 | 122.2 |  |
| with--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 99 | 6/6 | 2/1/0 | 8 (8 resolve) | 1 | 1 | 6872 | 87.3 |  |
| with--claude-opus-5 | outlier-n5 | 1 | plan_submitted | 98 | 7/7 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 11086 | 134.3 |  |
| with--claude-opus-5 | paired-3groups-n4 | 1 | plan_submitted | 95 | 6/6 | 5/0/0 | 40 (40 resolve) | 1 | 1 | 10844 | 132.3 |  |
| with--claude-opus-5 | paired-n5 | 1 | plan_submitted | 100 | 3/3 | 3/0/0 | 20 (20 resolve) | 1 | 1 | 7297 | 88.6 |  |
| with--claude-opus-5 | pathway-activity-n6 | 1 | plan_submitted | 99 | 7/7 | 5/0/0 | 24 (24 resolve) | 1 | 1 | 10539 | 130.2 |  |
| with--claude-opus-5 | population-n60 | 1 | plan_submitted | 88 | 6/6 | 2/1/0 | 16 (16 resolve) | 1 | 1 | 7308 | 93.7 |  |
| with--claude-opus-5 | python-enrichment-only | 1 | plan_submitted | 83 | 7/7 | 3/0/0 | 20 (20 resolve) | 1 | 1 | 7613 | 95.4 |  |
| with--claude-opus-5 | python-two-group-n6 | 1 | plan_submitted | 99 | 8/8 | 4/1/0 | 35 (35 resolve) | 1 | 1 | 11093 | 129.7 |  |
| with--claude-opus-5 | qc-only-n6 | 1 | plan_submitted | 93 | 8/8 | 2/0/0 | 4 (4 resolve) | 1 | 1 | 5295 | 67.2 |  |
| with--claude-opus-5 | rsem-counts-n6 | 1 | plan_submitted | 98 | 6/6 | 4/0/0 | 20 (20 resolve) | 1 | 1 | 8260 | 102 |  |
| with--claude-opus-5 | sample-scores-gsva | 1 | plan_submitted | 94 | 6/6 | 6/0/0 | 14 (13 resolve) | 1 | 1 | 9725 | 115.3 |  |
| with--claude-opus-5 | signature-scores-n6 | 1 | plan_submitted | 98 | 7/7 | 5/0/0 | 11 (11 resolve) | 1 | 2 | 9371 | 113.1 |  |
| with--claude-opus-5 | star-counts-n3 | 1 | plan_submitted | 99 | 7/7 | 4/0/0 | 22 (22 resolve) | 1 | 1 | 9130 | 112 |  |
| with--claude-opus-5 | strandedness-unknown-n3 | 1 | plan_submitted | 90 | 6/6 | 4/1/0 | 40 (40 resolve) | 1 | 1 | 12275 | 152.8 |  |
| with--claude-opus-5 | survival-n60 | 1 | plan_submitted | 89 | 7/7 | 5/0/0 | 12 (12 resolve) | 1 | 1 | 9444 | 120 |  |
| with--claude-opus-5 | suspected-batch-n6 | 1 | plan_submitted | 91 | 7/7 | 5/0/0 | 40 (40 resolve) | 1 | 1 | 11610 | 141.5 |  |
| with--claude-opus-5 | tf-activity-n6 | 1 | plan_submitted | 95 | 7/7 | 6/0/0 | 20 (20 resolve) | 1 | 1 | 9942 | 120.1 |  |
| with--claude-opus-5 | tf-activity-python-n6 | 1 | plan_submitted | 93 | 8/8 | 5/0/0 | 20 (19 resolve) | 1 | 1 | 9940 | 124.4 |  |
| with--claude-opus-5 | three-prime-n3 | 1 | plan_submitted | 99 | 6/6 | 4/0/0 | 25 (25 resolve) | 1 | 1 | 9420 | 111.8 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 98 | 3/3 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 9555 | 117.4 |  |
| with--claude-opus-5 | total-rna-highdup-n6 | 1 | plan_submitted | 96 | 8/8 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 11767 | 146 |  |
| with--claude-opus-5 | tpm-input-n6 | 1 | plan_submitted | 96 | 7/7 | 3/0/0 | 12 (12 resolve) | 1 | 1 | 6154 | 75.9 |  |
| with--claude-opus-5 | transcript-usage-n6 | 1 | clarification_needed | 51 | 6/6 | 0/0/0 | 0 | 1 | 0 | 1735 | 25.9 |  |
| with--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 96 | 5/5 | 4/0/0 | 20 (20 resolve) | 1 | 1 | 8479 | 103.1 |  |
| with--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 100 | 6/6 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 11134 | 130.6 |  |
| with--claude-opus-5 | two-timepoints-n3 | 1 | plan_submitted | 95 | 6/6 | 4/1/0 | 43 (43 resolve) | 1 | 1 | 11126 | 140.1 |  |
| with--claude-opus-5 | variance-partition-n6 | 1 | plan_submitted | 95 | 7/7 | 6/0/0 | 34 (34 resolve) | 1 | 1 | 10854 | 128.4 |  |
| with--claude-opus-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 95 | 5/6 | 6/0/0 | 35 (35 resolve) | 1 | 1 | 13561 | 174.7 | must not match /KEGG/ |
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 96 | 4/4 | 6/0/0 | 31 (31 resolve) | 1 | 0 | 14196 | 240 |  |
| with--claude-sonnet-5 | classifier-n60 | 1 | plan_submitted | 71 | 6/7 | 6/0/1 | 28 (28 resolve) | 3 | 2 | 9364 | 103 | must match /(external|independent) (cohort|validation|data ?set)/ |
| with--claude-sonnet-5 | clustering-n60 | 1 | plan_submitted | 73 | 6/7 | 7/0/1 | 19 (19 resolve) | 3 | 5 | 12254 | 145.4 | must match /(agreement|Rand index|contingency|cross-?tab|tabulat)[^.]{0,80}condition|condition[^.]{0,80}(agreement|Rand index|contingency|cross-?tab|tabulat)/ |
| with--claude-sonnet-5 | coexpression-n60 | 1 | plan_submitted | 78 | 7/7 | 2/1/1 | 29 (29 resolve) | 1 | 2 | 10067 | 187.5 |  |
| with--claude-sonnet-5 | coexpression-too-few-n3 | 1 | plan_submitted | 91 | 6/6 | 4/0/0 | 17 (17 resolve) | 1 | 4 | 9095 | 113.8 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 89 | 4/4 | 3/1/1 | 33 (33 resolve) | 1 | 1 | 7324 | 77 |  |
| with--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 84 | 7/7 | 2/1/1 | 26 (26 resolve) | 2 | 4 | 9361 | 138.4 |  |
| with--claude-sonnet-5 | de-plus-tf-activity-n6 | 1 | plan_submitted | 86 | 7/7 | 3/0/1 | 35 (35 resolve) | 1 | 1 | 8081 | 101.4 |  |
| with--claude-sonnet-5 | deconvolution-mouse-n6 | 1 | plan_submitted | 83 | 7/7 | 3/0/0 | 19 (19 resolve) | 1 | 2 | 11113 | 142.3 |  |
| with--claude-sonnet-5 | deconvolution-tpm-n6 | 1 | plan_submitted | 84 | 8/8 | 3/0/0 | 12 (12 resolve) | 2 | 1 | 8304 | 89.9 |  |
| with--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 81 | 7/7 | 3/0/1 | 16 (16 resolve) | 1 | 1 | 5813 | 63.4 |  |
| with--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 59 | 4/5 | 0/0/0 | 0 | 1 | 0 | 5185 | 102.5 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 75 | 6/6 | 4/0/0 | 18 (18 resolve) | 1 | 1 | 6555 | 86.2 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 31 (31 resolve) | 1 | 3 | 9668 | 106.1 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 88 | 8/8 | 3/0/1 | 35 (35 resolve) | 1 | 4 | 10832 | 144.1 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 85 | 7/7 | 5/0/0 | 16 (16 resolve) | 1 | 0 | 12804 | 189.5 |  |
| with--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 100 | 7/7 | 3/0/1 | 30 (30 resolve) | 1 | 1 | 6689 | 63.6 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 91 | 6/6 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 8143 | 87.4 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 75 | 6/6 | 1/2/1 | 19 (19 resolve) | 1 | 0 | 6096 | 79.3 |  |
| with--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 93 | 7/7 | 3/0/1 | 36 (36 resolve) | 1 | 0 | 6172 | 65.7 |  |
| with--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 94 | 6/6 | 3/0/1 | 37 (37 resolve) | 3 | 5 | 13584 | 247.9 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 93 | 3/3 | 3/0/1 | 29 (29 resolve) | 1 | 3 | 8915 | 104.2 |  |
| with--claude-sonnet-5 | pathway-activity-n6 | 1 | plan_submitted | 88 | 7/7 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 8419 | 95.8 |  |
| with--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 86 | 6/6 | 3/1/0 | 33 (33 resolve) | 1 | 0 | 15425 | 184.2 |  |
| with--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 79 | 7/7 | 4/0/0 | 16 (16 resolve) | 1 | 2 | 8646 | 144.9 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 93 | 8/8 | 3/0/1 | 32 (32 resolve) | 1 | 0 | 6823 | 80.3 |  |
| with--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 73 | 8/8 | 1/0/0 | 3 (3 resolve) | 1 | 1 | 2718 | 29.4 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 90 | 6/6 | 4/0/0 | 31 (31 resolve) | 2 | 3 | 15798 | 139.8 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 96 | 6/6 | 5/0/1 | 32 (32 resolve) | 1 | 2 | 9916 | 106.2 |  |
| with--claude-sonnet-5 | signature-scores-n6 | 1 | plan_submitted | 85 | 7/7 | 5/0/0 | 10 (10 resolve) | 1 | 4 | 8229 | 91.9 |  |
| with--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 94 | 7/7 | 2/1/1 | 29 (29 resolve) | 1 | 3 | 8648 | 90.3 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 83 | 6/6 | 6/0/0 | 34 (34 resolve) | 1 | 0 | 20192 | 252.5 |  |
| with--claude-sonnet-5 | survival-n60 | 1 | plan_submitted | 89 | 7/7 | 5/0/0 | 10 (10 resolve) | 2 | 1 | 6054 | 65.7 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 83 | 7/7 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 19612 | 320.4 |  |
| with--claude-sonnet-5 | tf-activity-n6 | 1 | plan_submitted | 90 | 6/7 | 3/0/1 | 32 (32 resolve) | 1 | 1 | 7939 | 98.5 | must match /(regulon size|min_n|minsize|minimum (number of )?targets|at least (five|5) targets)/ |
| with--claude-sonnet-5 | tf-activity-python-n6 | 1 | plan_submitted | 89 | 8/8 | 4/0/1 | 32 (32 resolve) | 1 | 2 | 9729 | 109.5 |  |
| with--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 96 | 6/6 | 3/0/1 | 41 (41 resolve) | 1 | 1 | 7709 | 88.1 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 78 | 3/3 | 4/0/0 | 26 (26 resolve) | 2 | 4 | 13077 | 207.5 |  |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 83 | 6/8 | 3/1/0 | 24 (24 resolve) | 1 | 3 | 7113 | 69.6 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| with--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 89 | 7/7 | 5/0/0 | 18 (18 resolve) | 1 | 2 | 8418 | 96.6 |  |
| with--claude-sonnet-5 | transcript-usage-n6 | 1 | clarification_needed | 20 | 5/6 | 0/0/0 | 0 | 0 | 0 | 265 | 5.1 | must match /(DEXSeq|DRIMSeq)/ |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 94 | 5/5 | 3/1/0 | 32 (32 resolve) | 2 | 4 | 10529 | 174 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 94 | 6/6 | 3/0/1 | 33 (33 resolve) | 1 | 0 | 5091 | 70.5 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 89 | 6/6 | 4/0/0 | 42 (42 resolve) | 1 | 3 | 8443 | 99.2 |  |
| with--claude-sonnet-5 | variance-partition-n6 | 1 | plan_submitted | 79 | 7/7 | 4/0/1 | 36 (36 resolve) | 1 | 4 | 10286 | 132.3 |  |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 88 | 5/6 | 3/1/1 | 28 (28 resolve) | 1 | 3 | 10598 | 118.1 | must not match /KEGG/ |
| without--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 93 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6335 | 89.4 |  |
| without--claude-opus-5 | classifier-n60 | 1 | plan_submitted | 85 | 7/7 | 0/0/7 | 0 | 0 | 0 | 8793 | 134.6 |  |
| without--claude-opus-5 | clustering-n60 | 1 | plan_submitted | 83 | 7/7 | 0/0/4 | 0 | 0 | 0 | 15168 | 189 |  |
| without--claude-opus-5 | coexpression-n60 | 1 | plan_submitted | 89 | 6/7 | 0/0/3 | 0 | 0 | 0 | 7879 | 107.2 | must not match /(build|construct|run|fit)s? (the )?network on (the )?raw counts/ |
| without--claude-opus-5 | coexpression-too-few-n3 | 1 | plan_submitted | 69 | 5/6 | 0/0/3 | 0 | 0 | 0 | 7720 | 120.1 | must match /(STRING|prior network|curated|stop)/ |
| without--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 83 | 4/4 | 0/0/4 | 0 | 0 | 0 | 13587 | 159.9 |  |
| without--claude-opus-5 | covariates-n6 | 1 | plan_submitted | 89 | 7/7 | 0/0/4 | 0 | 0 | 0 | 6958 | 96.4 |  |
| without--claude-opus-5 | de-plus-tf-activity-n6 | 1 | plan_submitted | 79 | 7/7 | 0/0/2 | 0 | 0 | 0 | 5906 | 85.8 |  |
| without--claude-opus-5 | deconvolution-mouse-n6 | 1 | plan_submitted | 84 | 7/7 | 0/0/3 | 0 | 0 | 0 | 8845 | 122.1 |  |
| without--claude-opus-5 | deconvolution-tpm-n6 | 1 | plan_submitted | 85 | 7/8 | 0/0/3 | 0 | 0 | 0 | 10622 | 145.8 | must not match /(feed|pass|give|run|use|supply)s? (the )?(log2? ?\(TPM ?\+ ?1\)|log[- ]transformed|log[- ]scale|log2 ?TPM)[^.;:]{0,30}(into|to|through|with) (EPIC|quanTIseq|quantiseqr)|(EPIC|quanTIseq|quantiseqr) on (the )?(log2? ?\(TPM ?\+ ?1\)|log[- ]transformed|log[- ]scale|log2 ?TPM)/ |
| without--claude-opus-5 | enrichment-only-ranked | 1 | plan_submitted | 85 | 6/7 | 0/0/3 | 0 | 0 | 0 | 4949 | 68 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--claude-opus-5 | fastq-input | 1 | clarification_needed | 45 | 4/5 | 0/0/0 | 0 | 0 | 0 | 1957 | 42.6 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| without--claude-opus-5 | gene-list-ora | 1 | plan_submitted | 76 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6822 | 89.7 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 89 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6614 | 86.7 |  |
| without--claude-opus-5 | interaction-python-n4 | 1 | plan_submitted | 89 | 8/8 | 0/0/5 | 0 | 0 | 0 | 10452 | 144.6 |  |
| without--claude-opus-5 | log-normalized-n6 | 1 | plan_submitted | n/a | 7/7 | 0/0/4 | 0 | 0 | 0 | 12080 | 142.7 |  |
| without--claude-opus-5 | mouse-two-group-n6 | 1 | plan_submitted | 89 | 7/7 | 0/0/3 | 0 | 0 | 0 | 12232 | 140.2 |  |
| without--claude-opus-5 | multi-group-3x4 | 1 | plan_submitted | 83 | 6/6 | 0/0/3 | 0 | 0 | 0 | 12174 | 147.4 |  |
| without--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 60 | 5/6 | 0/0/3 | 0 | 0 | 0 | 5699 | 82.7 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | outlier-n5 | 1 | plan_submitted | 88 | 7/7 | 0/0/5 | 0 | 0 | 0 | 7459 | 106.4 |  |
| without--claude-opus-5 | paired-3groups-n4 | 1 | plan_submitted | 94 | 6/6 | 0/0/4 | 0 | 0 | 0 | 13113 | 152 |  |
| without--claude-opus-5 | paired-n5 | 1 | plan_submitted | 89 | 3/3 | 0/0/5 | 0 | 0 | 0 | 7057 | 98.9 |  |
| without--claude-opus-5 | pathway-activity-n6 | 1 | plan_submitted | 90 | 7/7 | 0/0/3 | 0 | 0 | 0 | 8985 | 128.4 |  |
| without--claude-opus-5 | population-n60 | 1 | plan_submitted | 79 | 5/6 | 0/0/3 | 0 | 0 | 0 | 6009 | 80.8 | must match /limma|voom/ |
| without--claude-opus-5 | python-enrichment-only | 1 | plan_submitted | 71 | 7/7 | 0/0/2 | 0 | 0 | 0 | 4191 | 59.6 |  |
| without--claude-opus-5 | python-two-group-n6 | 1 | plan_submitted | 94 | 8/8 | 0/0/4 | 0 | 0 | 0 | 7911 | 108.1 |  |
| without--claude-opus-5 | qc-only-n6 | 1 | plan_submitted | 90 | 8/8 | 0/0/2 | 0 | 0 | 0 | 4097 | 57.4 |  |
| without--claude-opus-5 | rsem-counts-n6 | 1 | plan_submitted | 85 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7577 | 104.5 |  |
| without--claude-opus-5 | sample-scores-gsva | 1 | plan_submitted | 86 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5073 | 69.2 |  |
| without--claude-opus-5 | signature-scores-n6 | 1 | plan_submitted | 86 | 7/7 | 0/0/5 | 0 | 0 | 0 | 7627 | 104.9 |  |
| without--claude-opus-5 | star-counts-n3 | 1 | plan_submitted | 89 | 6/7 | 0/0/4 | 0 | 0 | 0 | 6533 | 90.1 | must not match /(run|use|apply|call) tximport/ |
| without--claude-opus-5 | strandedness-unknown-n3 | 1 | plan_submitted | n/a | 6/6 | 0/0/4 | 0 | 0 | 0 | 8230 | 115.5 |  |
| without--claude-opus-5 | survival-n60 | 1 | plan_submitted | 81 | 6/7 | 0/0/6 | 0 | 0 | 0 | 7959 | 110.6 | must match /continuous/ |
| without--claude-opus-5 | suspected-batch-n6 | 1 | plan_submitted | 83 | 7/7 | 0/0/4 | 0 | 0 | 0 | 8306 | 118.5 |  |
| without--claude-opus-5 | tf-activity-n6 | 1 | plan_submitted | 83 | 6/7 | 0/0/2 | 0 | 0 | 0 | 6773 | 93.4 | must match /(regulon size|min_n|minsize|minimum (number of )?targets|at least (five|5) targets)/ |
| without--claude-opus-5 | tf-activity-python-n6 | 1 | plan_submitted | 76 | 8/8 | 0/0/2 | 0 | 0 | 0 | 5684 | 86.9 |  |
| without--claude-opus-5 | three-prime-n3 | 1 | plan_submitted | 90 | 6/6 | 0/0/3 | 0 | 0 | 0 | 13797 | 158.5 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 80 | 3/3 | 0/0/5 | 0 | 0 | 0 | 7261 | 102.2 |  |
| without--claude-opus-5 | total-rna-highdup-n6 | 1 | plan_submitted | 89 | 7/8 | 0/0/4 | 0 | 0 | 0 | 14873 | 173.1 | must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-opus-5 | tpm-input-n6 | 1 | plan_submitted | 80 | 7/7 | 0/0/3 | 0 | 0 | 0 | 5872 | 84.4 |  |
| without--claude-opus-5 | transcript-usage-n6 | 1 | clarification_needed | 33 | 5/6 | 0/0/0 | 0 | 0 | 0 | 907 | 16.4 | must match /(DEXSeq|DRIMSeq)/ |
| without--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 99 | 5/5 | 0/0/5 | 0 | 0 | 0 | 15160 | 176.5 |  |
| without--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 86 | 6/6 | 0/0/3 | 0 | 0 | 0 | 10692 | 128.9 |  |
| without--claude-opus-5 | two-timepoints-n3 | 1 | plan_submitted | 88 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6479 | 89.8 |  |
| without--claude-opus-5 | variance-partition-n6 | 1 | plan_submitted | 73 | 7/7 | 0/0/3 | 0 | 0 | 0 | 5118 | 69.7 |  |
| without--claude-opus-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 81 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7597 | 115.8 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 79 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2765 | 33 |  |
| without--claude-sonnet-5 | classifier-n60 | 1 | plan_submitted | 59 | 7/7 | 0/0/4 | 0 | 0 | 0 | 3179 | 34.8 |  |
| without--claude-sonnet-5 | clustering-n60 | 1 | plan_submitted | 70 | 6/7 | 0/0/6 | 0 | 0 | 0 | 8897 | 160.1 | must match /(agreement|Rand index|contingency|cross-?tab|tabulat)[^.]{0,80}condition|condition[^.]{0,80}(agreement|Rand index|contingency|cross-?tab|tabulat)/ |
| without--claude-sonnet-5 | coexpression-n60 | 1 | plan_submitted | 68 | 7/7 | 0/0/2 | 0 | 0 | 0 | 7733 | 164.4 |  |
| without--claude-sonnet-5 | coexpression-too-few-n3 | 1 | error | 14 | 2/6 | 0/0/0 | 0 | 0 | 0 | 707 | 10.8 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/; must match /(STRING|prior network|curated|stop)/; must match /(noise|unstable|unreliable|not (be )?reliable)/; must match /(six|6) samples/ |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 66 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2809 | 36.5 |  |
| without--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 71 | 6/7 | 0/0/4 | 0 | 0 | 0 | 3440 | 39.9 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | de-plus-tf-activity-n6 | 1 | plan_submitted | 64 | 6/7 | 0/0/2 | 0 | 0 | 0 | 3269 | 39.2 | must match /CollecTRI/ |
| without--claude-sonnet-5 | deconvolution-mouse-n6 | 1 | plan_submitted | 68 | 7/7 | 0/0/2 | 0 | 0 | 0 | 7113 | 139 |  |
| without--claude-sonnet-5 | deconvolution-tpm-n6 | 1 | plan_submitted | 73 | 8/8 | 0/0/1 | 0 | 0 | 0 | 8010 | 180.3 |  |
| without--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 58 | 7/7 | 0/0/2 | 0 | 0 | 0 | 1391 | 17.1 |  |
| without--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 63 | 5/5 | 0/0/0 | 0 | 0 | 0 | 5220 | 115.4 |  |
| without--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 66 | 5/6 | 0/0/2 | 0 | 0 | 0 | 2543 | 28.8 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 69 | 4/4 | 0/0/4 | 0 | 0 | 0 | 8102 | 157.8 |  |
| without--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 74 | 8/8 | 0/0/4 | 0 | 0 | 0 | 7741 | 137.9 |  |
| without--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 61 | 7/7 | 0/0/3 | 0 | 0 | 0 | 2791 | 50.3 |  |
| without--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 59 | 7/7 | 0/0/3 | 0 | 0 | 0 | 2110 | 23.3 |  |
| without--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 75 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3449 | 49.8 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 41 | 5/6 | 0/0/4 | 0 | 0 | 0 | 2476 | 28.3 | must match /(descriptive|fold change)/ |
| without--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 53 | 6/7 | 0/0/4 | 0 | 0 | 0 | 2340 | 24.7 | must match /(criterion|threshold|rule|justif|reason)/ |
| without--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 58 | 6/6 | 0/0/7 | 0 | 0 | 0 | 3342 | 29.2 |  |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 66 | 3/3 | 0/0/4 | 0 | 0 | 0 | 7059 | 177.4 |  |
| without--claude-sonnet-5 | pathway-activity-n6 | 1 | plan_submitted | 63 | 7/7 | 0/0/2 | 0 | 0 | 0 | 8145 | 190.2 |  |
| without--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 59 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4871 | 61.4 | must match /limma|voom/ |
| without--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 63 | 7/7 | 0/0/1 | 0 | 0 | 0 | 1473 | 19.5 |  |
| without--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 66 | 8/8 | 0/0/3 | 0 | 0 | 0 | 3379 | 45.6 |  |
| without--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 83 | 8/8 | 0/0/2 | 0 | 0 | 0 | 2377 | 33.3 |  |
| without--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 69 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6433 | 237.6 |  |
| without--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 63 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3021 | 34 |  |
| without--claude-sonnet-5 | signature-scores-n6 | 1 | plan_submitted | 58 | 7/7 | 0/0/4 | 0 | 0 | 0 | 2713 | 38.3 |  |
| without--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 78 | 7/7 | 0/0/3 | 0 | 0 | 0 | 3760 | 47.5 |  |
| without--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 53 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6431 | 99.4 |  |
| without--claude-sonnet-5 | survival-n60 | 1 | plan_submitted | 54 | 5/7 | 0/0/2 | 0 | 0 | 0 | 1858 | 21.1 | must match /continuous/; must match /(number of events|events? (count|are counted)|counts? the events)/ |
| without--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 59 | 7/7 | 0/0/4 | 0 | 0 | 0 | 3970 | 48.7 |  |
| without--claude-sonnet-5 | tf-activity-n6 | 1 | plan_submitted | 38 | 5/7 | 0/0/2 | 0 | 0 | 0 | 2413 | 27 | must match /(regulon size|min_n|minsize|minimum (number of )?targets|at least (five|5) targets)/; must match /(per[- ]sample|each sample|every sample|sample[- ]level)/ |
| without--claude-sonnet-5 | tf-activity-python-n6 | 1 | plan_submitted | 46 | 8/8 | 0/0/2 | 0 | 0 | 0 | 5493 | 76.2 |  |
| without--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 70 | 6/6 | 0/0/2 | 0 | 0 | 0 | 2317 | 32.9 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 58 | 3/3 | 0/0/4 | 0 | 0 | 0 | 4618 | 92.8 |  |
| without--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 55 | 6/8 | 0/0/3 | 0 | 0 | 0 | 2749 | 32.2 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 68 | 6/7 | 0/0/4 | 0 | 0 | 0 | 7683 | 185.6 | must not match /voom\(/ |
| without--claude-sonnet-5 | transcript-usage-n6 | 1 | clarification_needed | 23 | 5/6 | 0/0/0 | 0 | 0 | 0 | 1411 | 19.4 | must match /(DEXSeq|DRIMSeq)/ |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 60 | 5/5 | 0/0/3 | 0 | 0 | 0 | 3305 | 44.5 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 59 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2114 | 23.6 |  |
| without--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 76 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5240 | 101.5 |  |
| without--claude-sonnet-5 | variance-partition-n6 | 1 | plan_submitted | 61 | 6/7 | 0/0/4 | 0 | 0 | 0 | 3147 | 35.6 | must match /(random effect|random term|\(1 ?\| ?)/ |
| without--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 71 | 6/6 | 0/0/3 | 0 | 0 | 0 | 15835 | 243.4 |  |
