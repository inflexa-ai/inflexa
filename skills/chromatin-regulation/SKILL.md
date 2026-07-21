---
name: chromatin-regulation
description: Chromatin regulation analysis — ATAC-seq, ChIP-seq, CUT&Tag/CUT&Run, differential binding, motif analysis, and scATAC-seq
version: 1.0.0
tags: [atac-seq, chip-seq, cut-and-tag, cut-and-run, peaks, diffbind, chromatin]
---

# Chromatin Regulation Analysis

Comprehensive guidelines for chromatin accessibility (ATAC-seq), histone/TF binding (ChIP-seq, CUT&Tag/CUT&Run), differential analysis, motif discovery, footprinting, and single-cell chromatin profiling.

## Method-Selection Decision Tree

**Read the CLI tools note below before planning any step from raw reads.** The trees describe the canonical method end to end, but the read-processing binaries they name (`bowtie2`, `picard`, `macs2`, SEACR, HOMER, TOBIAS) and deeptools are **not installed here** — expect to receive aligned BAMs, called peaks, or a count matrix and to start from there. Probe before planning around any binary; report a gap rather than emitting a pipeline that cannot run.

### 1. ATAC-seq

```
Paired-end FASTQ
  → Alignment: Bowtie2 (--very-sensitive, --maxins 2000, --no-mixed --no-discordant)
    → Filter: remove mitochondrial reads, duplicates (Picard), MAPQ >= 30
      → Tn5 offset correction: shift +4/-5 bp (accounts for 9bp duplication by Tn5)
        → Peak calling: MACS2 --nomodel --shift -100 --extsize 200 --keep-dup all
          → QC metrics:
            → TSS enrichment score (>= 6 is good, >= 10 is excellent)
            → Fragment size distribution (nucleosome periodicity ~200bp)
            → FRiP (fraction of reads in peaks, >= 0.2)
              → Count matrix: featureCounts on consensus peak set
                → Differential accessibility: DiffBind (DESeq2 or edgeR backend)
```

- Tn5 offset correction is mandatory for ATAC-seq. Without it, footprinting and motif analysis are shifted by ~4-5 bp.
- The `--shift -100 --extsize 200` MACS2 parameters are ATAC-specific. Do NOT use default ChIP-seq MACS2 parameters.

### 2. ChIP-seq

```
Single-end or paired-end FASTQ
  → Alignment: Bowtie2 or BWA-MEM
    → Filter: duplicates (Picard), MAPQ >= 30
      → Peak calling (MACS2):
        → Narrow peaks (TFs, H3K4me3, H3K27ac): macs2 callpeak -f BAM -g hs -q 0.01
        → Broad peaks (H3K36me3, H3K27me3, H3K9me3): macs2 callpeak --broad --broad-cutoff 0.1
          → QC metrics:
            → FRiP (>= 0.01 for broad marks, >= 0.1 for TFs)
            → Strand cross-correlation (RSC >= 1, NSC >= 1.05)
            → IDR for replicate concordance
              → Differential binding: DiffBind
```

- ALWAYS use `--broad` for histone marks that form broad domains (H3K27me3, H3K36me3, H3K9me3). Narrow peak calling misses these.
- Input/IgG control is essential for ChIP-seq. Peak calling without control has high false positive rates.

### 3. CUT&Tag / CUT&Run

```
Paired-end FASTQ
  → Alignment: Bowtie2 (--end-to-end --very-sensitive --no-mixed)
    → Filter: MAPQ >= 30, remove duplicates ONLY for CUT&Run (keep for CUT&Tag)
      → Spike-in normalization: align to E. coli genome, compute scale factor
        → Peak calling:
          → SEACR (preferred for low-background CUT&Tag/CUT&Run)
            → seacr stringent (for high-confidence peaks)
            → seacr relaxed (for broader discovery)
          → MACS2 (alternative, with adjusted parameters)
            → macs2 callpeak --nomodel --qvalue 0.01 --keep-dup all
              → Differential: DiffBind
```

- SEACR is preferred over MACS2 for CUT&Tag/CUT&Run due to its handling of sparse, low-background signal.
- CUT&Tag has very low background — using MACS2 with default (loose) thresholds produces excessive false peaks. Use stringent q-value cutoffs if MACS2 is used.
- Do NOT remove duplicates for CUT&Tag. The protocol produces natural duplicates from the tagmentation step.

