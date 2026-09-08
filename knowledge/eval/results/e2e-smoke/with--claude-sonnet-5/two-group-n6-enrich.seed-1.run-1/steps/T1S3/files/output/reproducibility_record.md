# Reproducibility record

Run ID: `619852b4-1723-48f1-b3fe-f19dbee5d2d9`

## Step-by-step environment and parameters
### T1S1_qc_eda
- **template**: tpl-qc-eda@1.0.0
- **snapshot**: sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a
- **environment_match**: exact
- Package pins (all `status: exact` match to farm environment):
  - DESeq2 1.52.0 (bioconductor)
  - ggplot2 4.0.3 (cran)
  - pheatmap 1.0.13 (cran)
  - jsonlite 2.0.0 (cran)

### T1S2_deseq2
- **template**: tpl-deseq2-two-group@1.0.0
- **snapshot**: sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a
- **environment_match**: exact
- Package pins (all `status: exact` match to farm environment):
  - DESeq2 1.52.0 (bioconductor)
  - apeglm 1.34.0 (bioconductor)
  - ashr 2.2-63 (cran)
  - ggplot2 4.0.3 (cran)
  - pheatmap 1.0.13 (cran)
  - jsonlite 2.0.0 (cran)
- **design_formula**: ~condition
- **reference_level**: control
- **contrast**: {'factor': 'condition', 'test': 'treated', 'reference': 'control', 'name': 'condition: treated vs control', 'coefficient': 'condition_treated_vs_control'}
- **alpha**: 0.05
- **lfc_shrink_method**: apeglm
- **random_seed**: not set/reported by tpl-deseq2-two-group@1.0.0 (Wald test + apeglm shrinkage are deterministic given the count matrix; no stochastic step requiring a seed)

### T2S1_fgsea_hallmark
- **template**: tpl-fgsea-preranked@1.0.0 (rendered separately per collection; this record reflects the last (Reactome) render's slots per T2S1's own summary -- Hallmark render used identical pins, differing only in gmt_path/output_prefix)
- **snapshot**: sha256:90c687582244894c67c212e63855415984027bcd54c896821c4e065cf8b5467a
- **environment_match**: exact
- Package pins (all `status: exact` match to farm environment):
  - fgsea 1.38.0 (bioconductor)
  - ggplot2 4.0.3 (cran)
  - jsonlite 2.0.0 (cran)
- **database**: MSigDB Hallmark human, 2026.1 (h.all.v2026.1.Hs.symbols.gmt)
- **ranking_metric**: stat
- **min_size**: 15
- **max_size**: 500
- **random_seed**: 42

### T2S1_fgsea_reactome
- **database**: Reactome pathways, release 'current' (host-provisioned snapshot; Reactome overwrites this quarterly)
- **source_gmt**: /mnt/refs/managed/reactome-pathways/current/ReactomePathways.gmt
- **n_pathways_raw**: 2868
- **n_pathways_after_human_filter**: 2868
- **ranking_metric**: stat
- **min_size**: 15
- **max_size**: 500
- **random_seed**: 42

### T2S1_gene_id_mapping_qc
- **mapping_source**: org.Hs.eg.db
- **org_hs_eg_db_version**: 3.23.1
- **note**: GSEA ranking and testing (fgsea vs Hallmark/Reactome) is performed directly on gene symbols, which is the native identifier space of both GMT collections; this Entrez mapping is a reporting/QC step on gene identifier quality, not an input to the enrichment test.

