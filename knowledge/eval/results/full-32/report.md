# Phase 0 campaign `full-32`

Judge: claude-fable-5-1.

Runs: 256. Judge verdicts: 256. Service for claim resolution: reachable.

| Arm | Runs | Planned | Rubric mean | Within-task SD | Expectations | Recommend rate | Check rate | Grounded steps | Claims resolve | DOIs in plans (in snapshot) | Snapshot pinned | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 64 | 100% | 93.3 | 2.0 | 98% | 100% | 97% | 100% | 2010/2011 | 269 (269) | 97% | 5.1 | 291791 | 10486 | 160006 | 128 |
| with--claude-sonnet-5 | 64 | 97% | 83.2 | 7.1 | 96% | 100% | 94% | 83% | 1659/1659 | 0 (0) | 91% | 13.7 | 1017245 | 7618 | 859536 | 95 |
| without--claude-opus-5 | 64 | 100% | 82.1 | 2.7 | 97% | 0% | 0% | 0% | 0/0 | 0 (0) | 0% | 4.1 | 152953 | 7188 | 75341 | 97 |
| without--claude-sonnet-5 | 64 | 100% | 62.6 | 4.5 | 96% | 0% | 0% | 0% | 0/1 | 0 (0) | 0% | 14.3 | 907987 | 5103 | 793002 | 86 |

## Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 9.3 | 9.0 | 9.2 | 9.6 | 9.5 | 9.5 | 8.8 | 9.7 |
| with--claude-sonnet-5 | 8.5 | 7.8 | 8.4 | 8.4 | 8.5 | 8.6 | 7.6 | 8.7 |
| without--claude-opus-5 | 8.9 | 8.5 | 8.0 | 8.6 | 9.0 | 7.9 | 7.4 | 7.5 |
| without--claude-sonnet-5 | 8.1 | 6.1 | 4.4 | 7.6 | 6.7 | 5.8 | 5.4 | 6.1 |

## Non-inferiority of the tools, paired by task (with minus without)

- claude-opus-5: difference 11.2 points over 32 tasks, 95% bootstrap interval [8.8, 13.8], margin 5: non-inferior
- claude-sonnet-5: difference 20.6 points over 32 tasks, 95% bootstrap interval [16.0, 24.9], margin 5: non-inferior

## Contrast of two arms, paired by task (with--claude-sonnet-5 minus without--claude-opus-5)

- difference 1.1 points over 32 tasks, 95% bootstrap interval [-3.7, 5.1], margin 5: non-inferior

## Per run

