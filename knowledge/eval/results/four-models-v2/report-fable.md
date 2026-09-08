# Phase 0 campaign `four-models-v2`

Manifest: `/Users/radu/Development/projects/inflexa/inflexa/knowledge/eval/results/four-models-v2/manifest.json` (sha256:8bceb1f00c635b270aa3bf8fab211823b39f9bd4800a66204eea15d467fb9623), frozen at 2026-09-07T18:08:55.625Z, corpus sha256:40605ae40583456c222ca9f595c1a4c8c995b7a124a1f35c57cb03911412e5e8.
Calibration: absent, thus every decision is uncalibrated.
Judge: claude-fable-5-1 (tag fable).
Runs: 288. Judge verdicts: 288 (0 failed, 0 absent). Service for claim resolution: reachable.
Statistics: margin 5, one-sided alpha 0.025, cluster by pattern, 4000 resamples.
Family: glm_with vs sonnet_without [primary, primary]; glm_with vs opus_without [primary]; qwen_with vs sonnet_without [primary]; qwen_with vs opus_without [primary]; glm_with vs glm_without [primary]; glm_with vs qwen_without [primary]; qwen_with vs glm_without [primary]; qwen_with vs qwen_without [primary]; sonnet_with vs sonnet_without [primary]; sonnet_with vs opus_without [primary]; opus_with vs sonnet_without [primary]; opus_with vs opus_without [primary]; glm_with vs sonnet_with [primary]; glm_with vs opus_with [primary]; qwen_with vs sonnet_with [primary]; qwen_with vs opus_with [primary].

## Split development, seed 1: 288 runs, 48 tasks

| Arm | Runs | Judged | Usage missing | Planned | Rubric mean | Within-task SD | Variability | Expectations | Recommend rate | Check rate | Grounded (applicable) | Pinned steps | Claims A/I/U/F | Fabricated refs | Valid completion | DE recall | DE FDR | Failed steps | Tok/step | Tool calls | In tok | Out tok | Cache tok | Time s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 48 | 48/48 | 0 | 100% | 88.9 | n/a | unknown | 99% | 100% | 94% | 77% | 99% | 935/1/0/0 | 0 | n/a | n/a | n/a | n/a | n/a | 4.3 | 230097 | 10170 | 123286 | 117 |
| with--claude-sonnet-5 | 48 | 48/48 | 0 | 100% | 84.4 | n/a | unknown | 97% | 100% | 88% | 77% | 100% | 1282/1/0/0 | 0 | n/a | n/a | n/a | n/a | n/a | 15.8 | 1203104 | 10083 | 1028685 | 112 |
| with--z-ai_glm-5.3-flash | 48 | 48/48 | 0 | 90% | 77.7 | n/a | unknown | 90% | 96% | 83% | 69% | 99% | 877/0/0/2 | 1 | n/a | n/a | n/a | n/a | n/a | 4.4 | 193497 | 9544 | 114871 | 379 |
| without--claude-opus-5 | 48 | 48/48 | 0 | 100% | 80.1 | n/a | unknown | 96% | 0% | 0% | 0% | 0% | 0/0/0/0 | 0 | n/a | n/a | n/a | n/a | n/a | 4.0 | 143995 | 7468 | 58338 | 101 |
| without--claude-sonnet-5 | 48 | 48/48 | 0 | 98% | 61.6 | n/a | unknown | 94% | 0% | 0% | 0% | 0% | 0/0/0/0 | 0 | n/a | n/a | n/a | n/a | n/a | 18.8 | 1138889 | 5005 | 1031536 | 86 |
| without--z-ai_glm-5.3-flash | 48 | 48/48 | 0 | 96% | 66.4 | n/a | unknown | 91% | 0% | 0% | 0% | 0% | 0/0/0/0 | 0 | n/a | n/a | n/a | n/a | n/a | 2.2 | 62823 | 4837 | 23645 | 143 |

### Rubric criteria, mean of 0 to 10

| Arm | method_fits_design | qc_present | low_count_filter | normalization | model_formula_contrasts | fdr_shrinkage | enrichment_universe_sets | report_completeness |
|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | 9.1 | 8.9 | 8.5 | 9.0 | 8.7 | 8.6 | 9.3 | 9.1 |
| with--claude-sonnet-5 | 8.6 | 8.1 | 8.3 | 8.7 | 8.5 | 8.6 | 8.0 | 8.7 |
| with--z-ai_glm-5.3-flash | 7.7 | 7.3 | 7.5 | 8.1 | 7.7 | 7.7 | 8.2 | 7.9 |
| without--claude-opus-5 | 8.7 | 8.2 | 7.8 | 8.0 | 8.7 | 7.8 | 7.3 | 7.6 |
| without--claude-sonnet-5 | 7.6 | 5.7 | 4.6 | 7.1 | 6.3 | 6.2 | 5.7 | 6.0 |
| without--z-ai_glm-5.3-flash | 7.5 | 6.5 | 5.5 | 6.9 | 6.9 | 6.4 | 6.7 | 6.8 |

### Contrasts, paired by cluster (first arm minus second arm)

| Family | Contrast | Arms | Pairs | Missing | Diff | Lower (one-sided 97.5%) | Upper | p one-sided | Holm p | Rejected | Decision |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primary (primary) | glm_with vs sonnet_without | with--z-ai_glm-5.3-flash vs without--claude-sonnet-5 | 17 | 0 | 16.0 | 0.2 | 29.2 | 0.0065 | 0.0780 | no | uncalibrated |
| primary | glm_with vs opus_without | with--z-ai_glm-5.3-flash vs without--claude-opus-5 | 17 | 0 | -2.9 | -19.6 | 10.6 | 0.3580 | 1.0000 | no | uncalibrated |
| primary | qwen_with vs sonnet_without | with--qwen_qwen3.8-27b vs without--claude-sonnet-5 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | qwen_with vs opus_without | with--qwen_qwen3.8-27b vs without--claude-opus-5 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | glm_with vs glm_without | with--z-ai_glm-5.3-flash vs without--z-ai_glm-5.3-flash | 17 | 0 | 10.1 | -7.1 | 24.7 | 0.0393 | 0.4318 | no | uncalibrated |
| primary | glm_with vs qwen_without | with--z-ai_glm-5.3-flash vs without--qwen_qwen3.8-27b | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | qwen_with vs glm_without | with--qwen_qwen3.8-27b vs without--z-ai_glm-5.3-flash | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | qwen_with vs qwen_without | with--qwen_qwen3.8-27b vs without--qwen_qwen3.8-27b | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | sonnet_with vs sonnet_without | with--claude-sonnet-5 vs without--claude-sonnet-5 | 17 | 0 | 26.0 | 23.5 | 28.7 | 0.0000 | 0.0000 | yes | uncalibrated |
| primary | sonnet_with vs opus_without | with--claude-sonnet-5 vs without--claude-opus-5 | 17 | 0 | 7.1 | 4.2 | 10.1 | 0.0000 | 0.0000 | yes | uncalibrated |
| primary | opus_with vs sonnet_without | with--claude-opus-5 vs without--claude-sonnet-5 | 17 | 0 | 32.5 | 28.9 | 36.8 | 0.0000 | 0.0000 | yes | uncalibrated |
| primary | opus_with vs opus_without | with--claude-opus-5 vs without--claude-opus-5 | 17 | 0 | 13.5 | 9.8 | 17.8 | 0.0000 | 0.0000 | yes | uncalibrated |
| primary | glm_with vs sonnet_with | with--z-ai_glm-5.3-flash vs with--claude-sonnet-5 | 17 | 0 | -10.0 | -26.2 | 3.0 | 0.7125 | 1.0000 | no | uncalibrated |
| primary | glm_with vs opus_with | with--z-ai_glm-5.3-flash vs with--claude-opus-5 | 17 | 0 | -16.4 | -32.3 | -3.6 | 0.9470 | 1.0000 | no | uncalibrated |
| primary | qwen_with vs sonnet_with | with--qwen_qwen3.8-27b vs with--claude-sonnet-5 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |
| primary | qwen_with vs opus_with | with--qwen_qwen3.8-27b vs with--claude-opus-5 | 0 | 0 | n/a | n/a | n/a | n/a | n/a | no | uncalibrated |

## Per run