## Raw R session info per step
### T1S1
```
R version 4.6.0 (2026-04-24)
Platform: aarch64-unknown-linux-gnu
Running under: Ubuntu 24.04.4 LTS

Matrix products: default
BLAS:   /usr/lib/aarch64-linux-gnu/openblas-pthread/libblas.so.3 
LAPACK: /usr/lib/aarch64-linux-gnu/openblas-pthread/libopenblasp-r0.3.26.so;  LAPACK version 3.12.0

locale:
 [1] LC_CTYPE=en_US.UTF-8       LC_NUMERIC=C              
 [3] LC_TIME=en_US.UTF-8        LC_COLLATE=en_US.UTF-8    
 [5] LC_MONETARY=en_US.UTF-8    LC_MESSAGES=en_US.UTF-8   
 [7] LC_PAPER=en_US.UTF-8       LC_NAME=C                 
 [9] LC_ADDRESS=C               LC_TELEPHONE=C            
[11] LC_MEASUREMENT=en_US.UTF-8 LC_IDENTIFICATION=C       

time zone: Etc/UTC
tzcode source: system (glibc)

attached base packages:
[1] stats4    stats     graphics  grDevices utils     datasets  methods  
[8] base     

other attached packages:
 [1] jsonlite_2.0.0              pheatmap_1.0.13            
 [3] ggplot2_4.0.3               DESeq2_1.52.0              
 [5] SummarizedExperiment_1.42.0 Biobase_2.72.0             
 [7] MatrixGenerics_1.24.0       matrixStats_1.5.0          
 [9] GenomicRanges_1.64.0        Seqinfo_1.2.0              
[11] IRanges_2.46.0              S4Vectors_0.50.2           
[13] BiocGenerics_0.58.1         generics_0.1.4             

loaded via a namespace (and not attached):
 [1] Matrix_1.7-5        gtable_0.3.6        dplyr_1.2.1        
 [4] compiler_4.6.0      tidyselect_1.2.1    Rcpp_1.1.1-1.1     
 [7] parallel_4.6.0      dichromat_2.0-0.1   textshaping_1.0.5  
[10] systemfonts_1.3.2   scales_1.4.0        BiocParallel_1.46.0
[13] lattice_0.22-9      R6_2.6.1            XVector_0.52.0     
[16] labeling_0.4.3      S4Arrays_1.12.0     tibble_3.3.1       
[19] DelayedArray_0.38.2 pillar_1.11.1       RColorBrewer_1.1-3 
[22] rlang_1.2.0         S7_0.2.2            viridisLite_0.4.3  
[25] SparseArray_1.12.2  cli_3.6.6           withr_3.0.3        
[28] magrittr_2.0.5      locfit_1.5-9.12     grid_4.6.0         
[31] lifecycle_1.0.5     vctrs_0.7.3         glue_1.8.1         
[34] farver_2.1.2        ragg_1.5.2          codetools_0.2-20   
[37] abind_1.4-8         pkgconfig_2.0.3     tools_4.6.0
```

### T1S2
```
R version 4.6.0 (2026-04-24)
Platform: aarch64-unknown-linux-gnu
Running under: Ubuntu 24.04.4 LTS

Matrix products: default
BLAS:   /usr/lib/aarch64-linux-gnu/openblas-pthread/libblas.so.3 
LAPACK: /usr/lib/aarch64-linux-gnu/openblas-pthread/libopenblasp-r0.3.26.so;  LAPACK version 3.12.0

locale:
 [1] LC_CTYPE=en_US.UTF-8       LC_NUMERIC=C              
 [3] LC_TIME=en_US.UTF-8        LC_COLLATE=en_US.UTF-8    
 [5] LC_MONETARY=en_US.UTF-8    LC_MESSAGES=en_US.UTF-8   
 [7] LC_PAPER=en_US.UTF-8       LC_NAME=C                 
 [9] LC_ADDRESS=C               LC_TELEPHONE=C            
[11] LC_MEASUREMENT=en_US.UTF-8 LC_IDENTIFICATION=C       

time zone: Etc/UTC
tzcode source: system (glibc)

attached base packages:
[1] stats4    stats     graphics  grDevices utils     datasets  methods  
[8] base     

other attached packages:
 [1] jsonlite_2.0.0              pheatmap_1.0.13            
 [3] ggplot2_4.0.3               DESeq2_1.52.0              
 [5] SummarizedExperiment_1.42.0 Biobase_2.72.0             
 [7] MatrixGenerics_1.24.0       matrixStats_1.5.0          
 [9] GenomicRanges_1.64.0        Seqinfo_1.2.0              
[11] IRanges_2.46.0              S4Vectors_0.50.2           
[13] BiocGenerics_0.58.1         generics_0.1.4             

loaded via a namespace (and not attached):
 [1] gtable_0.3.6        lattice_0.22-9      numDeriv_2016.8-1.1
 [4] vctrs_0.7.3         tools_4.6.0         parallel_4.6.0     
 [7] tibble_3.3.1        pkgconfig_2.0.3     Matrix_1.7-5       
[10] SQUAREM_2026.1      RColorBrewer_1.1-3  S7_0.2.2           
[13] lifecycle_1.0.5     truncnorm_1.0-9     compiler_4.6.0     
[16] farver_2.1.2        textshaping_1.0.5   codetools_0.2-20   
[19] pillar_1.11.1       MASS_7.3-65         BiocParallel_1.46.0
[22] DelayedArray_0.38.2 emdbook_1.3.14      abind_1.4-8        
[25] tidyselect_1.2.1    locfit_1.5-9.12     bdsmatrix_1.3-7    
[28] mvtnorm_1.4-1       dplyr_1.2.1         ashr_2.2-63        
[31] labeling_0.4.3      grid_4.6.0          cli_3.6.6          
[34] invgamma_1.2        SparseArray_1.12.2  magrittr_2.0.5     
[37] S4Arrays_1.12.0     dichromat_2.0-0.1   withr_3.0.3        
[40] scales_1.4.0        XVector_0.52.0      ragg_1.5.2         
[43] coda_0.19-4.1       irlba_2.3.7         bbmle_1.0.25.1     
[46] viridisLite_0.4.3   rlang_1.2.0         Rcpp_1.1.1-1.1     
[49] mixsqp_0.3-54       glue_1.8.1          apeglm_1.34.0      
[52] R6_2.6.1            plyr_1.8.9          systemfonts_1.3.2
```

