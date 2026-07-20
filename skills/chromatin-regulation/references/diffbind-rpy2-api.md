# DiffBind via rpy2 API Reference

R/Bioconductor package for differential binding analysis of ChIP-seq and ATAC-seq data. Computes read count matrices from peak sets and identifies differentially bound sites using DESeq2 or edgeR. Accessed from Python via rpy2.

## rpy2 Setup

```python
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.packages import importr
import pandas as pd
import numpy as np

pandas2ri.activate()

diffbind = importr("DiffBind")
base = importr("base")
```

## Step 1: Create DBA Object from Sample Sheet

```python
# Sample sheet CSV format:
# SampleID, Tissue, Factor, Condition, Treatment, Replicate, bamReads, ControlID, bamControl, Peaks, PeakCaller
# Sample1, Liver, H3K4me3, Treated, ChIP, 1, sample1.bam, Input1, input1.bam, sample1_peaks.bed, bed

# Load sample sheet and create DBA object
dba_obj = diffbind.dba(sampleSheet="samples.csv")

# Alternative: create from individual arguments
# (useful when building sample info programmatically)
sample_sheet_df = pd.DataFrame({
    "SampleID":   ["S1", "S2", "S3", "S4"],
    "Condition":  ["Treated", "Treated", "Control", "Control"],
    "Replicate":  [1, 2, 1, 2],
    "bamReads":   ["s1.bam", "s2.bam", "s3.bam", "s4.bam"],
    "bamControl": ["input1.bam", "input2.bam", "input3.bam", "input4.bam"],
    "Peaks":      ["s1.narrowPeak", "s2.narrowPeak", "s3.narrowPeak", "s4.narrowPeak"],
    "PeakCaller": ["narrow", "narrow", "narrow", "narrow"],
})
sample_sheet_r = pandas2ri.py2rpy(sample_sheet_df)
dba_obj = diffbind.dba(sampleSheet=sample_sheet_r)

# Print summary
print(dba_obj)
```

## Step 2: Count Reads in Peaks

```python
# Count reads overlapping consensus peak set
# This is the most time-consuming step
dba_obj = diffbind.dba_count(
    dba_obj,
    summits=250,           # re-center peaks to +/- 250bp around summit (recommended)
    minOverlap=2,          # minimum samples a peak must appear in
    bParallel=True,        # enable parallel processing
)

# summits=250 creates fixed-width 500bp windows centered on peak summits
# summits=FALSE keeps original peak coordinates

# Check the count matrix info
print(dba_obj)
```

## Step 3: Normalize

```python
# Normalization (DiffBind v3+ does this automatically in dba.analyze,
# but you can control it explicitly)
dba_obj = diffbind.dba_normalize(
    dba_obj,
    normalize="lib",           # "lib" (library size), "RLE", "TMM", "native"
    library="full",            # "full" (all reads) or "RiP" (reads in peaks)
    background=False,          # background normalization using non-peak bins
)
```

## Step 4: Set Up Contrasts

```python
# Define contrasts for differential analysis
# By default, uses all factor combinations found in sample sheet
dba_obj = diffbind.dba_contrast(
    dba_obj,
    categories=diffbind.DBA_CONDITION,  # compare by Condition column
    minMembers=2,                        # minimum samples per group
)

# Or specify explicit contrast
dba_obj = diffbind.dba_contrast(
    dba_obj,
    group1=diffbind.dba_mask(dba_obj, diffbind.DBA_CONDITION, "Treated"),
    group2=diffbind.dba_mask(dba_obj, diffbind.DBA_CONDITION, "Control"),
    name1="Treated",
    name2="Control",
)

# Multiple contrasts can be added sequentially
# dba_obj = diffbind.dba_contrast(dba_obj, group1=..., group2=..., name1=..., name2=...)
```

## Step 5: Differential Analysis

```python
# Run differential binding analysis
dba_obj = diffbind.dba_analyze(
    dba_obj,
    method=diffbind.DBA_DESEQ2,    # DBA_DESEQ2 (default) or DBA_EDGER
    # bBlacklist / bGreylist default to TRUE. Both need reference data that is
    # NOT in the inventory here (an ENCODE blacklist region set; GreyListChIP
    # plus genome annotation), and DiffBind fetches them over the network, which
    # is blocked — so leaving them on fails the analyze step. Turn them off,
    # and say in your output that peaks were not blacklist-filtered.
    bBlacklist=False,
    bGreylist=False,
)

# Using edgeR instead
# dba_obj = diffbind.dba_analyze(dba_obj, method=diffbind.DBA_EDGER)

# Check results summary
print(dba_obj)
```

## Step 6: Extract Results