| Arm | Split | Seed | Task | Run | Outcome | Rubric | Expectations | Steps A/I/U/F/ungrounded | Pinned | Claims A/I/U/F | Recommend | Check | Valid completion | Out tok | Time s | Failed expectations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| with--claude-opus-5 | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 99 | 4/4 | 3/0/0/0/1 | 4/4 | 23/0/0/0 | 1 | 1 | n/a | 10125 | 108.9 |  |
| with--claude-opus-5 | development | 1 | classifier-n60 | 1 | plan_submitted | 90 | 7/7 | 4/0/0/0/1 | 5/5 | 10/0/0/0 | 1 | 1 | n/a | 9188 | 113.9 |  |
| with--claude-opus-5 | development | 1 | clustering-n60 | 1 | plan_submitted | 93 | 7/7 | 4/0/0/0/2 | 6/6 | 12/0/0/0 | 1 | 1 | n/a | 11577 | 139.9 |  |
| with--claude-opus-5 | development | 1 | coexpression-n60 | 1 | plan_submitted | 81 | 7/7 | 3/0/0/0/1 | 4/4 | 7/0/0/0 | 1 | 1 | n/a | 9375 | 111 |  |
| with--claude-opus-5 | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 74 | 6/6 | 3/0/0/0/0 | 3/3 | 7/0/0/0 | 1 | 2 | n/a | 10039 | 124 |  |
| with--claude-opus-5 | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 99 | 4/4 | 3/0/0/0/1 | 4/4 | 21/0/0/0 | 1 | 1 | n/a | 10310 | 115.3 |  |
| with--claude-opus-5 | development | 1 | covariates-n6 | 1 | plan_submitted | 98 | 6/7 | 3/0/0/0/1 | 4/4 | 20/0/0/0 | 1 | 1 | n/a | 10359 | 121.3 | must not match /regress(es|ed)? (out )?(the )?(sex|age|covariates?)[^.]* (from|out of) the counts/ |
| with--claude-opus-5 | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 95 | 7/7 | 4/0/0/0/1 | 5/5 | 24/0/0/0 | 1 | 1 | n/a | 10762 | 120.6 |  |
| with--claude-opus-5 | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 86 | 7/7 | 3/0/0/0/0 | 3/3 | 12/0/0/0 | 1 | 1 | n/a | 11194 | 129.7 |  |
| with--claude-opus-5 | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 91 | 8/8 | 2/0/0/0/0 | 2/2 | 15/0/0/0 | 1 | 1 | n/a | 12575 | 143.9 |  |
| with--claude-opus-5 | development | 1 | enrichment-only-ranked | 1 | plan_submitted | 84 | 7/7 | 2/0/0/0/1 | 3/3 | 21/0/0/0 | 1 | 1 | n/a | 8662 | 101.9 |  |
| with--claude-opus-5 | development | 1 | fastq-input | 1 | clarification_needed | 29 | 4/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 2525 | 43.7 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| with--claude-opus-5 | development | 1 | gene-list-ora | 1 | plan_submitted | 88 | 6/6 | 2/0/0/0/1 | 3/3 | 19/0/0/0 | 1 | 1 | n/a | 8470 | 100.4 |  |
| with--claude-opus-5 | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 99 | 4/4 | 2/0/0/0/1 | 3/3 | 22/0/0/0 | 1 | 2 | n/a | 10804 | 119.5 |  |
| with--claude-opus-5 | development | 1 | interaction-python-n4 | 1 | plan_submitted | 94 | 8/8 | 3/0/0/0/2 | 5/5 | 23/0/0/0 | 1 | 2 | n/a | 13647 | 152 |  |
| with--claude-opus-5 | development | 1 | log-normalized-n6 | 1 | plan_submitted | 98 | 7/7 | 2/0/0/0/1 | 3/3 | 11/0/0/0 | 1 | 2 | n/a | 7188 | 85.5 |  |
| with--claude-opus-5 | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 100 | 7/7 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 1 | n/a | 12510 | 139.8 |  |
| with--claude-opus-5 | development | 1 | multi-group-3x4 | 1 | plan_submitted | 96 | 6/6 | 4/0/0/0/0 | 4/4 | 41/0/0/0 | 1 | 1 | n/a | 12919 | 144.7 |  |
| with--claude-opus-5 | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 95 | 6/6 | 2/0/0/0/1 | 3/3 | 8/0/0/0 | 1 | 1 | n/a | 7237 | 87.2 |  |
| with--claude-opus-5 | development | 1 | outlier-n5 | 1 | plan_submitted | 100 | 7/7 | 3/0/0/0/1 | 4/4 | 22/0/0/0 | 1 | 1 | n/a | 12159 | 135.4 |  |
| with--claude-opus-5 | development | 1 | paired-3groups-n4 | 1 | plan_submitted | 98 | 6/6 | 3/0/0/0/1 | 4/4 | 42/0/0/0 | 1 | 2 | n/a | 14210 | 156.4 |  |
| with--claude-opus-5 | development | 1 | paired-n5 | 1 | plan_submitted | 99 | 3/3 | 3/0/0/0/0 | 3/3 | 21/0/0/0 | 1 | 1 | n/a | 9011 | 105.1 |  |
| with--claude-opus-5 | development | 1 | pathway-activity-n6 | 1 | plan_submitted | 70 | 7/7 | 3/0/0/0/1 | 4/4 | 11/0/0/0 | 1 | 1 | n/a | 9896 | 116.1 |  |
| with--claude-opus-5 | development | 1 | population-n60 | 1 | plan_submitted | 84 | 6/6 | 3/0/0/0/1 | 4/4 | 15/0/0/0 | 1 | 2 | n/a | 9644 | 114.9 |  |
| with--claude-opus-5 | development | 1 | python-enrichment-only | 1 | plan_submitted | 85 | 7/7 | 2/0/0/0/1 | 3/3 | 21/0/0/0 | 1 | 1 | n/a | 8630 | 101.7 |  |
| with--claude-opus-5 | development | 1 | python-two-group-n6 | 1 | plan_submitted | 99 | 8/8 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 2 | n/a | 12482 | 134.6 |  |
| with--claude-opus-5 | development | 1 | qc-only-n6 | 1 | plan_submitted | 79 | 8/8 | 2/0/0/0/0 | 2/2 | 2/0/0/0 | 1 | 1 | n/a | 5334 | 64.5 |  |
| with--claude-opus-5 | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 99 | 6/6 | 3/0/0/0/1 | 4/4 | 21/0/0/0 | 1 | 1 | n/a | 10632 | 117.7 |  |
| with--claude-opus-5 | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 95 | 5/5 | 3/0/0/0/2 | 4/5 | 18/0/0/0 | 1 | 1 | n/a | 10292 | 119.1 |  |
| with--claude-opus-5 | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 95 | 6/6 | 3/0/0/0/1 | 4/4 | 20/0/0/0 | 1 | 1 | n/a | 10490 | 125.1 |  |
| with--claude-opus-5 | development | 1 | sample-scores-gsva | 1 | plan_submitted | 91 | 6/6 | 4/0/0/0/1 | 5/5 | 11/0/0/0 | 1 | 1 | n/a | 10579 | 124.4 |  |
| with--claude-opus-5 | development | 1 | signature-scores-n6 | 1 | plan_submitted | 85 | 7/7 | 3/0/0/0/1 | 4/4 | 9/0/0/0 | 1 | 1 | n/a | 7880 | 87.8 |  |
| with--claude-opus-5 | development | 1 | star-counts-n3 | 1 | plan_submitted | 99 | 7/7 | 2/0/0/0/1 | 3/3 | 23/0/0/0 | 1 | 2 | n/a | 11277 | 119.6 |  |
| with--claude-opus-5 | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 89 | 6/6 | 4/0/0/0/1 | 5/5 | 41/0/0/0 | 1 | 1 | n/a | 15555 | 178.4 |  |
| with--claude-opus-5 | development | 1 | survival-n60 | 1 | plan_submitted | 88 | 7/7 | 4/0/0/0/1 | 5/5 | 10/0/0/0 | 1 | 1 | n/a | 9880 | 119 |  |
| with--claude-opus-5 | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 93 | 7/7 | 2/0/0/0/1 | 3/3 | 24/0/0/0 | 1 | 1 | n/a | 10934 | 127.8 |  |
| with--claude-opus-5 | development | 1 | tf-activity-n6 | 1 | plan_submitted | 70 | 7/7 | 3/1/0/0/1 | 5/5 | 10/1/0/0 | 1 | 1 | n/a | 9638 | 117.2 |  |
| with--claude-opus-5 | development | 1 | tf-activity-python-n6 | 1 | plan_submitted | 63 | 8/8 | 2/0/0/0/1 | 3/3 | 8/0/0/0 | 1 | 1 | n/a | 7109 | 86.1 |  |
| with--claude-opus-5 | development | 1 | three-prime-n3 | 1 | plan_submitted | 99 | 6/6 | 4/0/0/0/0 | 4/4 | 26/0/0/0 | 1 | 1 | n/a | 12317 | 138.9 |  |
| with--claude-opus-5 | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 98 | 3/3 | 4/0/0/0/0 | 4/4 | 28/0/0/0 | 1 | 2 | n/a | 11465 | 129.7 |  |
| with--claude-opus-5 | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 95 | 8/8 | 3/0/0/0/1 | 4/4 | 23/0/0/0 | 1 | 2 | n/a | 11518 | 129.5 |  |
| with--claude-opus-5 | development | 1 | tpm-input-n6 | 1 | plan_submitted | 96 | 7/7 | 2/0/0/0/1 | 3/3 | 11/0/0/0 | 1 | 2 | n/a | 7210 | 89.7 |  |
| with--claude-opus-5 | development | 1 | transcript-usage-n6 | 1 | clarification_needed | 29 | 6/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 1503 | 22.2 |  |
| with--claude-opus-5 | development | 1 | two-group-n3 | 1 | plan_submitted | 99 | 5/5 | 4/0/0/0/1 | 5/5 | 22/0/0/0 | 1 | 2 | n/a | 11917 | 139.7 |  |
| with--claude-opus-5 | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 100 | 6/6 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 1 | n/a | 13616 | 154.7 |  |
| with--claude-opus-5 | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 99 | 6/6 | 2/0/0/0/1 | 3/3 | 28/0/0/0 | 1 | 1 | n/a | 9859 | 107.4 |  |
| with--claude-opus-5 | development | 1 | variance-partition-n6 | 1 | plan_submitted | 95 | 7/7 | 3/0/0/0/1 | 4/4 | 21/0/0/0 | 1 | 0 | n/a | 8446 | 99 |  |
| with--claude-opus-5 | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 96 | 6/6 | 5/0/0/0/1 | 6/6 | 37/0/0/0 | 1 | 1 | n/a | 15191 | 174.5 |  |
| with--claude-sonnet-5 | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 93 | 4/4 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 4 | n/a | 10189 | 88.7 |  |
| with--claude-sonnet-5 | development | 1 | classifier-n60 | 1 | plan_submitted | 73 | 6/7 | 4/0/0/0/1 | 5/5 | 28/0/0/0 | 2 | 2 | n/a | 10164 | 112.4 | must match /(external|independent) (cohort|validation|data ?set)/ |
| with--claude-sonnet-5 | development | 1 | clustering-n60 | 1 | plan_submitted | 76 | 6/7 | 4/0/0/0/1 | 5/5 | 9/0/0/0 | 6 | 4 | n/a | 10673 | 146.2 | must match /(agreement|Rand index|contingency|cross-?tab|tabulat)[^.]{0,80}condition|condition[^.]{0,80}(agreement|Rand index|contingency|cross-?tab|tabulat)/ |
| with--claude-sonnet-5 | development | 1 | coexpression-n60 | 1 | plan_submitted | 84 | 6/7 | 2/0/0/0/2 | 4/4 | 5/0/0/0 | 1 | 3 | n/a | 7715 | 76.9 | must match /\bsigned[- ](network|adjacency|hybrid)/ |
| with--claude-sonnet-5 | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 91 | 5/6 | 3/0/0/0/1 | 4/4 | 6/0/0/0 | 1 | 5 | n/a | 13722 | 257.6 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/ |
| with--claude-sonnet-5 | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 88 | 4/4 | 3/0/0/0/1 | 4/4 | 31/0/0/0 | 1 | 2 | n/a | 8495 | 93.2 |  |
| with--claude-sonnet-5 | development | 1 | covariates-n6 | 1 | plan_submitted | 84 | 7/7 | 3/0/0/0/2 | 4/5 | 29/0/0/0 | 1 | 4 | n/a | 9959 | 99.5 |  |
| with--claude-sonnet-5 | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 86 | 7/7 | 4/0/0/0/1 | 5/5 | 33/0/0/0 | 1 | 2 | n/a | 9547 | 90.7 |  |
| with--claude-sonnet-5 | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 89 | 7/7 | 3/0/0/0/0 | 3/3 | 21/0/0/0 | 2 | 2 | n/a | 13306 | 182.2 |  |
| with--claude-sonnet-5 | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 79 | 8/8 | 3/0/0/0/0 | 3/3 | 11/0/0/0 | 1 | 3 | n/a | 10996 | 97.9 |  |
| with--claude-sonnet-5 | development | 1 | enrichment-only-ranked | 1 | plan_submitted | 78 | 6/7 | 2/0/0/0/1 | 3/3 | 16/0/0/0 | 1 | 4 | n/a | 7834 | 86.4 | must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/ |
| with--claude-sonnet-5 | development | 1 | fastq-input | 1 | clarification_needed | 26 | 5/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 3 | 0 | n/a | 5999 | 79.2 |  |
| with--claude-sonnet-5 | development | 1 | gene-list-ora | 1 | plan_submitted | 76 | 6/6 | 2/0/0/0/1 | 3/3 | 18/0/0/0 | 1 | 0 | n/a | 6319 | 75.1 |  |
| with--claude-sonnet-5 | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 98 | 4/4 | 3/0/0/0/1 | 4/4 | 36/0/0/0 | 1 | 2 | n/a | 9084 | 94.3 |  |
| with--claude-sonnet-5 | development | 1 | interaction-python-n4 | 1 | plan_submitted | 83 | 7/8 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 2 | n/a | 10653 | 138.4 | must match /python/ |
| with--claude-sonnet-5 | development | 1 | log-normalized-n6 | 1 | plan_submitted | 81 | 7/7 | 4/1/0/0/0 | 5/5 | 12/1/0/0 | 1 | 2 | n/a | 8537 | 82.3 |  |
| with--claude-sonnet-5 | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 99 | 7/7 | 3/0/0/0/1 | 4/4 | 27/0/0/0 | 1 | 1 | n/a | 7789 | 73.2 |  |
| with--claude-sonnet-5 | development | 1 | multi-group-3x4 | 1 | plan_submitted | 83 | 6/6 | 5/0/0/0/1 | 6/6 | 33/0/0/0 | 1 | 4 | n/a | 13212 | 133.7 |  |
| with--claude-sonnet-5 | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 76 | 6/6 | 3/0/0/0/1 | 4/4 | 21/0/0/0 | 1 | 2 | n/a | 8911 | 88.5 |  |
| with--claude-sonnet-5 | development | 1 | outlier-n5 | 1 | plan_submitted | 95 | 7/7 | 5/0/0/0/1 | 6/6 | 32/0/0/0 | 1 | 2 | n/a | 11261 | 110.8 |  |
| with--claude-sonnet-5 | development | 1 | paired-3groups-n4 | 1 | plan_submitted | 89 | 6/6 | 3/0/0/0/2 | 5/5 | 41/0/0/0 | 1 | 2 | n/a | 10792 | 141 |  |
| with--claude-sonnet-5 | development | 1 | paired-n5 | 1 | plan_submitted | 96 | 3/3 | 3/0/0/0/1 | 4/4 | 39/0/0/0 | 1 | 2 | n/a | 9471 | 99.8 |  |
| with--claude-sonnet-5 | development | 1 | pathway-activity-n6 | 1 | plan_submitted | 95 | 7/7 | 4/0/0/0/1 | 5/5 | 38/0/0/0 | 1 | 0 | n/a | 20237 | 251.3 |  |
| with--claude-sonnet-5 | development | 1 | population-n60 | 1 | plan_submitted | 86 | 6/6 | 4/0/0/0/1 | 5/5 | 29/0/0/0 | 1 | 4 | n/a | 12178 | 115.5 |  |
| with--claude-sonnet-5 | development | 1 | python-enrichment-only | 1 | plan_submitted | 81 | 7/7 | 2/0/0/0/1 | 3/3 | 13/0/0/0 | 1 | 2 | n/a | 6186 | 58.3 |  |
| with--claude-sonnet-5 | development | 1 | python-two-group-n6 | 1 | plan_submitted | 89 | 8/8 | 3/0/0/0/1 | 4/4 | 37/0/0/0 | 1 | 3 | n/a | 11114 | 105.1 |  |
| with--claude-sonnet-5 | development | 1 | qc-only-n6 | 1 | plan_submitted | 73 | 8/8 | 1/0/0/0/0 | 1/1 | 2/0/0/0 | 1 | 5 | n/a | 4682 | 47.1 |  |
| with--claude-sonnet-5 | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 88 | 5/6 | 4/0/0/0/1 | 5/5 | 29/0/0/0 | 1 | 4 | n/a | 10858 | 108.2 | must match /tximport/ |
| with--claude-sonnet-5 | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 88 | 5/5 | 3/0/0/0/1 | 4/4 | 35/0/0/0 | 1 | 3 | n/a | 10462 | 90 |  |
| with--claude-sonnet-5 | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 94 | 6/6 | 7/0/0/0/1 | 8/8 | 29/0/0/0 | 2 | 4 | n/a | 15390 | 155.9 |  |
| with--claude-sonnet-5 | development | 1 | sample-scores-gsva | 1 | plan_submitted | 93 | 6/6 | 3/0/0/0/1 | 4/4 | 20/0/0/0 | 1 | 4 | n/a | 8827 | 94.4 |  |
| with--claude-sonnet-5 | development | 1 | signature-scores-n6 | 1 | plan_submitted | 85 | 7/7 | 3/0/0/0/1 | 4/4 | 20/0/0/0 | 1 | 0 | n/a | 5612 | 54.8 |  |
| with--claude-sonnet-5 | development | 1 | star-counts-n3 | 1 | plan_submitted | 95 | 7/7 | 3/0/0/0/1 | 4/4 | 40/0/0/0 | 1 | 3 | n/a | 10335 | 93.4 |  |
| with--claude-sonnet-5 | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 86 | 6/6 | 3/0/0/0/1 | 4/4 | 36/0/0/0 | 2 | 4 | n/a | 12647 | 184.5 |  |
| with--claude-sonnet-5 | development | 1 | survival-n60 | 1 | plan_submitted | 86 | 7/7 | 5/1/0/0/1 | 7/7 | 9/0/0/0 | 2 | 0 | n/a | 10820 | 175.1 |  |
| with--claude-sonnet-5 | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 85 | 7/7 | 4/0/0/0/0 | 4/4 | 35/0/0/0 | 1 | 2 | n/a | 10821 | 119.8 |  |
| with--claude-sonnet-5 | development | 1 | tf-activity-n6 | 1 | plan_submitted | 85 | 7/7 | 4/0/0/0/1 | 5/5 | 37/0/0/0 | 1 | 3 | n/a | 11639 | 120.4 |  |
| with--claude-sonnet-5 | development | 1 | tf-activity-python-n6 | 1 | plan_submitted | 83 | 7/8 | 3/0/0/0/1 | 4/4 | 37/0/0/0 | 1 | 2 | n/a | 11290 | 110.1 | must match /python/ |
| with--claude-sonnet-5 | development | 1 | three-prime-n3 | 1 | plan_submitted | 93 | 6/6 | 3/0/0/0/1 | 4/4 | 35/0/0/0 | 1 | 2 | n/a | 9561 | 102.7 |  |
| with--claude-sonnet-5 | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 90 | 3/3 | 6/0/0/0/1 | 7/7 | 31/0/0/0 | 1 | 3 | n/a | 11247 | 104.1 |  |
| with--claude-sonnet-5 | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 86 | 6/8 | 3/0/0/0/1 | 4/4 | 31/0/0/0 | 1 | 4 | n/a | 10513 | 107.5 | must match /(intron|intergenic|genomic DNA|gene body)/; must not match /dedup(licate)? (the )?(reads|BAM|library)/ |
| with--claude-sonnet-5 | development | 1 | tpm-input-n6 | 1 | plan_submitted | 83 | 7/7 | 3/0/0/0/1 | 4/4 | 25/0/0/0 | 2 | 2 | n/a | 8271 | 92.7 |  |
| with--claude-sonnet-5 | development | 1 | transcript-usage-n6 | 1 | clarification_needed | 39 | 6/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 1978 | 26.9 |  |
| with--claude-sonnet-5 | development | 1 | two-group-n3 | 1 | plan_submitted | 95 | 5/5 | 4/0/0/0/1 | 5/5 | 38/0/0/0 | 1 | 2 | n/a | 11199 | 103.7 |  |
| with--claude-sonnet-5 | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 98 | 5/6 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 4 | n/a | 12534 | 115.3 | must not match /KEGG/ |
| with--claude-sonnet-5 | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 89 | 6/6 | 3/0/0/0/1 | 4/4 | 40/0/0/0 | 1 | 2 | n/a | 9256 | 86.3 |  |
| with--claude-sonnet-5 | development | 1 | variance-partition-n6 | 1 | plan_submitted | 85 | 7/7 | 4/0/0/0/1 | 5/5 | 37/0/0/0 | 1 | 2 | n/a | 10153 | 92.2 |  |
| with--claude-sonnet-5 | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 86 | 6/6 | 4/0/0/0/1 | 5/5 | 37/0/0/0 | 1 | 1 | n/a | 11561 | 200.5 |  |
| with--z-ai_glm-5.3-flash | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 95 | 4/4 | 3/0/0/0/1 | 4/4 | 22/0/0/0 | 1 | 2 | n/a | 14031 | 398 |  |
| with--z-ai_glm-5.3-flash | development | 1 | classifier-n60 | 1 | plan_submitted | 78 | 6/7 | 2/0/0/1/1 | 4/4 | 7/0/0/1 | 1 | 1 | n/a | 6914 | 206.9 | must match /(external|independent) (cohort|validation|data ?set)/ |
| with--z-ai_glm-5.3-flash | development | 1 | clustering-n60 | 1 | error | 0 | 2/7 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 1 | n/a | 3217 | 232.9 | must match /(consensus|ConsensusClusterPlus)/; must match /(resampl|subsampl|bootstrap)/; must match /(delta area|CDF|cumulative distribution)/; must match /(agreement|Rand index|contingency|cross-?tab|tabulat)[^.]{0,80}condition|condition[^.]{0,80}(agreement|Rand index|contingency|cross-?tab|tabulat)/; must match /(structure in noise|noise|spurious|confound)/ |
| with--z-ai_glm-5.3-flash | development | 1 | coexpression-n60 | 1 | plan_submitted | 75 | 7/7 | 3/0/0/0/1 | 4/4 | 8/0/0/0 | 1 | 1 | n/a | 5226 | 204.4 |  |
| with--z-ai_glm-5.3-flash | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 63 | 5/6 | 2/0/0/0/1 | 3/3 | 7/0/0/0 | 1 | 2 | n/a | 12947 | 491.9 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/ |
| with--z-ai_glm-5.3-flash | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 95 | 4/4 | 1/0/0/1/1 | 3/3 | 21/0/0/1 | 1 | 1 | n/a | 7369 | 417.3 |  |
| with--z-ai_glm-5.3-flash | development | 1 | covariates-n6 | 1 | plan_submitted | 91 | 7/7 | 3/0/0/0/1 | 4/4 | 20/0/0/0 | 1 | 2 | n/a | 11499 | 288.2 |  |
| with--z-ai_glm-5.3-flash | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 89 | 7/7 | 4/0/0/0/1 | 5/5 | 40/0/0/0 | 1 | 0 | n/a | 12671 | 318.8 |  |
| with--z-ai_glm-5.3-flash | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 85 | 7/7 | 2/0/0/0/2 | 4/4 | 9/0/0/0 | 1 | 2 | n/a | 12283 | 604.8 |  |
| with--z-ai_glm-5.3-flash | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 78 | 8/8 | 3/0/0/0/2 | 5/5 | 12/0/0/0 | 1 | 2 | n/a | 9178 | 358 |  |
| with--z-ai_glm-5.3-flash | development | 1 | enrichment-only-ranked | 1 | error | 0 | 2/7 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 1 | n/a | 1798 | 287.7 | must match /hallmark/; must match /(fgsea|gseapy|preranked|prerank|GSEA)/; must match /rank/; must match /(stat|Wald statistic|signed|-log10|log2 ?fold)/; must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/ |
| with--z-ai_glm-5.3-flash | development | 1 | fastq-input | 1 | clarification_needed | 54 | 5/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 1806 | 33.7 |  |
| with--z-ai_glm-5.3-flash | development | 1 | gene-list-ora | 1 | plan_submitted | 78 | 6/6 | 2/0/0/0/1 | 3/3 | 25/0/0/0 | 1 | 1 | n/a | 9968 | 687.4 |  |
| with--z-ai_glm-5.3-flash | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 93 | 4/4 | 3/0/0/0/1 | 4/4 | 42/0/0/0 | 1 | 2 | n/a | 19652 | 578.3 |  |
| with--z-ai_glm-5.3-flash | development | 1 | interaction-python-n4 | 1 | plan_submitted | 94 | 8/8 | 2/0/0/0/1 | 3/3 | 24/0/0/0 | 1 | 3 | n/a | 12092 | 540.5 |  |
| with--z-ai_glm-5.3-flash | development | 1 | log-normalized-n6 | 1 | plan_submitted | 94 | 7/7 | 2/0/0/0/1 | 3/3 | 11/0/0/0 | 1 | 2 | n/a | 6680 | 218.7 |  |
| with--z-ai_glm-5.3-flash | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 99 | 6/7 | 3/0/0/0/1 | 4/4 | 38/0/0/0 | 1 | 1 | n/a | 11224 | 369.1 | must match /(ortholog|homolog|msigdbr|species)/ |
| with--z-ai_glm-5.3-flash | development | 1 | multi-group-3x4 | 1 | plan_submitted | 95 | 6/6 | 3/0/0/0/1 | 4/4 | 23/0/0/0 | 1 | 1 | n/a | 8716 | 130 |  |
| with--z-ai_glm-5.3-flash | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 94 | 6/6 | 2/0/0/0/1 | 3/3 | 7/0/0/0 | 1 | 1 | n/a | 3721 | 85.2 |  |
| with--z-ai_glm-5.3-flash | development | 1 | outlier-n5 | 1 | plan_submitted | 96 | 7/7 | 3/0/0/0/1 | 4/4 | 22/0/0/0 | 1 | 2 | n/a | 11159 | 184.7 |  |
| with--z-ai_glm-5.3-flash | development | 1 | paired-3groups-n4 | 1 | error | 0 | 2/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 700 | 925.9 | must match /subject/; must match /(likelihood ratio|LRT|joint|F-test|ANOVA|any condition)/; must match /(pairwise|contrast)/; must match /DESeq2|edgeR|limma/ |
| with--z-ai_glm-5.3-flash | development | 1 | paired-n5 | 1 | error | 0 | 1/3 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 1 | 0 | n/a | 222 | 906.7 | must match /(subject|block|pair)/; must match /DESeq2|edgeR|limma/ |
| with--z-ai_glm-5.3-flash | development | 1 | pathway-activity-n6 | 1 | error | 0 | 2/7 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 2 | 0 | n/a | 10342 | 1463.2 | must match /PROGENy/; must match /decoupl/; must match /footprint/; must match /(mlm|multivariate linear|ulm|univariate linear|wmean)/; must match /(downstream|responsive genes|target genes|not (the )?(membership|members))/ |
| with--z-ai_glm-5.3-flash | development | 1 | population-n60 | 1 | plan_submitted | 84 | 5/6 | 2/0/0/0/2 | 4/4 | 16/0/0/0 | 1 | 3 | n/a | 9026 | 181.5 | must match /(camera|fgsea|preranked|moderated t)/ |
| with--z-ai_glm-5.3-flash | development | 1 | python-enrichment-only | 1 | plan_submitted | 86 | 7/7 | 3/0/0/0/1 | 4/4 | 18/0/0/0 | 1 | 2 | n/a | 12169 | 573.1 |  |
| with--z-ai_glm-5.3-flash | development | 1 | python-two-group-n6 | 1 | plan_submitted | 99 | 8/8 | 4/0/0/0/1 | 5/5 | 37/0/0/0 | 1 | 0 | n/a | 15640 | 608.4 |  |
| with--z-ai_glm-5.3-flash | development | 1 | qc-only-n6 | 1 | plan_submitted | 80 | 8/8 | 1/0/0/0/0 | 1/1 | 2/0/0/0 | 1 | 1 | n/a | 2843 | 146.9 |  |
| with--z-ai_glm-5.3-flash | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 91 | 6/6 | 3/0/0/0/2 | 5/5 | 22/0/0/0 | 1 | 1 | n/a | 9878 | 242.3 |  |
| with--z-ai_glm-5.3-flash | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 91 | 4/5 | 3/0/0/0/1 | 4/4 | 19/0/0/0 | 1 | 2 | n/a | 15412 | 780.7 | must not match /(run|use|apply|call)s? tximport on (the )?(gene[- ]level |count |gene )?(table|matrix)/ |
| with--z-ai_glm-5.3-flash | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 94 | 6/6 | 4/0/0/0/1 | 5/5 | 19/0/0/0 | 1 | 2 | n/a | 9135 | 348.4 |  |
| with--z-ai_glm-5.3-flash | development | 1 | sample-scores-gsva | 1 | plan_submitted | 89 | 6/6 | 4/0/0/0/2 | 6/6 | 40/0/0/0 | 2 | 1 | n/a | 16102 | 355 |  |
| with--z-ai_glm-5.3-flash | development | 1 | signature-scores-n6 | 1 | plan_submitted | 88 | 7/7 | 4/0/0/0/1 | 5/5 | 9/0/0/0 | 1 | 1 | n/a | 6024 | 251.9 |  |
| with--z-ai_glm-5.3-flash | development | 1 | star-counts-n3 | 1 | plan_submitted | 98 | 7/7 | 3/0/0/0/1 | 4/4 | 22/0/0/0 | 1 | 1 | n/a | 8684 | 345.7 |  |
| with--z-ai_glm-5.3-flash | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 89 | 6/6 | 3/0/0/0/1 | 4/4 | 24/0/0/0 | 1 | 1 | n/a | 10486 | 245.6 |  |
| with--z-ai_glm-5.3-flash | development | 1 | survival-n60 | 1 | plan_submitted | 64 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 3273 | 195.6 |  |
| with--z-ai_glm-5.3-flash | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 89 | 7/7 | 2/0/0/0/1 | 3/3 | 27/0/0/0 | 1 | 2 | n/a | 10675 | 212 |  |
| with--z-ai_glm-5.3-flash | development | 1 | tf-activity-n6 | 1 | plan_submitted | 86 | 7/7 | 3/0/0/0/1 | 4/4 | 27/0/0/0 | 2 | 2 | n/a | 11434 | 205.6 |  |
| with--z-ai_glm-5.3-flash | development | 1 | tf-activity-python-n6 | 1 | plan_submitted | 89 | 8/8 | 3/0/0/0/1 | 4/4 | 25/0/0/0 | 2 | 2 | n/a | 14071 | 211.8 |  |
| with--z-ai_glm-5.3-flash | development | 1 | three-prime-n3 | 1 | plan_submitted | 94 | 6/6 | 3/0/0/0/1 | 4/4 | 26/0/0/0 | 1 | 2 | n/a | 8603 | 245 |  |
| with--z-ai_glm-5.3-flash | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 89 | 3/3 | 3/0/0/0/2 | 5/5 | 28/0/0/0 | 1 | 2 | n/a | 17793 | 577.4 |  |
| with--z-ai_glm-5.3-flash | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 93 | 8/8 | 3/0/0/0/1 | 4/4 | 23/0/0/0 | 1 | 1 | n/a | 9873 | 481.5 |  |
| with--z-ai_glm-5.3-flash | development | 1 | tpm-input-n6 | 1 | plan_submitted | 91 | 7/7 | 2/0/0/0/1 | 3/3 | 11/0/0/0 | 1 | 2 | n/a | 14660 | 609.6 |  |
| with--z-ai_glm-5.3-flash | development | 1 | transcript-usage-n6 | 1 | clarification_needed | 30 | 5/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 1348 | 26.5 | must match /(DEXSeq|DRIMSeq)/ |
| with--z-ai_glm-5.3-flash | development | 1 | two-group-n3 | 1 | plan_submitted | 98 | 5/5 | 3/0/0/0/2 | 5/5 | 22/0/0/0 | 1 | 1 | n/a | 17162 | 399.9 |  |
| with--z-ai_glm-5.3-flash | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 99 | 6/6 | 3/0/0/0/2 | 5/5 | 38/0/0/0 | 1 | 1 | n/a | 10862 | 283.3 |  |
| with--z-ai_glm-5.3-flash | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 99 | 6/6 | 2/0/0/0/1 | 3/3 | 25/0/0/0 | 1 | 2 | n/a | 8848 | 218.7 |  |
| with--z-ai_glm-5.3-flash | development | 1 | variance-partition-n6 | 1 | plan_submitted | 89 | 7/7 | 3/0/0/0/1 | 4/4 | 21/0/0/0 | 1 | 2 | n/a | 9254 | 197.1 |  |
| with--z-ai_glm-5.3-flash | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 94 | 5/6 | 4/0/0/0/1 | 5/5 | 38/0/0/0 | 1 | 2 | n/a | 11460 | 322.9 | must not match /KEGG/ |
| without--claude-opus-5 | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 94 | 4/4 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 5839 | 79.8 |  |
| without--claude-opus-5 | development | 1 | classifier-n60 | 1 | plan_submitted | 78 | 7/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 7265 | 109.4 |  |
| without--claude-opus-5 | development | 1 | clustering-n60 | 1 | plan_submitted | 80 | 7/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 8647 | 126 |  |
| without--claude-opus-5 | development | 1 | coexpression-n60 | 1 | plan_submitted | 80 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 7524 | 108 |  |
| without--claude-opus-5 | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 71 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 8385 | 112.7 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/ |
| without--claude-opus-5 | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 75 | 4/4 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6215 | 89.4 |  |
| without--claude-opus-5 | development | 1 | covariates-n6 | 1 | plan_submitted | 88 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6745 | 93.6 |  |
| without--claude-opus-5 | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 79 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 5227 | 73.9 |  |
| without--claude-opus-5 | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 85 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 10121 | 134.4 |  |
| without--claude-opus-5 | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 78 | 8/8 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 10074 | 140.4 |  |
| without--claude-opus-5 | development | 1 | enrichment-only-ranked | 1 | plan_submitted | 71 | 4/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 6088 | 80.5 | must match /(no cutoff|full (ranked )?list|every tested gene|all (tested )?genes|without a cutoff)/; must not match /re-?run (the )?(DESeq2|differential expression)/; must not match /filter(s|ed)? (the )?(genes|results|table|list) (to|by|at|on) (padj|adjusted p|FDR)/ |
| without--claude-opus-5 | development | 1 | fastq-input | 1 | clarification_needed | 29 | 4/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 2487 | 39.3 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| without--claude-opus-5 | development | 1 | gene-list-ora | 1 | plan_submitted | 76 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 5772 | 78.3 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-opus-5 | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 89 | 4/4 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6102 | 82.1 |  |
| without--claude-opus-5 | development | 1 | interaction-python-n4 | 1 | plan_submitted | 85 | 8/8 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 7969 | 112 |  |
| without--claude-opus-5 | development | 1 | log-normalized-n6 | 1 | plan_submitted | 83 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 13764 | 157.9 |  |
| without--claude-opus-5 | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 90 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6517 | 87.9 |  |
| without--claude-opus-5 | development | 1 | multi-group-3x4 | 1 | plan_submitted | 84 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 6171 | 92.5 |  |
| without--claude-opus-5 | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 58 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4967 | 75.5 | must not match /FDR < 0\.05/ |
| without--claude-opus-5 | development | 1 | outlier-n5 | 1 | plan_submitted | 86 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6815 | 95.5 |  |
| without--claude-opus-5 | development | 1 | paired-3groups-n4 | 1 | plan_submitted | 86 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7532 | 104.9 |  |
| without--claude-opus-5 | development | 1 | paired-n5 | 1 | plan_submitted | 89 | 3/3 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 6603 | 91.7 |  |
| without--claude-opus-5 | development | 1 | pathway-activity-n6 | 1 | plan_submitted | 83 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 10937 | 146.8 |  |
| without--claude-opus-5 | development | 1 | population-n60 | 1 | plan_submitted | 79 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6846 | 96.8 |  |
| without--claude-opus-5 | development | 1 | python-enrichment-only | 1 | plan_submitted | 79 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 8433 | 97.9 |  |
| without--claude-opus-5 | development | 1 | python-two-group-n6 | 1 | plan_submitted | 93 | 8/8 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 8587 | 115.2 |  |
| without--claude-opus-5 | development | 1 | qc-only-n6 | 1 | plan_submitted | 86 | 8/8 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 9916 | 116.4 |  |
| without--claude-opus-5 | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 88 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6229 | 89.1 |  |
| without--claude-opus-5 | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 76 | 5/5 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 7444 | 103.3 |  |
| without--claude-opus-5 | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 84 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 5260 | 72 |  |
| without--claude-opus-5 | development | 1 | sample-scores-gsva | 1 | plan_submitted | 94 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 5500 | 75.9 |  |
| without--claude-opus-5 | development | 1 | signature-scores-n6 | 1 | plan_submitted | 88 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6517 | 88.3 |  |
| without--claude-opus-5 | development | 1 | star-counts-n3 | 1 | plan_submitted | 93 | 6/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6328 | 84.6 | must not match /(run|use|apply|call) tximport/ |
| without--claude-opus-5 | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 83 | 6/6 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 8448 | 117.3 |  |
| without--claude-opus-5 | development | 1 | survival-n60 | 1 | plan_submitted | 65 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6098 | 83.3 |  |
| without--claude-opus-5 | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 83 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7448 | 108.1 |  |
| without--claude-opus-5 | development | 1 | tf-activity-n6 | 1 | plan_submitted | 79 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 6706 | 98.8 |  |
| without--claude-opus-5 | development | 1 | tf-activity-python-n6 | 1 | plan_submitted | 73 | 8/8 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 5237 | 73.8 |  |
| without--claude-opus-5 | development | 1 | three-prime-n3 | 1 | plan_submitted | 85 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 13863 | 162.3 |  |
| without--claude-opus-5 | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 78 | 3/3 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 6236 | 88.4 |  |
| without--claude-opus-5 | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 90 | 7/8 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 16013 | 190.3 | must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-opus-5 | development | 1 | tpm-input-n6 | 1 | plan_submitted | 78 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6486 | 99.3 |  |
| without--claude-opus-5 | development | 1 | transcript-usage-n6 | 1 | clarification_needed | 46 | 5/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 1329 | 22.4 | must match /(DEXSeq|DRIMSeq)/ |
| without--claude-opus-5 | development | 1 | two-group-n3 | 1 | plan_submitted | 81 | 5/5 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 13137 | 156.1 |  |
| without--claude-opus-5 | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 91 | 6/6 | 0/0/0/0/6 | 0/6 | 0/0/0/0 | 0 | 0 | n/a | 8110 | 108.1 |  |
| without--claude-opus-5 | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 85 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6184 | 84.3 |  |
| without--claude-opus-5 | development | 1 | variance-partition-n6 | 1 | plan_submitted | 74 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6427 | 87.6 |  |
| without--claude-opus-5 | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 84 | 5/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7924 | 108.2 | must not match /KEGG/ |
| without--claude-sonnet-5 | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 66 | 4/4 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2955 | 38.6 |  |
| without--claude-sonnet-5 | development | 1 | classifier-n60 | 1 | plan_submitted | 59 | 7/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 6157 | 90.4 |  |
| without--claude-sonnet-5 | development | 1 | clustering-n60 | 1 | plan_submitted | 58 | 6/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 3597 | 40.7 | must match /(agreement|Rand index|contingency|cross-?tab|tabulat)[^.]{0,80}condition|condition[^.]{0,80}(agreement|Rand index|contingency|cross-?tab|tabulat)/ |
| without--claude-sonnet-5 | development | 1 | coexpression-n60 | 1 | plan_submitted | 65 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2633 | 31 |  |
| without--claude-sonnet-5 | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 49 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 7523 | 239 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/ |
| without--claude-sonnet-5 | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 63 | 4/4 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2652 | 29.7 |  |
| without--claude-sonnet-5 | development | 1 | covariates-n6 | 1 | plan_submitted | 53 | 6/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 2727 | 32 | must match /(center|centre|scale)/ |
| without--claude-sonnet-5 | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 59 | 7/7 | 0/0/0/0/1 | 0/1 | 0/0/0/0 | 0 | 0 | n/a | 2898 | 34.4 |  |
| without--claude-sonnet-5 | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 66 | 7/7 | 0/0/0/0/1 | 0/1 | 0/0/0/0 | 0 | 0 | n/a | 7471 | 131.1 |  |
| without--claude-sonnet-5 | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 65 | 8/8 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 9228 | 153.9 |  |
| without--claude-sonnet-5 | development | 1 | enrichment-only-ranked | 1 | plan_submitted | 66 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 1946 | 26.6 |  |
| without--claude-sonnet-5 | development | 1 | fastq-input | 1 | clarification_needed | 26 | 5/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 8964 | 140.7 |  |
| without--claude-sonnet-5 | development | 1 | gene-list-ora | 1 | plan_submitted | 69 | 5/6 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 2473 | 27.6 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--claude-sonnet-5 | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 74 | 4/4 | 0/0/0/0/6 | 0/6 | 0/0/0/0 | 0 | 0 | n/a | 8914 | 184.9 |  |
| without--claude-sonnet-5 | development | 1 | interaction-python-n4 | 1 | plan_submitted | 65 | 8/8 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 8010 | 156 |  |
| without--claude-sonnet-5 | development | 1 | log-normalized-n6 | 1 | plan_submitted | 63 | 6/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2708 | 36.5 | must match /trend/ |
| without--claude-sonnet-5 | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 49 | 6/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 2435 | 24.4 | must match /(ortholog|homolog|msigdbr|species)/ |
| without--claude-sonnet-5 | development | 1 | multi-group-3x4 | 1 | plan_submitted | 66 | 6/6 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 2670 | 27.8 |  |
| without--claude-sonnet-5 | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 39 | 6/6 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 7432 | 210.1 |  |
| without--claude-sonnet-5 | development | 1 | outlier-n5 | 1 | plan_submitted | 63 | 7/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 3506 | 37.6 |  |
| without--claude-sonnet-5 | development | 1 | paired-3groups-n4 | 1 | plan_submitted | 56 | 5/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 2577 | 25.8 | must match /(likelihood ratio|LRT|joint|F-test|ANOVA|any condition)/ |
| without--claude-sonnet-5 | development | 1 | paired-n5 | 1 | plan_submitted | 70 | 3/3 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2931 | 36.4 |  |
| without--claude-sonnet-5 | development | 1 | pathway-activity-n6 | 1 | plan_submitted | 66 | 7/7 | 0/0/0/0/6 | 0/6 | 0/0/0/0 | 0 | 0 | n/a | 7859 | 137.4 |  |
| without--claude-sonnet-5 | development | 1 | population-n60 | 1 | plan_submitted | 64 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 6799 | 139.6 | must match /limma|voom/ |
| without--claude-sonnet-5 | development | 1 | python-enrichment-only | 1 | plan_submitted | 60 | 7/7 | 0/0/0/0/1 | 0/1 | 0/0/0/0 | 0 | 0 | n/a | 2168 | 32.4 |  |
| without--claude-sonnet-5 | development | 1 | python-two-group-n6 | 1 | plan_submitted | 64 | 8/8 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 4284 | 45.7 |  |
| without--claude-sonnet-5 | development | 1 | qc-only-n6 | 1 | plan_submitted | 76 | 8/8 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 2566 | 27.5 |  |
| without--claude-sonnet-5 | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 75 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6469 | 173.6 |  |
| without--claude-sonnet-5 | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 63 | 5/5 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 8477 | 155 |  |
| without--claude-sonnet-5 | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 64 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7377 | 161.8 |  |
| without--claude-sonnet-5 | development | 1 | sample-scores-gsva | 1 | plan_submitted | 74 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 2874 | 34.8 |  |
| without--claude-sonnet-5 | development | 1 | signature-scores-n6 | 1 | plan_submitted | 65 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2875 | 34.6 |  |
| without--claude-sonnet-5 | development | 1 | star-counts-n3 | 1 | plan_submitted | 69 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2288 | 26.7 |  |
| without--claude-sonnet-5 | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 69 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 15343 | 286.6 |  |
| without--claude-sonnet-5 | development | 1 | survival-n60 | 1 | plan_submitted | 60 | 6/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7080 | 186.3 | must match /continuous/ |
| without--claude-sonnet-5 | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 56 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 5651 | 53.5 |  |
| without--claude-sonnet-5 | development | 1 | tf-activity-n6 | 1 | plan_submitted | 43 | 6/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 5747 | 56.3 | must match /(regulon size|min_n|minsize|minimum (number of )?targets|at least (five|5) targets)/ |
| without--claude-sonnet-5 | development | 1 | tf-activity-python-n6 | 1 | plan_submitted | 61 | 8/8 | 0/0/0/0/1 | 0/1 | 0/0/0/0 | 0 | 0 | n/a | 6800 | 159.9 |  |
| without--claude-sonnet-5 | development | 1 | three-prime-n3 | 1 | plan_submitted | 64 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2844 | 34.4 |  |
| without--claude-sonnet-5 | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 65 | 3/3 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6850 | 115.9 |  |
| without--claude-sonnet-5 | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 63 | 6/8 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6818 | 98.9 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--claude-sonnet-5 | development | 1 | tpm-input-n6 | 1 | plan_submitted | 66 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 6974 | 147.8 |  |
| without--claude-sonnet-5 | development | 1 | transcript-usage-n6 | 1 | error | 41 | 2/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 697 | 11.3 | must match /(transcript|isoform)/; must match /(quant\.sf|transcript-level|transcript level|per-transcript)/; must match /(DEXSeq|DRIMSeq)/; must match /(ask|clarif|question|request|provide|not (present|available|in hand|delivered)|cannot (answer|be performed|be done)|missing)/ |
| without--claude-sonnet-5 | development | 1 | two-group-n3 | 1 | plan_submitted | 66 | 5/5 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2657 | 31.1 |  |
| without--claude-sonnet-5 | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 65 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2165 | 24.6 |  |
| without--claude-sonnet-5 | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 64 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2528 | 38.1 |  |
| without--claude-sonnet-5 | development | 1 | variance-partition-n6 | 1 | plan_submitted | 63 | 6/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 3966 | 42 | must match /(random effect|random term|\(1 ?\| ?)/ |
| without--claude-sonnet-5 | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 65 | 5/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7658 | 135 | must not match /KEGG/ |
| without--z-ai_glm-5.3-flash | development | 1 | batch-balanced-n6 | 1 | plan_submitted | 76 | 4/4 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 7202 | 92.7 |  |
| without--z-ai_glm-5.3-flash | development | 1 | classifier-n60 | 1 | error | 0 | 2/7 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 4377 | 339.3 | must match /(penali[sz]ed|glmnet|lasso|elastic net|ridge|regulari[sz]ed)/; must match /nested|inner[^.]{0,40}outer|outer[^.]{0,40}inner/; must match /(ROC|AUC|area under)/; must match /(confidence interval|\bCI\b|bootstrap)/; must match /(external|independent) (cohort|validation|data ?set)/ |
| without--z-ai_glm-5.3-flash | development | 1 | clustering-n60 | 1 | plan_submitted | 68 | 6/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 4578 | 141.3 | must match /(structure in noise|noise|spurious|confound)/ |
| without--z-ai_glm-5.3-flash | development | 1 | coexpression-n60 | 1 | plan_submitted | 78 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 4432 | 104.7 |  |
| without--z-ai_glm-5.3-flash | development | 1 | coexpression-too-few-n3 | 1 | plan_submitted | 51 | 4/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4756 | 123.1 | must match /(too few|not enough|insufficient|cannot support|(at least|minimum of) (15|20|fifteen|twenty))/; must match /(STRING|prior network|curated|stop)/ |
| without--z-ai_glm-5.3-flash | development | 1 | confounded-batch-n6 | 1 | plan_submitted | 75 | 4/4 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3268 | 61.5 |  |
| without--z-ai_glm-5.3-flash | development | 1 | covariates-n6 | 1 | plan_submitted | 64 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4165 | 99.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | de-plus-tf-activity-n6 | 1 | plan_submitted | 70 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 5849 | 103.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | deconvolution-mouse-n6 | 1 | plan_submitted | 74 | 7/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 6818 | 69.6 |  |
| without--z-ai_glm-5.3-flash | development | 1 | deconvolution-tpm-n6 | 1 | plan_submitted | 78 | 8/8 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 6114 | 92.2 |  |
| without--z-ai_glm-5.3-flash | development | 1 | enrichment-only-ranked | 1 | plan_submitted | 79 | 6/7 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 4978 | 104.5 | must not match /re-?run (the )?(DESeq2|differential expression)/ |
| without--z-ai_glm-5.3-flash | development | 1 | fastq-input | 1 | clarification_needed | 34 | 4/5 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 2444 | 60.6 | must match /(ask|clarif|question|confirm|missing|not (yet )?quantified)/ |
| without--z-ai_glm-5.3-flash | development | 1 | gene-list-ora | 1 | plan_submitted | 74 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 5857 | 78.6 | must not match /(rerun|re-run|refit|re-fit|repeat) (the )?DESeq2/ |
| without--z-ai_glm-5.3-flash | development | 1 | interaction-2x2-n4 | 1 | plan_submitted | 74 | 4/4 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 4595 | 50.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | interaction-python-n4 | 1 | plan_submitted | 74 | 8/8 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 4690 | 155.6 |  |
| without--z-ai_glm-5.3-flash | development | 1 | log-normalized-n6 | 1 | plan_submitted | 71 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 2119 | 102.6 |  |
| without--z-ai_glm-5.3-flash | development | 1 | mouse-two-group-n6 | 1 | plan_submitted | 76 | 6/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3790 | 84.5 | must match /(ortholog|homolog|msigdbr|species)/ |
| without--z-ai_glm-5.3-flash | development | 1 | multi-group-3x4 | 1 | plan_submitted | 80 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 4834 | 233 |  |
| without--z-ai_glm-5.3-flash | development | 1 | no-replicates-1v1 | 1 | plan_submitted | 69 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3172 | 71.3 |  |
| without--z-ai_glm-5.3-flash | development | 1 | outlier-n5 | 1 | plan_submitted | 58 | 6/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4710 | 176 | must match /(criterion|threshold|rule|justif|reason)/ |
| without--z-ai_glm-5.3-flash | development | 1 | paired-3groups-n4 | 1 | plan_submitted | 76 | 5/6 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 9516 | 332.9 | must match /(likelihood ratio|LRT|joint|F-test|ANOVA|any condition)/ |
| without--z-ai_glm-5.3-flash | development | 1 | paired-n5 | 1 | plan_submitted | 79 | 3/3 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 5412 | 110.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | pathway-activity-n6 | 1 | plan_submitted | 63 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7075 | 193.7 |  |
| without--z-ai_glm-5.3-flash | development | 1 | population-n60 | 1 | plan_submitted | 66 | 5/6 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 3843 | 141.5 | must match /limma|voom/ |
| without--z-ai_glm-5.3-flash | development | 1 | python-enrichment-only | 1 | plan_submitted | 68 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4828 | 94.8 |  |
| without--z-ai_glm-5.3-flash | development | 1 | python-two-group-n6 | 1 | plan_submitted | 76 | 8/8 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 7455 | 187.7 |  |
| without--z-ai_glm-5.3-flash | development | 1 | qc-only-n6 | 1 | plan_submitted | 80 | 8/8 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 4023 | 78.5 |  |
| without--z-ai_glm-5.3-flash | development | 1 | rsem-counts-n6 | 1 | plan_submitted | 65 | 6/6 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 11753 | 376.6 |  |
| without--z-ai_glm-5.3-flash | development | 1 | salmon-counts-unknown-n6 | 1 | plan_submitted | 64 | 5/5 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 4202 | 102.3 |  |
| without--z-ai_glm-5.3-flash | development | 1 | salmon-quant-n6 | 1 | plan_submitted | 66 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2589 | 144.7 | must match /(avgTxLength|length offset|offset)/ |
| without--z-ai_glm-5.3-flash | development | 1 | sample-scores-gsva | 1 | plan_submitted | 73 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4905 | 76.8 |  |
| without--z-ai_glm-5.3-flash | development | 1 | signature-scores-n6 | 1 | plan_submitted | 84 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4859 | 59.7 |  |
| without--z-ai_glm-5.3-flash | development | 1 | star-counts-n3 | 1 | plan_submitted | 85 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3207 | 95.9 |  |
| without--z-ai_glm-5.3-flash | development | 1 | strandedness-unknown-n3 | 1 | plan_submitted | 56 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 4356 | 104.8 |  |
| without--z-ai_glm-5.3-flash | development | 1 | survival-n60 | 1 | plan_submitted | 68 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 7610 | 290.8 |  |
| without--z-ai_glm-5.3-flash | development | 1 | suspected-batch-n6 | 1 | plan_submitted | 68 | 7/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 7575 | 258.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | tf-activity-n6 | 1 | plan_submitted | 59 | 5/7 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 5840 | 341.3 | must match /(regulon size|min_n|minsize|minimum (number of )?targets|at least (five|5) targets)/; must match /(per[- ]sample|each sample|every sample|sample[- ]level)/ |
| without--z-ai_glm-5.3-flash | development | 1 | tf-activity-python-n6 | 1 | error | 0 | 3/8 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 1325 | 262.6 | must match /PyDESeq2/; must match /decoupler/; must match /CollecTRI/; must match /python/; must match /(csv|local (copy|file|network|table)|offline)/ |
| without--z-ai_glm-5.3-flash | development | 1 | three-prime-n3 | 1 | plan_submitted | 84 | 6/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3983 | 79.1 |  |
| without--z-ai_glm-5.3-flash | development | 1 | timecourse-2x4-n3 | 1 | plan_submitted | 59 | 3/3 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 2476 | 59.2 |  |
| without--z-ai_glm-5.3-flash | development | 1 | total-rna-highdup-n6 | 1 | plan_submitted | 69 | 6/8 | 0/0/0/0/5 | 0/5 | 0/0/0/0 | 0 | 0 | n/a | 3907 | 161.5 | must match /(mitochondrial|mt-|chrM)/; must match /(intron|intergenic|genomic DNA|gene body)/ |
| without--z-ai_glm-5.3-flash | development | 1 | tpm-input-n6 | 1 | plan_submitted | 71 | 7/7 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 3100 | 127 |  |
| without--z-ai_glm-5.3-flash | development | 1 | transcript-usage-n6 | 1 | clarification_needed | 39 | 4/6 | 0/0/0/0/0 | 0/0 | 0/0/0/0 | 0 | 0 | n/a | 1195 | 66.3 | must match /(DEXSeq|DRIMSeq)/; must match /(ask|clarif|question|request|provide|not (present|available|in hand|delivered)|cannot (answer|be performed|be done)|missing)/ |
| without--z-ai_glm-5.3-flash | development | 1 | two-group-n3 | 1 | plan_submitted | 80 | 5/5 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 5685 | 169.2 |  |
| without--z-ai_glm-5.3-flash | development | 1 | two-group-n6-enrich | 1 | plan_submitted | 70 | 6/6 | 0/0/0/0/2 | 0/2 | 0/0/0/0 | 0 | 0 | n/a | 1502 | 50.5 |  |
| without--z-ai_glm-5.3-flash | development | 1 | two-timepoints-n3 | 1 | plan_submitted | 63 | 6/6 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6049 | 156.3 |  |
| without--z-ai_glm-5.3-flash | development | 1 | variance-partition-n6 | 1 | plan_submitted | 69 | 5/7 | 0/0/0/0/4 | 0/4 | 0/0/0/0 | 0 | 0 | n/a | 6278 | 270.5 | must match /(random effect|random term|\(1 ?\| ?)/; must match /(vst|voom|log2 ?CPM)/ |
| without--z-ai_glm-5.3-flash | development | 1 | zebrafish-two-group-n3 | 1 | plan_submitted | 69 | 5/6 | 0/0/0/0/3 | 0/3 | 0/0/0/0 | 0 | 0 | n/a | 4886 | 108.6 | must not match /KEGG/ |