### 4. Differential Binding / Accessibility

```
Peak calls from replicated conditions
  → DiffBind (R via rpy2, works for all assay types):
    → dba() → dba.count() → dba.normalize() → dba.contrast() → dba.analyze()
      → Backend: DESeq2 (default, better for small sample sizes) or edgeR
        → dba.report() for differential peaks
          → Filter: padj < 0.05 AND abs(log2FC) > 1
```

- DiffBind is the unified framework for differential analysis across ATAC-seq, ChIP-seq, and CUT&Tag.
- Always use biological replicates (minimum n=2 per condition, n=3 preferred).
- Use consensus peak sets (peaks present in >=2 replicates) to reduce noise.

### 5. Motif Analysis

```
Differential or condition-specific peak sets
  → HOMER (comprehensive motif enrichment):
    → findMotifsGenome.pl peaks.bed genome_build output_dir -size 200
      → Reports known motif enrichment + de novo motifs

  → chromVAR (per-cell deviation scores for scATAC):
    → Compute TF motif accessibility deviation per cell
      → Differential deviation between clusters
```

- HOMER is the standard for bulk motif enrichment from peak sets.
- chromVAR is specifically designed for single-cell ATAC — it computes per-cell TF activity scores.

### 6. TF Footprinting

```
ATAC-seq BAM (Tn5-corrected) + peak regions
  → TOBIAS:
    → ATACorrect (correct Tn5 insertion bias)
      → FootprintScores (compute per-base footprint scores)
        → BINDetect (differential TF binding between conditions)
```

- TOBIAS is the standard for ATAC-seq footprinting. It corrects for Tn5 sequence bias before scoring.
- Footprinting requires high sequencing depth (>50M unique fragments recommended).

### 7. Signal Visualization

```
BAM files
  → Binned, depth-normalized coverage → bigWig
    → Per-region signal extraction at an anchor (peak centers, or a TSS set if
      an annotation was provided)
      → Heatmap + average profile
```

- **deeptools is not installed here** (`bamCoverage`, `computeMatrix`, `plotHeatmap`, `plotProfile` are all absent) and there is no egress to install it. Verify before planning around it; when it is missing, build the same product from what is present: `pysam` or `bedtools genomecov` for binned counts, `pyBigWig` to write the track and to read per-region signal (`values()`, `stats(nBins=...)`), numpy to stack the region-by-bin matrix, matplotlib to draw the heatmap and the column-mean profile. `references/deeptools-cli.md` maps each deeptools step to its substitute.
- Anchor on your own peak calls by default. TSS-anchored profiles need a gene annotation; **GENCODE gene annotation is in the reference inventory, as an opt-in download rather than part of a default install**, so resolve it before planning on it and expect it may not be staged. If it is absent, report the gap rather than substituting an arbitrary region set.
- Always normalize signal (RPKM or CPM) for cross-sample comparisons, whichever route produces the track.

### 8. scATAC-seq

```
Fragment files (10x CellRanger-ATAC or custom)
  → SnapATAC2 (Python, preferred) or ArchR (R)
    → QC: filter by unique fragments (>1000) and TSS enrichment (>4)
      → Feature matrix: tile-based (500bp bins) or peak-based
        → Dimensionality reduction: TF-IDF + LSI (latent semantic indexing)
          → Clustering: Leiden on LSI space
            → Per-cluster peak calling: MACS2 on aggregated fragments
              → Gene activity scores: SnapATAC2 or ArchR gene scoring
                → TF motif activity: chromVAR deviation scores
```

- SnapATAC2 is the preferred Python tool for scATAC-seq — but it is **installed on x86_64 only** (PyPI ships no linux-aarch64 wheel), so on an arm64 host `import snapatac2` fails and that is expected, not a broken install. Import it inside a `try`/`except ImportError` and, when it is unavailable, run the same workflow on the peak/tile count matrix with scanpy: TF-IDF + TruncatedSVD for LSI, `sc.pp.neighbors` on the LSI embedding, `sc.tl.leiden` for clustering. ArchR (R) is not staged either — do not plan on it without probing.
- Do NOT use PCA directly on scATAC count matrices. Use TF-IDF + LSI, which handles the extreme sparsity of single-cell chromatin data.

## Anti-Patterns