```python
# Get differential binding report as a GRanges object
report = diffbind.dba_report(
    dba_obj,
    contrast=1,            # which contrast (1-indexed)
    th=1.0,                # FDR threshold (1.0 = return all sites)
    bUsePval=False,         # use FDR (False) or raw p-value (True)
    bNormalized=True,       # report normalized counts
    bCounts=True,           # include per-sample count columns
)

# Convert GRanges to pandas DataFrame
report_df = pandas2ri.rpy2py(base.as_data_frame(report))

# Columns:
# seqnames: chromosome
# start, end: peak coordinates
# width: peak width
# strand: strand
# Conc: mean concentration (log2 normalized count) across all samples
# Conc_Treated: mean concentration in Treated group
# Conc_Control: mean concentration in Control group
# Fold: log2 fold change (Treated/Control)
# p.value: raw p-value
# FDR: adjusted p-value (BH)
# Plus per-sample count columns if bCounts=True

# Filter significant sites
sig_sites = report_df[report_df["FDR"] < 0.05]
gained = sig_sites[sig_sites["Fold"] > 0]   # gained in Treated
lost = sig_sites[sig_sites["Fold"] < 0]     # lost in Treated

print(f"Total sites tested: {len(report_df)}")
print(f"Significant (FDR<0.05): {len(sig_sites)}")
print(f"Gained binding: {len(gained)}")
print(f"Lost binding: {len(lost)}")
```

## Retrieving Count Matrix

```python
# Get the full count matrix for custom analysis
count_info = diffbind.dba_peakset(
    dba_obj,
    bRetrieve=True,        # retrieve the count matrix as a GRanges
)

count_df = pandas2ri.rpy2py(base.as_data_frame(count_info))
# Columns include peak coordinates + per-sample read counts
```

## Plotting (Save to File)

```python
# PCA plot
ro.r(f'pdf("pca_plot.pdf")')
diffbind.dba_plotPCA(dba_obj, attributes=diffbind.DBA_CONDITION, label=diffbind.DBA_ID)
ro.r("dev.off()")

# MA plot for a specific contrast
ro.r(f'pdf("ma_plot.pdf")')
diffbind.dba_plotMA(dba_obj, contrast=1)
ro.r("dev.off()")

# Volcano plot
ro.r(f'pdf("volcano_plot.pdf")')
diffbind.dba_plotVolcano(dba_obj, contrast=1)
ro.r("dev.off()")

# Correlation heatmap
ro.r(f'pdf("heatmap.pdf")')
diffbind.dba_plotHeatmap(dba_obj)
ro.r("dev.off()")

# Venn diagram of overlapping peaks
ro.r(f'pdf("venn.pdf")')
diffbind.dba_plotVenn(dba_obj, mask=diffbind.dba_mask(dba_obj, diffbind.DBA_CONDITION))
ro.r("dev.off()")
```

## Exporting Results

```python
# Save significant sites as BED file
sig_bed = sig_sites[["seqnames", "start", "end"]].copy()
sig_bed.columns = ["chrom", "start", "end"]
sig_bed.to_csv("diffbind_significant.bed", sep="\t", header=False, index=False)

# Save full results
report_df.to_csv("diffbind_results.csv", index=False)
```

## Gotchas

- **BAM files must be indexed**: All BAM files need corresponding `.bai` index files. Use `samtools index` to create them.
- **Peak caller format**: The `PeakCaller` column in the sample sheet determines how peaks are parsed. Common values: `"narrow"` (MACS2 narrowPeak), `"broad"` (MACS2 broadPeak), `"bed"` (BED format), `"macs"` (MACS xls).
- **summits parameter**: Using `summits=250` (default) is strongly recommended. It creates uniform-width peaks centered on summits, improving comparability. Set `summits=FALSE` only for broad marks (H3K27me3, H3K36me3).
- **DiffBind v3 changes**: DiffBind v3+ changed the default analysis engine and normalization. The `dba.normalize()` function is new in v3. Check your installed version.
- **Contrast direction**: Positive fold change means enriched in group1 (first group in contrast). The naming depends on the order specified in `dba.contrast()`.
- **Memory**: dba.count() loads all BAM reads overlapping peaks into memory. For large datasets (many samples or broad peaks), this can require substantial RAM.
- **Blacklists are not available here**: `dba.analyze()` defaults `bBlacklist`/`bGreylist` to TRUE, and DiffBind resolves the ENCODE blacklist and the greylist genome annotation over the network. There is no egress and no runtime install, so the defaults fail the step outright. Pass `bBlacklist=False, bGreylist=False`, and record in your output that differential peaks were not blacklist-filtered — do not point the parameter at an invented path, and do not drop the caveat.
- **minOverlap in dba.count**: Controls the consensus peak set. `minOverlap=2` means a peak must be called in at least 2 samples. Increase for stricter consensus.