| Arm | Task | Run | Outcome | Rubric | Expectations | Grounded/flagged/ungrounded | Claims | Recommend | Check | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 98 | 4/4 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 10369 | 123 |  |
| with--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 99 | 4/4 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 10769 | 133.1 |  |
| with--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 93 | 4/4 | 4/1/0 | 33 (33 resolve) | 1 | 1 | 9932 | 122.6 |  |
| with--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 98 | 4/4 | 4/1/0 | 33 (33 resolve) | 1 | 1 | 10481 | 129.4 |  |
| with--claude-opus-5 | covariates-n6 | 1 | plan_submitted | 91 | 7/7 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 10119 | 123.8 |  |
| with--claude-opus-5 | covariates-n6 | 2 | plan_submitted | 94 | 7/7 | 4/0/0 | 35 (35 resolve) | 1 | 1 | 10993 | 133.6 |  |
| with--claude-opus-5 | enrichment-only-ranked | 1 | plan_submitted | 93 | 6/7 | 3/0/0 | 22 (22 resolve) | 1 | 1 | 7579 | 96.1 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| with--claude-opus-5 | enrichment-only-ranked | 2 | plan_submitted | 88 | 6/7 | 3/0/0 | 20 (19 resolve) | 1 | 1 | 7352 | 96 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| with--claude-opus-5 | fastq-input | 1 | clarification_needed | 70 | 4/5 | 0/0/0 | 0 | 1 | 0 | 2661 | 42.9 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-opus-5 | fastq-input | 2 | clarification_needed | 69 | 4/5 | 0/0/0 | 0 | 1 | 0 | 2343 | 39.9 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-opus-5 | gene-list-ora | 1 | plan_submitted | 83 | 6/6 | 4/0/0 | 24 (24 resolve) | 1 | 2 | 10130 | 122.6 |  |
| with--claude-opus-5 | gene-list-ora | 2 | plan_submitted | 88 | 6/6 | 4/0/0 | 21 (21 resolve) | 1 | 1 | 9400 | 121.1 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 99 | 4/4 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 9727 | 116.3 |  |
| with--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 96 | 4/4 | 5/0/0 | 40 (40 resolve) | 1 | 1 | 22431 | 237.6 |  |
| with--claude-opus-5 | interaction-python-n4 | 1 | plan_submitted | 96 | 8/8 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 10644 | 129.8 |  |
| with--claude-opus-5 | interaction-python-n4 | 2 | plan_submitted | 98 | 8/8 | 5/0/0 | 37 (37 resolve) | 1 | 2 | 12665 | 152.1 |  |
| with--claude-opus-5 | log-normalized-n6 | 1 | plan_submitted | 91 | 7/7 | 4/0/0 | 26 (26 resolve) | 1 | 2 | 10296 | 122.7 |  |
| with--claude-opus-5 | log-normalized-n6 | 2 | plan_submitted | 95 | 7/7 | 4/0/0 | 26 (26 resolve) | 1 | 2 | 10122 | 120.3 |  |
| with--claude-opus-5 | mouse-two-group-n6 | 1 | plan_submitted | 99 | 7/7 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 10223 | 121.5 |  |
| with--claude-opus-5 | mouse-two-group-n6 | 2 | plan_submitted | 100 | 7/7 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 11375 | 128 |  |
| with--claude-opus-5 | multi-group-3x4 | 1 | plan_submitted | 96 | 6/6 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 11196 | 137.2 |  |
| with--claude-opus-5 | multi-group-3x4 | 2 | plan_submitted | 98 | 6/6 | 5/0/0 | 37 (37 resolve) | 1 | 1 | 10326 | 135.2 |  |
| with--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 84 | 6/6 | 2/2/0 | 24 (24 resolve) | 1 | 1 | 7931 | 103.2 |  |
| with--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 86 | 5/6 | 2/2/0 | 23 (23 resolve) | 1 | 1 | 9291 | 114.7 | must not match /Wald test/ |
| with--claude-opus-5 | outlier-n5 | 1 | plan_submitted | 95 | 7/7 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 11923 | 169 |  |
| with--claude-opus-5 | outlier-n5 | 2 | plan_submitted | 93 | 7/7 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 12116 | 143 |  |
| with--claude-opus-5 | paired-3groups-n4 | 1 | plan_submitted | 98 | 6/6 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 11808 | 145.1 |  |
| with--claude-opus-5 | paired-3groups-n4 | 2 | plan_submitted | 98 | 6/6 | 5/0/0 | 40 (40 resolve) | 1 | 1 | 12187 | 149.4 |  |
| with--claude-opus-5 | paired-n5 | 1 | plan_submitted | 98 | 3/3 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 10532 | 128.2 |  |
| with--claude-opus-5 | paired-n5 | 2 | plan_submitted | 98 | 3/3 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 11234 | 135.6 |  |
| with--claude-opus-5 | population-n60 | 1 | plan_submitted | 93 | 6/6 | 4/1/0 | 34 (34 resolve) | 1 | 2 | 11018 | 135.1 |  |
| with--claude-opus-5 | population-n60 | 2 | plan_submitted | 94 | 6/6 | 5/0/0 | 34 (34 resolve) | 1 | 2 | 11799 | 147.6 |  |
| with--claude-opus-5 | python-enrichment-only | 1 | plan_submitted | 85 | 7/7 | 4/0/0 | 18 (18 resolve) | 1 | 1 | 7956 | 101 |  |
| with--claude-opus-5 | python-enrichment-only | 2 | plan_submitted | 75 | 7/7 | 4/0/0 | 19 (19 resolve) | 1 | 1 | 7146 | 92.9 |  |
| with--claude-opus-5 | python-two-group-n6 | 1 | plan_submitted | 96 | 8/8 | 4/1/0 | 35 (35 resolve) | 1 | 1 | 11202 | 131.8 |  |
| with--claude-opus-5 | python-two-group-n6 | 2 | plan_submitted | 99 | 8/8 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 13068 | 159.8 |  |
| with--claude-opus-5 | qc-only-n6 | 1 | plan_submitted | 94 | 8/8 | 3/0/0 | 6 (6 resolve) | 1 | 1 | 5138 | 62.7 |  |
| with--claude-opus-5 | qc-only-n6 | 2 | plan_submitted | 85 | 8/8 | 2/0/0 | 4 (4 resolve) | 1 | 1 | 5245 | 64.3 |  |
| with--claude-opus-5 | rsem-counts-n6 | 1 | plan_submitted | 98 | 6/6 | 4/0/0 | 36 (36 resolve) | 1 | 1 | 9263 | 116.6 |  |
| with--claude-opus-5 | rsem-counts-n6 | 2 | plan_submitted | 96 | 6/6 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 12672 | 150.8 |  |
| with--claude-opus-5 | sample-scores-gsva | 1 | plan_submitted | 96 | 6/6 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 10772 | 127.5 |  |
| with--claude-opus-5 | sample-scores-gsva | 2 | plan_submitted | 88 | 6/6 | 5/0/0 | 32 (32 resolve) | 1 | 1 | 10027 | 120.8 |  |
| with--claude-opus-5 | star-counts-n3 | 1 | plan_submitted | 98 | 7/7 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 9854 | 120.5 |  |
| with--claude-opus-5 | star-counts-n3 | 2 | plan_submitted | 98 | 7/7 | 4/0/0 | 34 (34 resolve) | 1 | 1 | 9026 | 108.9 |  |
| with--claude-opus-5 | strandedness-unknown-n3 | 1 | plan_submitted | 90 | 6/6 | 4/1/0 | 36 (36 resolve) | 1 | 1 | 11568 | 143.4 |  |
| with--claude-opus-5 | strandedness-unknown-n3 | 2 | plan_submitted | 89 | 6/6 | 4/1/0 | 37 (37 resolve) | 1 | 1 | 11990 | 146.1 |  |
| with--claude-opus-5 | suspected-batch-n6 | 1 | plan_submitted | 91 | 7/7 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 13588 | 159.8 |  |
| with--claude-opus-5 | suspected-batch-n6 | 2 | plan_submitted | 96 | 7/7 | 5/0/0 | 38 (38 resolve) | 1 | 1 | 12498 | 152.9 |  |
| with--claude-opus-5 | three-prime-n3 | 1 | plan_submitted | 95 | 6/6 | 5/0/0 | 37 (37 resolve) | 1 | 1 | 9273 | 114.5 |  |
| with--claude-opus-5 | three-prime-n3 | 2 | plan_submitted | 98 | 6/6 | 5/0/0 | 37 (37 resolve) | 1 | 2 | 10887 | 128.4 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 96 | 3/3 | 5/0/0 | 38 (38 resolve) | 1 | 1 | 10281 | 130.4 |  |
| with--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 96 | 3/3 | 5/0/0 | 40 (40 resolve) | 1 | 1 | 10200 | 123.5 |  |
| with--claude-opus-5 | total-rna-highdup-n6 | 1 | plan_submitted | 98 | 8/8 | 5/0/0 | 39 (39 resolve) | 1 | 1 | 11524 | 135.1 |  |
| with--claude-opus-5 | total-rna-highdup-n6 | 2 | plan_submitted | 94 | 7/8 | 5/0/0 | 37 (37 resolve) | 1 | 1 | 11118 | 137.5 | must match /(intron|intergenic|genomic DNA|gene body)/ |
| with--claude-opus-5 | tpm-input-n6 | 1 | plan_submitted | 93 | 7/7 | 4/0/0 | 26 (26 resolve) | 1 | 2 | 15497 | 169.2 |  |
| with--claude-opus-5 | tpm-input-n6 | 2 | plan_submitted | 95 | 7/7 | 4/0/0 | 25 (25 resolve) | 1 | 1 | 8397 | 105.1 |  |
| with--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 99 | 5/5 | 5/0/0 | 36 (36 resolve) | 1 | 1 | 11569 | 141.7 |  |
| with--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 96 | 5/5 | 5/0/0 | 35 (35 resolve) | 1 | 1 | 11141 | 134.4 |  |
| with--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 100 | 6/6 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 12159 | 144.7 |  |
| with--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 99 | 6/6 | 6/0/0 | 33 (33 resolve) | 1 | 1 | 13874 | 163.8 |  |
| with--claude-opus-5 | two-timepoints-n3 | 1 | plan_submitted | 95 | 6/6 | 3/1/0 | 41 (41 resolve) | 1 | 1 | 9299 | 112.1 |  |
| with--claude-opus-5 | two-timepoints-n3 | 2 | plan_submitted | 94 | 6/6 | 5/0/0 | 42 (42 resolve) | 1 | 1 | 10027 | 121.4 |  |
| with--claude-opus-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 95 | 5/6 | 4/0/0 | 35 (35 resolve) | 1 | 1 | 11278 | 141.3 | must not match /KEGG/ |
| with--claude-opus-5 | zebrafish-two-group-n3 | 2 | plan_submitted | 96 | 6/6 | 5/0/0 | 34 (34 resolve) | 1 | 1 | 12595 | 155.7 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 86 | 4/4 | 4/0/1 | 23 (23 resolve) | 2 | 4 | 9234 | 95.1 |  |
| with--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 94 | 4/4 | 3/0/1 | 32 (32 resolve) | 1 | 1 | 6675 | 68.7 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 91 | 4/4 | 2/1/1 | 26 (26 resolve) | 1 | 1 | 5289 | 70.9 |  |
| with--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 91 | 4/4 | 2/1/1 | 33 (33 resolve) | 1 | 1 | 6987 | 85.4 |  |
| with--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 84 | 6/7 | 3/0/1 | 31 (31 resolve) | 2 | 3 | 7998 | 92.1 | must match /(center|centre|scale)/ |
| with--claude-sonnet-5 | covariates-n6 | 2 | plan_submitted | 85 | 6/7 | 4/0/1 | 28 (28 resolve) | 1 | 3 | 9236 | 100.9 | must not match /regress(es|ed)? (out )?(the )?(sex|age|covariates?)[^.]* (from|out of) the counts/ |
| with--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 76 | 7/7 | 2/0/2 | 14 (14 resolve) | 1 | 1 | 4314 | 50.3 |  |
| with--claude-sonnet-5 | enrichment-only-ranked | 2 | plan_submitted | 81 | 7/7 | 4/0/0 | 12 (12 resolve) | 1 | 1 | 5172 | 57.5 |  |
| with--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 31 | 5/5 | 0/0/0 | 0 | 1 | 0 | 2715 | 39 |  |
| with--claude-sonnet-5 | fastq-input | 2 | clarification_needed | 48 | 5/5 | 0/0/0 | 0 | 1 | 0 | 2896 | 35.1 |  |
| with--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 68 | 6/6 | 0/0/4 | 0 | 1 | 1 | 5263 | 77.3 |  |
| with--claude-sonnet-5 | gene-list-ora | 2 | plan_submitted | 70 | 6/6 | 0/0/4 | 0 | 1 | 1 | 5633 | 86.1 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 95 | 4/4 | 3/0/1 | 36 (36 resolve) | 1 | 1 | 6865 | 71.5 |  |
| with--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 99 | 4/4 | 3/0/1 | 38 (38 resolve) | 1 | 1 | 7497 | 75.3 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 95 | 8/8 | 4/0/0 | 34 (34 resolve) | 2 | 1 | 25962 | 452.7 |  |
| with--claude-sonnet-5 | interaction-python-n4 | 2 | plan_submitted | 73 | 8/8 | 6/0/1 | 33 (33 resolve) | 2 | 2 | 12286 | 160.2 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 88 | 7/7 | 4/0/0 | 22 (22 resolve) | 1 | 2 | 6706 | 122.3 |  |
| with--claude-sonnet-5 | log-normalized-n6 | 2 | plan_submitted | 85 | 7/7 | 3/0/1 | 22 (22 resolve) | 1 | 2 | 7084 | 75.6 |  |
| with--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 98 | 6/7 | 3/0/1 | 31 (31 resolve) | 1 | 1 | 6385 | 64 | must match /(ortholog|homolog|msigdbr|species)/ |
| with--claude-sonnet-5 | mouse-two-group-n6 | 2 | plan_submitted | 100 | 7/7 | 3/0/1 | 32 (32 resolve) | 1 | 1 | 7311 | 72.6 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 89 | 6/6 | 5/0/1 | 37 (37 resolve) | 1 | 1 | 8707 | 90.9 |  |
| with--claude-sonnet-5 | multi-group-3x4 | 2 | plan_submitted | 80 | 6/6 | 3/0/1 | 34 (34 resolve) | 1 | 3 | 7201 | 73.3 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 80 | 6/6 | 3/1/1 | 14 (14 resolve) | 1 | 3 | 8637 | 106.1 |  |
| with--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 78 | 6/6 | 3/1/1 | 13 (13 resolve) | 1 | 3 | 8814 | 112 |  |
| with--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 88 | 7/7 | 5/0/0 | 30 (30 resolve) | 1 | 1 | 7660 | 79.7 |  |
| with--claude-sonnet-5 | outlier-n5 | 2 | error | 0 | 2/7 | 0/0/0 | 0 | 1 | 0 | 790 | 13.2 | must match /sample_03/; must match /(PCA|principal component)/; must match /(down-?weight|arrayWeights|robust|Cook)/; must match /(criterion|threshold|rule|justif|reason)/; must match /(both|with and without|sensitivity)/ |
| with--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 96 | 6/6 | 3/0/1 | 36 (36 resolve) | 1 | 3 | 7906 | 77.1 |  |
| with--claude-sonnet-5 | paired-3groups-n4 | 2 | plan_submitted | 98 | 6/6 | 5/0/0 | 37 (37 resolve) | 1 | 1 | 8629 | 88.3 |  |
| with--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 94 | 3/3 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 6871 | 77.2 |  |
| with--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 96 | 3/3 | 3/0/1 | 34 (34 resolve) | 1 | 1 | 6747 | 74.5 |  |
| with--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 86 | 6/6 | 3/0/1 | 33 (33 resolve) | 1 | 2 | 9444 | 117 |  |
| with--claude-sonnet-5 | population-n60 | 2 | plan_submitted | 86 | 6/6 | 6/0/0 | 32 (32 resolve) | 1 | 2 | 9416 | 98.6 |  |
| with--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 69 | 7/7 | 3/0/0 | 16 (16 resolve) | 1 | 3 | 7079 | 83.1 |  |
| with--claude-sonnet-5 | python-enrichment-only | 2 | plan_submitted | 69 | 7/7 | 3/0/0 | 13 (13 resolve) | 1 | 1 | 4594 | 57.2 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 98 | 8/8 | 3/0/1 | 33 (33 resolve) | 1 | 2 | 9071 | 89.7 |  |
| with--claude-sonnet-5 | python-two-group-n6 | 2 | clarification_needed | 0 | 3/8 | 0/0/0 | 0 | 1 | 1 | 2844 | 74.4 | must match /PyDESeq2/; must match /gseapy/; must match /hallmark/; must match /python/; must match /(library size|sequencing depth|low[- ]depth|shallow)/ |
| with--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 78 | 8/8 | 1/0/1 | 3 (3 resolve) | 1 | 1 | 3156 | 38.6 |  |
| with--claude-sonnet-5 | qc-only-n6 | 2 | plan_submitted | 88 | 8/8 | 1/0/0 | 2 (2 resolve) | 1 | 1 | 3087 | 32.2 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 84 | 6/6 | 3/1/0 | 30 (30 resolve) | 1 | 4 | 9358 | 96.6 |  |
| with--claude-sonnet-5 | rsem-counts-n6 | 2 | plan_submitted | 81 | 6/6 | 4/0/1 | 31 (31 resolve) | 2 | 4 | 15492 | 333.5 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 89 | 6/6 | 4/0/1 | 23 (23 resolve) | 1 | 1 | 6489 | 72.9 |  |
| with--claude-sonnet-5 | sample-scores-gsva | 2 | plan_submitted | 89 | 6/6 | 3/0/1 | 25 (25 resolve) | 1 | 1 | 6113 | 64.7 |  |
| with--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 95 | 7/7 | 3/0/1 | 33 (33 resolve) | 1 | 1 | 6997 | 75.8 |  |
| with--claude-sonnet-5 | star-counts-n3 | 2 | plan_submitted | 91 | 7/7 | 5/0/0 | 31 (31 resolve) | 1 | 1 | 7949 | 87.4 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 76 | 6/6 | 4/0/0 | 34 (34 resolve) | 2 | 3 | 11457 | 191.8 |  |
| with--claude-sonnet-5 | strandedness-unknown-n3 | 2 | plan_submitted | 88 | 6/6 | 4/0/0 | 35 (35 resolve) | 1 | 1 | 6733 | 77.8 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 86 | 7/7 | 4/0/0 | 37 (37 resolve) | 1 | 0 | 6138 | 64.6 |  |
| with--claude-sonnet-5 | suspected-batch-n6 | 2 | plan_submitted | 88 | 7/7 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 7690 | 82.8 |  |
| with--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 94 | 6/6 | 3/0/1 | 38 (38 resolve) | 1 | 1 | 6909 | 75.7 |  |
| with--claude-sonnet-5 | three-prime-n3 | 2 | plan_submitted | 95 | 6/6 | 3/0/1 | 37 (37 resolve) | 1 | 1 | 7161 | 78.6 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 93 | 3/3 | 6/0/0 | 34 (34 resolve) | 1 | 1 | 8904 | 99.9 |  |
| with--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 85 | 3/3 | 6/0/0 | 27 (27 resolve) | 1 | 3 | 12025 | 182.4 |  |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 86 | 6/8 | 4/0/1 | 31 (31 resolve) | 1 | 1 | 8063 | 95.5 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| with--claude-sonnet-5 | total-rna-highdup-n6 | 2 | plan_submitted | 89 | 6/8 | 4/0/0 | 34 (34 resolve) | 1 | 1 | 8328 | 111.5 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| with--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 84 | 7/7 | 3/0/1 | 18 (18 resolve) | 1 | 3 | 8008 | 88.5 |  |
| with--claude-sonnet-5 | tpm-input-n6 | 2 | plan_submitted | 88 | 7/7 | 4/0/0 | 23 (23 resolve) | 1 | 2 | 8389 | 106.9 |  |
| with--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 95 | 5/5 | 4/0/0 | 33 (33 resolve) | 1 | 1 | 7610 | 92.7 |  |
| with--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 93 | 5/5 | 5/0/0 | 33 (33 resolve) | 1 | 1 | 7377 | 76.9 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 96 | 6/6 | 4/0/1 | 33 (33 resolve) | 1 | 1 | 7633 | 81.2 |  |
| with--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 98 | 6/6 | 4/0/1 | 33 (33 resolve) | 1 | 1 | 6880 | 72.3 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 88 | 6/6 | 4/0/0 | 31 (31 resolve) | 1 | 4 | 8413 | 99.3 |  |
| with--claude-sonnet-5 | two-timepoints-n3 | 2 | plan_submitted | 85 | 6/6 | 3/0/1 | 35 (35 resolve) | 1 | 1 | 8245 | 88.2 |  |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 91 | 5/6 | 3/0/1 | 30 (30 resolve) | 1 | 1 | 7656 | 108.7 | must not match /KEGG/ |
| with--claude-sonnet-5 | zebrafish-two-group-n3 | 2 | plan_submitted | 98 | 6/6 | 3/0/1 | 29 (29 resolve) | 1 | 1 | 9368 | 131.6 |  |
| without--claude-opus-5 | batch-balanced-n6 | 1 | plan_submitted | 88 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6618 | 91.9 |  |
| without--claude-opus-5 | batch-balanced-n6 | 2 | plan_submitted | 90 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6569 | 91.9 |  |
| without--claude-opus-5 | confounded-batch-n6 | 1 | plan_submitted | 85 | 4/4 | 0/0/4 | 0 | 0 | 0 | 15854 | 182 |  |
| without--claude-opus-5 | confounded-batch-n6 | 2 | plan_submitted | 85 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6850 | 99 |  |
| without--claude-opus-5 | covariates-n6 | 1 | plan_submitted | 83 | 6/7 | 0/0/4 | 0 | 0 | 0 | 7297 | 99.4 | must match /(center|centre|scale)/ |
| without--claude-opus-5 | covariates-n6 | 2 | plan_submitted | 90 | 7/7 | 0/0/4 | 0 | 0 | 0 | 7373 | 103.6 |  |
| without--claude-opus-5 | enrichment-only-ranked | 1 | plan_submitted | 76 | 5/7 | 0/0/3 | 0 | 0 | 0 | 4961 | 68.1 | must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/; must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--claude-opus-5 | enrichment-only-ranked | 2 | plan_submitted | 78 | 6/7 | 0/0/3 | 0 | 0 | 0 | 5747 | 78.9 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--claude-opus-5 | fastq-input | 1 | clarification_needed | 39 | 4/5 | 0/0/0 | 0 | 0 | 0 | 1494 | 26.6 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| without--claude-opus-5 | fastq-input | 2 | clarification_needed | 28 | 4/5 | 0/0/0 | 0 | 0 | 0 | 2144 | 40 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| without--claude-opus-5 | gene-list-ora | 1 | plan_submitted | 88 | 6/6 | 0/0/2 | 0 | 0 | 0 | 8649 | 102.4 |  |
| without--claude-opus-5 | gene-list-ora | 2 | plan_submitted | 78 | 5/6 | 0/0/3 | 0 | 0 | 0 | 5459 | 72.7 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-opus-5 | interaction-2x2-n4 | 1 | plan_submitted | 93 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6090 | 84.2 |  |
| without--claude-opus-5 | interaction-2x2-n4 | 2 | plan_submitted | 86 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6689 | 95.1 |  |
| without--claude-opus-5 | interaction-python-n4 | 1 | plan_submitted | 86 | 8/8 | 0/0/4 | 0 | 0 | 0 | 6801 | 90.7 |  |
| without--claude-opus-5 | interaction-python-n4 | 2 | plan_submitted | 81 | 8/8 | 0/0/6 | 0 | 0 | 0 | 10897 | 146.4 |  |
| without--claude-opus-5 | log-normalized-n6 | 1 | plan_submitted | 79 | 7/7 | 0/0/3 | 0 | 0 | 0 | 4854 | 68.5 |  |
| without--claude-opus-5 | log-normalized-n6 | 2 | plan_submitted | 86 | 7/7 | 0/0/3 | 0 | 0 | 0 | 11323 | 134.8 |  |
| without--claude-opus-5 | mouse-two-group-n6 | 1 | plan_submitted | 94 | 7/7 | 0/0/3 | 0 | 0 | 0 | 5759 | 79.2 |  |
| without--claude-opus-5 | mouse-two-group-n6 | 2 | plan_submitted | 90 | 7/7 | 0/0/4 | 0 | 0 | 0 | 6560 | 89.6 |  |
| without--claude-opus-5 | multi-group-3x4 | 1 | plan_submitted | 88 | 6/6 | 0/0/5 | 0 | 0 | 0 | 7315 | 98.6 |  |
| without--claude-opus-5 | multi-group-3x4 | 2 | plan_submitted | 86 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6205 | 84.4 |  |
| without--claude-opus-5 | no-replicates-1v1 | 1 | plan_submitted | 53 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4407 | 63.4 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | no-replicates-1v1 | 2 | plan_submitted | 53 | 6/6 | 0/0/3 | 0 | 0 | 0 | 4607 | 63.8 |  |
| without--claude-opus-5 | outlier-n5 | 1 | plan_submitted | 83 | 7/7 | 0/0/3 | 0 | 0 | 0 | 5438 | 78.5 |  |
| without--claude-opus-5 | outlier-n5 | 2 | plan_submitted | 88 | 7/7 | 0/0/5 | 0 | 0 | 0 | 8209 | 110.7 |  |
| without--claude-opus-5 | paired-3groups-n4 | 1 | plan_submitted | 90 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7837 | 115.4 |  |
| without--claude-opus-5 | paired-3groups-n4 | 2 | plan_submitted | 89 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6792 | 95.1 |  |
| without--claude-opus-5 | paired-n5 | 1 | plan_submitted | 91 | 3/3 | 0/0/5 | 0 | 0 | 0 | 13523 | 154.6 |  |
| without--claude-opus-5 | paired-n5 | 2 | plan_submitted | 85 | 3/3 | 0/0/3 | 0 | 0 | 0 | 5733 | 78.3 |  |
| without--claude-opus-5 | population-n60 | 1 | plan_submitted | 83 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7614 | 106.2 |  |
| without--claude-opus-5 | population-n60 | 2 | plan_submitted | 81 | 6/6 | 0/0/4 | 0 | 0 | 0 | 8509 | 120.9 |  |
| without--claude-opus-5 | python-enrichment-only | 1 | plan_submitted | 69 | 7/7 | 0/0/2 | 0 | 0 | 0 | 4424 | 61.3 |  |
| without--claude-opus-5 | python-enrichment-only | 2 | plan_submitted | 68 | 7/7 | 0/0/3 | 0 | 0 | 0 | 4968 | 66.8 |  |
| without--claude-opus-5 | python-two-group-n6 | 1 | plan_submitted | 93 | 8/8 | 0/0/3 | 0 | 0 | 0 | 6319 | 89.3 |  |
| without--claude-opus-5 | python-two-group-n6 | 2 | plan_submitted | 89 | 8/8 | 0/0/3 | 0 | 0 | 0 | 10271 | 117.6 |  |
| without--claude-opus-5 | qc-only-n6 | 1 | plan_submitted | 90 | 8/8 | 0/0/3 | 0 | 0 | 0 | 5143 | 72.1 |  |
| without--claude-opus-5 | qc-only-n6 | 2 | plan_submitted | 91 | 8/8 | 0/0/3 | 0 | 0 | 0 | 4986 | 70.7 |  |
| without--claude-opus-5 | rsem-counts-n6 | 1 | plan_submitted | 80 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5292 | 75.5 |  |
| without--claude-opus-5 | rsem-counts-n6 | 2 | plan_submitted | 83 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6600 | 89.8 |  |
| without--claude-opus-5 | sample-scores-gsva | 1 | plan_submitted | 96 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5700 | 79.6 |  |
| without--claude-opus-5 | sample-scores-gsva | 2 | plan_submitted | 88 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6328 | 84.6 |  |
| without--claude-opus-5 | star-counts-n3 | 1 | plan_submitted | 89 | 7/7 | 0/0/4 | 0 | 0 | 0 | 12925 | 151.1 |  |
| without--claude-opus-5 | star-counts-n3 | 2 | plan_submitted | 89 | 6/7 | 0/0/4 | 0 | 0 | 0 | 6405 | 87.7 | must not match /(run|use|apply|call) tximport/ |
| without--claude-opus-5 | strandedness-unknown-n3 | 1 | plan_submitted | 83 | 6/6 | 0/0/4 | 0 | 0 | 0 | 7991 | 113.6 |  |
| without--claude-opus-5 | strandedness-unknown-n3 | 2 | plan_submitted | 79 | 6/6 | 0/0/5 | 0 | 0 | 0 | 9626 | 151.6 |  |
| without--claude-opus-5 | suspected-batch-n6 | 1 | plan_submitted | 74 | 7/7 | 0/0/4 | 0 | 0 | 0 | 7250 | 103.3 |  |
| without--claude-opus-5 | suspected-batch-n6 | 2 | plan_submitted | 73 | 7/7 | 0/0/5 | 0 | 0 | 0 | 8499 | 131.9 |  |
| without--claude-opus-5 | three-prime-n3 | 1 | plan_submitted | 88 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5914 | 84.8 |  |
| without--claude-opus-5 | three-prime-n3 | 2 | plan_submitted | 88 | 6/6 | 0/0/4 | 0 | 0 | 0 | 12093 | 137.2 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 1 | plan_submitted | 79 | 3/3 | 0/0/4 | 0 | 0 | 0 | 5589 | 78 |  |
| without--claude-opus-5 | timecourse-2x4-n3 | 2 | plan_submitted | 84 | 3/3 | 0/0/4 | 0 | 0 | 0 | 6160 | 86.2 |  |
| without--claude-opus-5 | total-rna-highdup-n6 | 1 | plan_submitted | 86 | 7/8 | 0/0/3 | 0 | 0 | 0 | 5811 | 81.5 | must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-opus-5 | total-rna-highdup-n6 | 2 | plan_submitted | 89 | 7/8 | 0/0/4 | 0 | 0 | 0 | 7637 | 108 | must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-opus-5 | tpm-input-n6 | 1 | plan_submitted | 80 | 7/7 | 0/0/4 | 0 | 0 | 0 | 6031 | 81.6 |  |
| without--claude-opus-5 | tpm-input-n6 | 2 | plan_submitted | 83 | 7/7 | 0/0/3 | 0 | 0 | 0 | 5822 | 80.6 |  |
| without--claude-opus-5 | two-group-n3 | 1 | plan_submitted | 85 | 5/5 | 0/0/3 | 0 | 0 | 0 | 5633 | 78.8 |  |
| without--claude-opus-5 | two-group-n3 | 2 | plan_submitted | 90 | 5/5 | 0/0/4 | 0 | 0 | 0 | 14407 | 165.1 |  |
| without--claude-opus-5 | two-group-n6-enrich | 1 | plan_submitted | 90 | 6/6 | 0/0/3 | 0 | 0 | 0 | 10928 | 127.5 |  |
| without--claude-opus-5 | two-group-n6-enrich | 2 | plan_submitted | 83 | 6/6 | 0/0/3 | 0 | 0 | 0 | 5784 | 80.2 |  |
| without--claude-opus-5 | two-timepoints-n3 | 1 | plan_submitted | 85 | 6/6 | 0/0/4 | 0 | 0 | 0 | 11217 | 132.3 |  |
| without--claude-opus-5 | two-timepoints-n3 | 2 | plan_submitted | 83 | 6/6 | 0/0/4 | 0 | 0 | 0 | 6127 | 85.2 |  |
| without--claude-opus-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 86 | 6/6 | 0/0/4 | 0 | 0 | 0 | 8077 | 130.2 |  |
| without--claude-opus-5 | zebrafish-two-group-n3 | 2 | plan_submitted | 84 | 5/6 | 0/0/2 | 0 | 0 | 0 | 5902 | 89.8 | must not match /KEGG/ |
| without--claude-sonnet-5 | batch-balanced-n6 | 1 | plan_submitted | 69 | 4/4 | 0/0/2 | 0 | 0 | 0 | 2247 | 25.5 |  |
| without--claude-sonnet-5 | batch-balanced-n6 | 2 | plan_submitted | 69 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2752 | 32.6 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 1 | plan_submitted | 55 | 4/4 | 0/0/3 | 0 | 0 | 0 | 2390 | 32.1 |  |
| without--claude-sonnet-5 | confounded-batch-n6 | 2 | plan_submitted | 64 | 4/4 | 0/0/4 | 0 | 0 | 0 | 6264 | 59.5 |  |
| without--claude-sonnet-5 | covariates-n6 | 1 | plan_submitted | 59 | 6/7 | 0/0/3 | 0 | 0 | 0 | 2648 | 29.5 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | covariates-n6 | 2 | plan_submitted | 54 | 6/7 | 0/0/4 | 0 | 0 | 0 | 2858 | 37.4 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | enrichment-only-ranked | 1 | plan_submitted | 61 | 7/7 | 0/0/3 | 0 | 0 | 0 | 2654 | 30.9 |  |
| without--claude-sonnet-5 | enrichment-only-ranked | 2 | plan_submitted | 54 | 6/7 | 0/0/4 | 0 | 0 | 0 | 4511 | 42.8 | must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/ |
| without--claude-sonnet-5 | fastq-input | 1 | clarification_needed | 28 | 5/5 | 0/0/0 | 0 | 0 | 0 | 5105 | 86.8 |  |
| without--claude-sonnet-5 | fastq-input | 2 | clarification_needed | 38 | 5/5 | 0/0/0 | 0 | 0 | 0 | 7603 | 135.9 |  |
| without--claude-sonnet-5 | gene-list-ora | 1 | plan_submitted | 65 | 6/6 | 0/0/2 | 0 | 0 | 0 | 1963 | 32.7 |  |
| without--claude-sonnet-5 | gene-list-ora | 2 | plan_submitted | 71 | 5/6 | 0/0/2 | 0 | 0 | 0 | 2737 | 33.3 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-sonnet-5 | interaction-2x2-n4 | 1 | plan_submitted | 69 | 4/4 | 0/0/4 | 0 | 0 | 0 | 4394 | 64.6 |  |
| without--claude-sonnet-5 | interaction-2x2-n4 | 2 | plan_submitted | 65 | 4/4 | 0/0/4 | 0 | 0 | 0 | 3150 | 37.1 |  |
| without--claude-sonnet-5 | interaction-python-n4 | 1 | plan_submitted | 65 | 7/8 | 0/0/5 | 0 | 0 | 0 | 22149 | 472.7 | must match /python/ |
| without--claude-sonnet-5 | interaction-python-n4 | 2 | plan_submitted | 59 | 7/8 | 0/0/4 | 0 | 0 | 0 | 2791 | 34.1 | must match /python/ |
| without--claude-sonnet-5 | log-normalized-n6 | 1 | plan_submitted | 55 | 6/7 | 0/0/2 | 0 | 0 | 0 | 2442 | 32.3 | must match /trend/ |
| without--claude-sonnet-5 | log-normalized-n6 | 2 | plan_submitted | 69 | 7/7 | 0/0/4 | 0 | 0 | 0 | 12890 | 272.7 |  |
| without--claude-sonnet-5 | mouse-two-group-n6 | 1 | plan_submitted | 54 | 6/7 | 0/0/3 | 0 | 0 | 0 | 2907 | 34.3 | must match /(ortholog|homolog|msigdbr|species)/ |
| without--claude-sonnet-5 | mouse-two-group-n6 | 2 | plan_submitted | 64 | 7/7 | 0/0/2 | 0 | 0 | 0 | 2897 | 36.4 |  |
| without--claude-sonnet-5 | multi-group-3x4 | 1 | plan_submitted | 74 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3227 | 36.1 |  |
| without--claude-sonnet-5 | multi-group-3x4 | 2 | plan_submitted | 74 | 6/6 | 0/0/5 | 0 | 0 | 0 | 3821 | 46.6 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 1 | plan_submitted | 43 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2121 | 24.2 |  |
| without--claude-sonnet-5 | no-replicates-1v1 | 2 | plan_submitted | 30 | 5/6 | 0/0/3 | 0 | 0 | 0 | 4699 | 136.3 | must not match /FDR < 0\.05/ |
| without--claude-sonnet-5 | outlier-n5 | 1 | plan_submitted | 55 | 7/7 | 0/0/5 | 0 | 0 | 0 | 3221 | 40.7 |  |
| without--claude-sonnet-5 | outlier-n5 | 2 | plan_submitted | 50 | 7/7 | 0/0/4 | 0 | 0 | 0 | 3015 | 41.6 |  |
| without--claude-sonnet-5 | paired-3groups-n4 | 1 | plan_submitted | 74 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3795 | 64.1 |  |
| without--claude-sonnet-5 | paired-3groups-n4 | 2 | plan_submitted | 65 | 6/6 | 0/0/7 | 0 | 0 | 0 | 3311 | 36.2 |  |
| without--claude-sonnet-5 | paired-n5 | 1 | plan_submitted | 59 | 3/3 | 0/0/4 | 0 | 0 | 0 | 3096 | 33.5 |  |
| without--claude-sonnet-5 | paired-n5 | 2 | plan_submitted | 59 | 3/3 | 0/0/3 | 0 | 0 | 0 | 2606 | 30.6 |  |
| without--claude-sonnet-5 | population-n60 | 1 | plan_submitted | 61 | 5/6 | 0/0/4 | 0 | 0 | 0 | 3847 | 43.3 | must match /limma|voom/ |
| without--claude-sonnet-5 | population-n60 | 2 | plan_submitted | 64 | 5/6 | 0/0/3 | 0 | 0 | 0 | 6876 | 142.5 | must match /limma|voom/ |
| without--claude-sonnet-5 | python-enrichment-only | 1 | plan_submitted | 60 | 7/7 | 0/0/2 | 0 | 0 | 0 | 1547 | 19.4 |  |
| without--claude-sonnet-5 | python-enrichment-only | 2 | plan_submitted | 71 | 7/7 | 0/0/1 | 0 | 0 | 0 | 1930 | 24.1 |  |
| without--claude-sonnet-5 | python-two-group-n6 | 1 | plan_submitted | 61 | 8/8 | 0/0/3 | 0 | 0 | 0 | 2897 | 35.4 |  |
| without--claude-sonnet-5 | python-two-group-n6 | 2 | plan_submitted | 64 | 8/8 | 0/0/3 | 0 | 0 | 0 | 3060 | 36.9 |  |
| without--claude-sonnet-5 | qc-only-n6 | 1 | plan_submitted | 85 | 8/8 | 0/0/1 | 0 | 0 | 0 | 1934 | 25 |  |
| without--claude-sonnet-5 | qc-only-n6 | 2 | plan_submitted | 73 | 8/8 | 0/0/4 | 0 | 0 | 0 | 2724 | 32.2 |  |
| without--claude-sonnet-5 | rsem-counts-n6 | 1 | plan_submitted | 55 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2669 | 30.3 |  |
| without--claude-sonnet-5 | rsem-counts-n6 | 2 | plan_submitted | 69 | 6/6 | 0/0/4 | 0 | 0 | 0 | 17577 | 434.2 |  |
| without--claude-sonnet-5 | sample-scores-gsva | 1 | plan_submitted | 71 | 6/6 | 0/0/4 | 0 | 0 | 0 | 2540 | 27.4 |  |
| without--claude-sonnet-5 | sample-scores-gsva | 2 | plan_submitted | 66 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2672 | 35.8 |  |
| without--claude-sonnet-5 | star-counts-n3 | 1 | plan_submitted | 64 | 7/7 | 0/0/2 | 0 | 0 | 0 | 3722 | 73.9 |  |
| without--claude-sonnet-5 | star-counts-n3 | 2 | plan_submitted | 71 | 7/7 | 0/0/3 | 0 | 0 | 0 | 3371 | 44.2 |  |
| without--claude-sonnet-5 | strandedness-unknown-n3 | 1 | plan_submitted | 53 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2993 | 32.6 |  |
| without--claude-sonnet-5 | strandedness-unknown-n3 | 2 | plan_submitted | 45 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3101 | 34.6 |  |
| without--claude-sonnet-5 | suspected-batch-n6 | 1 | plan_submitted | 51 | 7/7 | 0/0/4 | 0 | 0 | 0 | 5918 | 57.3 |  |
| without--claude-sonnet-5 | suspected-batch-n6 | 2 | plan_submitted | 60 | 7/7 | 0/0/4 | 0 | 0 | 0 | 3072 | 33.9 |  |
| without--claude-sonnet-5 | three-prime-n3 | 1 | plan_submitted | 66 | 6/6 | 0/0/3 | 0 | 0 | 0 | 1962 | 22.8 |  |
| without--claude-sonnet-5 | three-prime-n3 | 2 | plan_submitted | 74 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3034 | 36.1 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 1 | plan_submitted | 75 | 3/3 | 0/0/5 | 0 | 0 | 0 | 19635 | 427.8 |  |
| without--claude-sonnet-5 | timecourse-2x4-n3 | 2 | plan_submitted | 76 | 3/3 | 0/0/4 | 0 | 0 | 0 | 12573 | 329.5 |  |
| without--claude-sonnet-5 | total-rna-highdup-n6 | 1 | plan_submitted | 65 | 6/8 | 0/0/3 | 0 | 0 | 0 | 3866 | 63.5 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | total-rna-highdup-n6 | 2 | plan_submitted | 66 | 6/8 | 0/0/4 | 0 | 0 | 0 | 10496 | 343.2 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | tpm-input-n6 | 1 | plan_submitted | 70 | 7/7 | 1/0/2 | 1 (0 resolve) | 0 | 0 | 16561 | 279.3 |  |
| without--claude-sonnet-5 | tpm-input-n6 | 2 | plan_submitted | 71 | 7/7 | 0/0/3 | 0 | 0 | 0 | 7801 | 163.9 |  |
| without--claude-sonnet-5 | two-group-n3 | 1 | plan_submitted | 78 | 5/5 | 0/0/3 | 0 | 0 | 0 | 3446 | 40.8 |  |
| without--claude-sonnet-5 | two-group-n3 | 2 | plan_submitted | 79 | 5/5 | 0/0/4 | 0 | 0 | 0 | 2902 | 32.2 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 1 | plan_submitted | 56 | 6/6 | 0/0/3 | 0 | 0 | 0 | 3119 | 37.7 |  |
| without--claude-sonnet-5 | two-group-n6-enrich | 2 | plan_submitted | 73 | 6/6 | 0/0/4 | 0 | 0 | 0 | 3847 | 47.4 |  |
| without--claude-sonnet-5 | two-timepoints-n3 | 1 | plan_submitted | 54 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2527 | 29.1 |  |
| without--claude-sonnet-5 | two-timepoints-n3 | 2 | plan_submitted | 55 | 6/6 | 0/0/3 | 0 | 0 | 0 | 2649 | 31.2 |  |
| without--claude-sonnet-5 | zebrafish-two-group-n3 | 1 | plan_submitted | 68 | 5/6 | 0/0/3 | 0 | 0 | 0 | 14783 | 178.3 | must not match /KEGG/ |
| without--claude-sonnet-5 | zebrafish-two-group-n3 | 2 | plan_submitted | 73 | 5/6 | 0/0/3 | 0 | 0 | 0 | 14653 | 194.9 | must not match /KEGG/ |
