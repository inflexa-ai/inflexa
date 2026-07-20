# deeptools CLI Reference

Command-line suite for processing and visualizing high-throughput sequencing data (ChIP-seq, ATAC-seq, RNA-seq). All commands below are shell commands.

> **deeptools is not installed in this environment.** It is absent from the library store, so `bamCoverage`, `bamCompare`, `multiBamSummary`, `computeMatrix`, `plotHeatmap`, `plotProfile`, `plotCorrelation` and `plotFingerprint` do not exist on PATH — and with no network egress it cannot be installed at runtime. **Verify availability before you plan around any of it** (`command -v bamCoverage`); expect it to be missing. When it is: say so plainly in your output, name the blocked step, and take a route that exists rather than emitting commands that cannot run. This reference stays here because it is correct the moment deeptools is staged.

**What to use instead, per task:**

| deeptools step | Available substitute |
|-|-|
| `bamCoverage` (BAM → binned/normalized signal) | Count reads per bin with `pysam` (`count_coverage`, or `fetch()` into a numpy bin array) and write the track with `pyBigWig` (`addHeader` / `addEntries`); or `bedtools genomecov -bg -ibam` for a bedGraph. Apply CPM/RPKM scaling yourself from the mapped-read total. |
| `bamCompare` (log2 ratio of two BAMs) | Bin both BAMs on the same grid as above, then compute the ratio in numpy with an explicit pseudocount. |
| `multiBamSummary` + `plotCorrelation` | Build the bins-by-samples count matrix with `pysam`/`bedtools multicov`, then correlate with `numpy`/`pandas` (`.corr(method="spearman")`) and plot with `matplotlib`/`seaborn`. |
| `computeMatrix` + `plotHeatmap`/`plotProfile` | Extract per-region signal from an existing bigWig with `pyBigWig.values()` or `.stats(nBins=...)` over the anchored windows, stack into a numpy array, and plot with `matplotlib` (`imshow` for the heatmap, column means for the profile). See `references/pybigwig-api.md`. |
| `plotFingerprint` | Cumulative-sum plot of a binned count matrix in numpy/matplotlib. |

Read the substitute as a real deliverable, not a consolation: the anchored-signal matrix and its heatmap are ordinary numpy work once the per-region values are in hand.

**Reference tracks are resolved, never named.** A blacklist region set, a gene-annotation BED, and a chromosome-sizes file are all provisioned per-environment; the directory, the filename, and the genome build vary and none are yours to assume. Ask for the *track* by what it is, and pass the resolved absolute path. An ENCODE blacklist BED and a genome GTF/BED are **not currently in the reference inventory** — if you look and they are not there, report it, run the step without blacklist filtering (noting the caveat in your output), and never invent a path or silently drop the option.

## bamCoverage -- Generate BigWig from BAM

Converts a BAM file to a normalized BigWig signal track.

```bash
# Basic coverage track
bamCoverage -b sample.bam -o sample.bw

# With RPKM normalization
bamCoverage -b sample.bam -o sample_rpkm.bw \
    --normalizeUsing RPKM

# CPM normalization (counts per million)
bamCoverage -b sample.bam -o sample_cpm.bw \
    --normalizeUsing CPM

# BPM normalization (bins per million, like TPM for bins)
bamCoverage -b sample.bam -o sample_bpm.bw \
    --normalizeUsing BPM

# RPGC normalization (reads per genomic content / 1x normalization)
bamCoverage -b sample.bam -o sample_rpgc.bw \
    --normalizeUsing RPGC \
    --effectiveGenomeSize 2913022398  # hg38

# Common options.
#   --binSize            resolution in bp (default 50)
#   --smoothLength       smooth over N bp window
#   --extendReads        extend reads to fragment length
#   --ignoreDuplicates   skip PCR duplicates
#   --minMappingQuality  MAPQ filter
#   --blackListFileName  path you resolved; drop the flag if no blacklist is available
bamCoverage -b sample.bam -o sample.bw \
    --normalizeUsing CPM \
    --binSize 10 \
    --smoothLength 60 \
    --extendReads 200 \
    --ignoreDuplicates \
    --minMappingQuality 30 \
    --blackListFileName "$BLACKLIST_BED" \
    --numberOfProcessors 8
```