### T2S1
```
R version 4.6.0 (2026-04-24)
Platform: aarch64-unknown-linux-gnu
Running under: Ubuntu 24.04.4 LTS

Matrix products: default
BLAS:   /usr/lib/aarch64-linux-gnu/openblas-pthread/libblas.so.3 
LAPACK: /usr/lib/aarch64-linux-gnu/openblas-pthread/libopenblasp-r0.3.26.so;  LAPACK version 3.12.0

locale:
 [1] LC_CTYPE=en_US.UTF-8       LC_NUMERIC=C              
 [3] LC_TIME=en_US.UTF-8        LC_COLLATE=en_US.UTF-8    
 [5] LC_MONETARY=en_US.UTF-8    LC_MESSAGES=en_US.UTF-8   
 [7] LC_PAPER=en_US.UTF-8       LC_NAME=C                 
 [9] LC_ADDRESS=C               LC_TELEPHONE=C            
[11] LC_MEASUREMENT=en_US.UTF-8 LC_IDENTIFICATION=C       

time zone: Etc/UTC
tzcode source: system (glibc)

attached base packages:
[1] stats     graphics  grDevices utils     datasets  methods   base     

other attached packages:
[1] jsonlite_2.0.0 ggplot2_4.0.3  fgsea_1.38.0  

loaded via a namespace (and not attached):
 [1] Matrix_1.7-5        gtable_0.3.6        dplyr_1.2.1        
 [4] compiler_4.6.0      tidyselect_1.2.1    Rcpp_1.1.1-1.1     
 [7] parallel_4.6.0      dichromat_2.0-0.1   systemfonts_1.3.2  
[10] scales_1.4.0        textshaping_1.0.5   BiocParallel_1.46.0
[13] lattice_0.22-9      R6_2.6.1            labeling_0.4.3     
[16] generics_0.1.4      tibble_3.3.1        pillar_1.11.1      
[19] RColorBrewer_1.1-3  rlang_1.2.0         fastmatch_1.1-8    
[22] S7_0.2.2            viridisLite_0.4.3   cli_3.6.6          
[25] withr_3.0.3         magrittr_2.0.5      grid_4.6.0         
[28] cowplot_1.2.0       lifecycle_1.0.5     vctrs_0.7.3        
[31] glue_1.8.1          data.table_1.18.4   farver_2.1.2       
[34] codetools_0.2-20    ragg_1.5.2          tools_4.6.0        
[37] pkgconfig_2.0.3
```