- **ChIP-seq MACS2 parameters for ATAC-seq**: Do NOT use default MACS2 parameters for ATAC-seq. ATAC-seq requires `--nomodel --shift -100 --extsize 200` to account for Tn5 transposition. Default parameters model ChIP fragment sizes and produce incorrect peak calls.
- **Ignoring fragment size distribution**: Do NOT skip fragment size QC. ATAC-seq should show nucleosome-free (<150bp) and mono-nucleosome (~200bp) peaks. Absence of this pattern indicates failed experiment or protocol issues.
- **Loose MACS2 threshold for CUT&Tag**: Do NOT use MACS2 with default q-value for CUT&Tag data. CUT&Tag has near-zero background, so loose thresholds call thousands of noise peaks. Use SEACR or stringent MACS2 thresholds.
- **Not using paired-end mode**: Do NOT run paired-end data in single-end mode. ATAC-seq and CUT&Tag are paired-end protocols. SE mode discards fragment size information critical for nucleosome positioning and QC.
- **Removing CUT&Tag duplicates**: Do NOT mark or remove duplicates in CUT&Tag data. The tagmentation step naturally creates duplicates — removing them discards real signal.
- **Missing spike-in normalization for CUT&Tag/CUT&Run**: Do NOT compare CUT&Tag/CUT&Run samples without spike-in normalization when signal levels differ between conditions (e.g., drug treatment reducing a histone mark).
- **Footprinting at low depth**: Do NOT attempt TF footprinting with TOBIAS on libraries with <30M unique fragments. Footprints require high coverage to resolve the ~10bp protection pattern.

## Output Conventions

- Peak files: BED or narrowPeak/broadPeak format.
- Count matrices: AnnData (.h5ad) with peaks as `var`, samples/cells as `obs`.
- Differential results: CSV with `chr`, `start`, `end`, `log2FC`, `pvalue`, `padj`, `nearest_gene`, `distance_to_TSS`.
- Signal tracks: bigWig files (RPKM-normalized) for genome browser visualization.
- Figures: TSS enrichment plots, fragment size distributions, peak heatmaps, motif enrichment tables, volcano plots for differential peaks.
- Motif results: ranked table of TFs with enrichment p-values and percent of targets with motif.

## Additional Available Packages

### Python (3D Genomics and Interval Operations)

- **cooler**: Read/write/manipulate Hi-C contact matrices in .cool/.mcool format. Use `cooler.Cooler()` for single resolution, `cooler.open()` for multi-resolution.
- **cooltools**: Hi-C analysis — compartment calling (`cooltools.eigs_cis`), TAD insulation (`cooltools.insulation`), loop calling (`cooltools.dots`), saddle plots, expected contact frequency.
- **bioframe**: Genomic interval operations (like PyRanges but pandas-native). Used by cooltools for interval arithmetic.

### R (via rpy2)

- **rtracklayer**: Read/write BED, BigWig, GFF in R. Use `import()` / `export()` for format conversion and signal extraction.

### CLI tools

Present on every architecture: `samtools`, `bedtools`, `bcftools`, `tabix`. These cover BAM filtering/indexing/stats, interval arithmetic, and coverage.

The read-processing tools the decision trees above name — `bowtie2`, `picard`, `macs2`, `SEACR`, `HOMER`, `TOBIAS` — are **not staged here**, and there is no egress to install them. They describe the canonical upstream pipeline, which is normally run before the data reaches you: expect to be handed aligned BAMs and called peaks. Probe (`command -v <binary>`) before planning any step that needs one, and if you were handed raw FASTQ with no aligner available, say so and stop rather than emitting a pipeline that cannot run.

- **samtools**: MAPQ filtering (`view -q 30`), mitochondrial-read removal, duplicate flagging (`markdup`), indexing, `flagstat`/`idxstats` QC, and paired-end insert-size distributions for the fragment-size check.
- **bedtools**: consensus peak sets (`intersect`, `merge`, `multiinter`), coverage (`genomecov`, `multicov`) for count matrices, and interval arithmetic in place of a dedicated tool.

## References

- `references/diffbind-rpy2-api.md` — Differential binding analysis via rpy2
- `references/deeptools-cli.md` — Signal normalization, heatmaps, and profile plots (deeptools is **absent** here; the file opens with the substitute route per step)
- `references/pybedtools-api.md` — Genomic interval operations in Python
- `references/pybigwig-api.md` — BigWig file reading and signal extraction
