# QC decision: shallow sample retain/exclude

**Decision: EXCLUDE (flag for sensitivity analysis)**

## Evidence

- Shallow sample: **sample_01** (condition: control)
- Library size: 420,347 reads vs cohort median 1,614,280 (3.84x below median; lowest-depth sample among all 12)
- Detected genes: 10,918 vs cohort median 11,600
- DESeq2 size factor: 0.288 vs cohort median 1.076
- PCA (top 500 variable genes, blind VST): PC1 z vs own group = -1.92, PC2 z vs own group = -23.77
- Mean blind-VST Euclidean distance to own condition group: 95.41 (baseline within-group distance among other same-condition replicates: 84.36)
- Mean blind-VST Euclidean distance to opposite condition group: 103.98
- Condition separation on PCA overall (both groups, top 500 genes): separates cleanly along PC1/PC2

## Rationale

sample_01 is 3.84x below the cohort median library size and has 10918 detected genes vs a cohort median of 11600. On top of the depth shortfall, it behaves as a structural outlier: its PCA position deviates from its own condition group by 23.77 standard deviations on the top-500-variable-gene PCA, so its low depth is accompanied by genuine structural divergence, not just proportional shrinkage the size factor can absorb. Recommend excluding it from the primary DE contrast and reporting results with and without it, rather than dropping it silently.

## Caveats

- No batch, lane, or run-date field exists in metadata.csv. Batch effects cannot be assessed or adjusted for; any residual dispersion in the PCA/distance structure that looks technical cannot be attributed to batch versus biology versus depth with the metadata available.
- No subject/donor identifier separate from 'sample' exists, so biological independence of replicates is assumed, not confirmed.
- This QC step does not run differential expression; the retain/exclude call is about sample structure QC input to a downstream DE step, not a final DE conclusion.

## Full library-size / detected-gene ranking

|   depth_rank | sample    | condition   |   library_size |   detected_genes |   fold_below_median | flag_shallow   |
|-------------:|:----------|:------------|---------------:|-----------------:|--------------------:|:---------------|
|            1 | sample_01 | control     |         420347 |            10918 |            3.84035  | True           |
|            2 | sample_02 | control     |        1140853 |            11506 |            1.41498  | False          |
|            3 | sample_10 | treated     |        1437892 |            11535 |            1.12267  | False          |
|            4 | sample_08 | treated     |        1520768 |            11565 |            1.06149  | False          |
|            5 | sample_05 | control     |        1569900 |            11621 |            1.02827  | False          |
|            6 | sample_12 | treated     |        1593333 |            11558 |            1.01315  | False          |
|            7 | sample_03 | control     |        1635227 |            11580 |            0.98719  | False          |
|            8 | sample_11 | treated     |        1888674 |            11674 |            0.854716 | False          |
|            9 | sample_06 | control     |        2006669 |            11674 |            0.804458 | False          |
|           10 | sample_07 | treated     |        2192901 |            11645 |            0.736139 | False          |
|           11 | sample_09 | treated     |        2403790 |            11672 |            0.671556 | False          |
|           12 | sample_04 | control     |        2694991 |            11720 |            0.598993 | False          |