### Effective Genome Sizes

| Genome | Size |
|--------|------|
| hg38   | 2913022398 |
| hg19   | 2864785220 |
| mm10   | 2652783500 |
| mm9    | 2620345972 |
| dm6    | 142573017 |

## bamCompare -- Compare Two BAM Files

Generates a BigWig of the ratio or difference between two BAM files (e.g., ChIP vs input).

```bash
# Log2 ratio (ChIP / input) -- most common for ChIP-seq
bamCompare -b1 chip.bam -b2 input.bam \
    -o chip_vs_input_log2.bw \
    --operation log2 \
    --normalizeUsing CPM \
    --binSize 50 \
    --numberOfProcessors 8

# Subtract (treatment - control)
bamCompare -b1 treatment.bam -b2 control.bam \
    -o treatment_minus_control.bw \
    --operation subtract

# Other operations: ratio, reciprocal_ratio, first, second, add, mean
bamCompare -b1 chip.bam -b2 input.bam \
    -o ratio.bw --operation ratio

# With read extension and duplicate removal
bamCompare -b1 chip.bam -b2 input.bam \
    -o normalized.bw \
    --operation log2 \
    --extendReads 200 \
    --ignoreDuplicates \
    --scaleFactorsMethod readCount \
    --numberOfProcessors 8
```

## multiBamSummary -- Sample Correlation Matrix

Computes read counts across the genome for multiple BAM files.

```bash
# Genome-wide bins (for correlation analysis)
multiBamSummary bins \
    -b sample1.bam sample2.bam sample3.bam sample4.bam \
    -o multibam_results.npz \
    --labels S1 S2 S3 S4 \
    --binSize 10000 \
    --numberOfProcessors 8

# Over specific BED regions
multiBamSummary BED-file \
    -b sample1.bam sample2.bam \
    --BED peaks.bed \
    -o multibam_results.npz \
    --labels S1 S2

# Visualize correlation
plotCorrelation \
    -in multibam_results.npz \
    --corMethod spearman \
    --whatToPlot heatmap \
    --skipZeros \
    --plotTitle "Spearman Correlation" \
    -o correlation_heatmap.png \
    --outFileCorMatrix correlation_matrix.tsv

# Scatter plot
plotCorrelation \
    -in multibam_results.npz \
    --corMethod pearson \
    --whatToPlot scatterplot \
    -o correlation_scatter.png
```

## computeMatrix -- Prepare Data for Heatmaps/Profiles

Aggregates signal scores around genomic regions. Two modes: reference-point and scale-regions.

**`-R` needs a region set you actually have.** `genes.bed` in the examples below is a placeholder for a gene-annotation BED, and **no GTF/GFF or gene BED is in the reference inventory** — a TSS- or gene-body-anchored matrix is therefore not runnable here unless an annotation is handed to you. Peak-anchored profiles need no annotation: your own peak calls (`peaks.bed`, a consensus set, a differential subset) are region sets you produced, and are the default here. If the analysis genuinely requires TSS anchoring, report the missing annotation instead of substituting an arbitrary region set.

### reference-point Mode

Computes signal relative to a single anchor point (TSS, TES, center).

```bash
# Signal around TSS (+/- 3kb).
# "$GENE_BED" is an annotation BED you resolved; there is none in the
# inventory, so confirm you were given one before writing this step.
computeMatrix reference-point \
    --referencePoint TSS \
    -b 3000 -a 3000 \
    -R "$GENE_BED" \
    -S chip_signal.bw input_signal.bw \
    --skipZeros \
    -o matrix_tss.gz \
    --outFileSortedRegions regions_tss.bed \
    --numberOfProcessors 8

# Signal around peak centers
computeMatrix reference-point \
    --referencePoint center \
    -b 2000 -a 2000 \
    -R peaks.bed \
    -S h3k4me3.bw h3k27me3.bw h3k27ac.bw \
    --samplesLabel "H3K4me3" "H3K27me3" "H3K27ac" \
    --skipZeros \
    -o matrix_peaks.gz
```

### scale-regions Mode

Scales all regions to a uniform length, with optional flanking.

```bash
# Gene body with 3kb flanking (needs the resolved annotation BED)
computeMatrix scale-regions \
    -R "$GENE_BED" \
    -S chip_signal.bw \
    --beforeRegionStartLength 3000 \
    --regionBodyLength 5000 \
    --afterRegionStartLength 3000 \
    --skipZeros \
    -o matrix_scaled.gz \
    --numberOfProcessors 8

# Multiple region files (plotted as separate groups).
# Promoter/gene-body sets are derived from an annotation you were given;
# enhancer sets are usually your own peak calls.
computeMatrix scale-regions \
    -R promoters.bed enhancers.bed gene_bodies.bed \
    -S h3k4me3.bw h3k27ac.bw \
    --beforeRegionStartLength 1000 \
    --regionBodyLength 5000 \
    --afterRegionStartLength 1000 \
    -o matrix_multi.gz
```

## plotHeatmap -- Visualize Matrix as Heatmap

```bash
# Basic heatmap
plotHeatmap -m matrix_tss.gz \
    -out heatmap.png \
    --colorMap RdBu_r \
    --whatToShow "heatmap and colorbar" \
    --zMin -2 --zMax 2

# Publication-quality heatmap
plotHeatmap -m matrix_peaks.gz \
    -out heatmap_pub.png \
    --dpi 300 \
    --colorMap RdBu_r \
    --whatToShow "heatmap and colorbar" \
    --heatmapHeight 15 \
    --heatmapWidth 4 \
    --zMin -3 --zMax 3 \
    --sortUsing mean \
    --sortUsingSamples 1 \
    --yAxisLabel "Signal" \
    --regionsLabel "Peaks" \
    --samplesLabel "H3K4me3" "H3K27me3" "H3K27ac"

# K-means clustering
plotHeatmap -m matrix_peaks.gz \
    -out heatmap_kmeans.png \
    --kmeans 4 \
    --sortUsing mean \
    --colorMap YlOrRd

# Output sorted regions for downstream use
plotHeatmap -m matrix_peaks.gz \
    -out heatmap.png \
    --outFileSortedRegions sorted_regions.bed \
    --outFileNameMatrix heatmap_values.tsv
```

## plotProfile -- Average Signal Profile

```bash
# Basic profile plot
plotProfile -m matrix_tss.gz \
    -out profile.png \
    --perGroup \
    --colors red blue green \
    --plotTitle "Signal at TSS"

# Per-sample profile with SE
plotProfile -m matrix_peaks.gz \
    -out profile_detail.png \
    --plotType se \
    --yAxisLabel "Coverage" \
    --regionsLabel "Peaks" \
    --samplesLabel "H3K4me3" "H3K27me3" "H3K27ac"

# Heatmap + profile combined
plotProfile -m matrix_peaks.gz \
    -out profile_heatmap.png \
    --plotType heatmap
```

## plotFingerprint -- Library Complexity QC

```bash
# Assess ChIP enrichment quality
plotFingerprint \
    -b chip1.bam chip2.bam input1.bam input2.bam \
    --labels ChIP1 ChIP2 Input1 Input2 \
    -o fingerprint.png \
    --outQualityMetrics fingerprint_metrics.tsv \
    --numberOfProcessors 8
```

## Gotchas

- **BAM files must be indexed**: All BAM files need `.bai` index files.
- **BigWig files must be indexed**: deeptools creates indexed BigWig files by default.
- **binSize tradeoff**: Smaller bins (10bp) give higher resolution but larger files and slower processing. 50bp is a good default; use 10bp for detailed peak analysis.
- **extendReads**: For single-end ChIP-seq, set this to the estimated fragment size (typically 150-300bp). For paired-end data, omit this flag (deeptools uses actual fragment sizes).
- **effectiveGenomeSize**: Required for RPGC normalization. Use the appropriate value for your genome and read length (see table above).
- **--skipZeros**: Recommended for computeMatrix to exclude regions with no signal, preventing them from diluting the heatmap.
- **Multiple BED files in computeMatrix**: Each BED file becomes a separate group in the heatmap/profile. Use this to compare signal at different feature types.
- **Memory**: multiBamSummary with many samples and small bin sizes can use substantial memory. Increase binSize or use BED-file mode with a targeted region set.
- **plotHeatmap sorting**: Default sorts by mean signal. Use `--sortUsing region_length` for unsorted output, or `--kmeans` / `--hclust` for clustering.
