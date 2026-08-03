---
name: chromatin-regulation
description: Chromatin regulation analysis from called peaks and count matrices — differential binding, signal summarisation, peak annotation, and scATAC-seq
version: 1.0.0
tags: [atac-seq, chip-seq, cut-and-tag, cut-and-run, peaks, diffbind, chromatin]
---

# Chromatin Regulation Analysis

Guidelines for analysing chromatin accessibility (ATAC-seq) and histone/TF
binding (ChIP-seq, CUT&Tag/CUT&Run) from **called peaks, count matrices, and
signal tracks**: differential binding, signal summarisation, peak annotation,
and single-cell chromatin profiling.

## Where This Pack Starts

Your input is a peak set, a count matrix, a bigWig track, or an aligned BAM you
read signal from. Alignment, filtering and peak calling are upstream and out of
scope — no aligner or peak caller is installed. If you are handed FASTQ or
unpeaked alignments, say what processed form you need and stop.

Knowing what produced the input still matters for interpreting it. Peaks
normally come from MACS2 (ATAC and ChIP) or SEACR (CUT&Tag/CUT&Run); alignments
from Bowtie2 or BWA-MEM. Use those names to read the file headers and
provenance you are given, not as steps to run.

**What to establish about a supplied dataset**, because each changes how the
counts may be interpreted and none can be recovered here:

- **Tn5 offset correction** (ATAC): a +4/-5 bp shift. If it was not applied,
  base-resolution positional claims are shifted by ~4-5 bp. Peak-level
  differential analysis is unaffected.
- **Duplicate handling**: CUT&Tag produces natural duplicates by tagmentation,
  so removing them discards real signal. If duplicates were marked on CUT&Tag
  data, say so — the counts understate the signal.
- **Spike-in normalisation** (CUT&Tag/CUT&Run): required when comparing
  conditions with globally different signal levels. If the counts were not
  spike-in normalised, a global shift cannot be distinguished from no change,
  and you cannot recover the scale factor from the counts alone.
- **Peak-set provenance**: peak sets from different callers or settings are not
  comparable by width or count. Harmonise to a consensus set first.

## Method-Selection Decision Tree

### 1. Differential binding / accessibility

```
Peak calls from replicated conditions
  → DiffBind (R via rpy2, works for all assay types):
    → dba() → dba.count() → dba.normalize() → dba.contrast() → dba.analyze()
      → Backend: DESeq2 (default, better for small sample sizes) or edgeR
        → dba.report() for differential peaks
          → Filter: padj < 0.05 AND abs(log2FC) > 1
```

- DiffBind is the unified framework across ATAC-seq, ChIP-seq and CUT&Tag. It
  counts over peaks you supply; it does not call them.
- Always use biological replicates (minimum n=2 per condition, n=3 preferred).
- Use consensus peak sets (peaks present in >=2 replicates) to reduce noise.

### 2. Signal summarisation

```
bigWig track, or an aligned BAM
  → Binned, depth-normalized coverage → bigWig (when starting from BAM)
    → Per-region signal extraction at an anchor (peak centers, or a TSS set if
      an annotation was provided)
      → Heatmap + average profile
```

- `pysam` or `bedtools genomecov` for binned counts, `pyBigWig` to write the
  track and to read per-region signal (`values()`, `stats(nBins=...)`), numpy to
  stack the region-by-bin matrix, matplotlib for the heatmap and column-mean
  profile. See `references/signal-tracks-api.md`.
- Anchor on your own peak set by default. TSS-anchored profiles need a gene
  annotation; **GENCODE gene annotation is in the reference inventory, as an
  opt-in download rather than part of a default install**, so resolve it before
  planning on it and expect it may not be staged. If it is absent, report the
  gap rather than substituting an arbitrary region set.
- Always normalize signal (RPKM or CPM) for cross-sample comparisons.

### 3. Peak annotation

- Overlaps, nearest-gene assignment and distance-to-TSS with `pybedtools` or
  PyRanges, against a gene annotation resolved from the reference inventory.
- Report the annotation source and version. Nearest-gene is a proximity claim,
  not a regulatory one — a peak's nearest gene is not necessarily its target.

### 4. scATAC-seq

```
Fragment files or a peak/tile count matrix
  → QC: filter by unique fragments (>1000) and TSS enrichment (>4)
    → Feature matrix: tile-based (500bp bins) or peak-based
      → Dimensionality reduction: TF-IDF + LSI (latent semantic indexing)
        → Clustering: Leiden on LSI space
          → Gene activity scores
```

- SnapATAC2 is the preferred Python tool — but it is **installed on x86_64
  only** (PyPI ships no linux-aarch64 wheel), so on an arm64 host `import
  snapatac2` fails and that is expected, not a broken install. Import it inside
  a `try`/`except ImportError` and, when unavailable, run the same workflow on
  the peak/tile count matrix with scanpy: TF-IDF + TruncatedSVD for LSI,
  `sc.pp.neighbors` on the LSI embedding, `sc.tl.leiden` for clustering.
- Signac (R via rpy2) when the work is Seurat-shaped.
- Do NOT use PCA directly on scATAC count matrices. Use TF-IDF + LSI, which
  handles the extreme sparsity of single-cell chromatin data.

### 5. Motif analysis and footprinting — not available

Neither can be assembled from what is here. Motif enrichment needs a scanner and
a motif database: none is staged, and chromVAR was dropped from Bioconductor
(which is why Signac is pinned to a version that predates its removal).
Footprinting needs a Tn5-bias-correcting scorer, which is likewise absent.

Genome sequence is resolvable from the reference inventory, but sequence alone
is not a motif analysis. Report the gap and confine the conclusions to what the
peaks and counts support — do not approximate either method, and do not name a
TF from a peak's nearest gene and present it as motif evidence.

## Anti-Patterns

- **Calling peaks**: Do NOT attempt to call peaks, or reimplement a caller. The
  peak set is an input. Report what you need instead.
- **Single-replicate differential binding**: DiffBind's statistics assume
  replication. A consensus set built on one replicate per condition produces
  confident-looking results with no basis.
- **Removing CUT&Tag duplicates**, or reporting counts from data where they were
  removed without saying so — tagmentation creates duplicates by design.
- **Comparing CUT&Tag/CUT&Run conditions with different signal levels** when the
  counts were not spike-in normalised upstream. It cannot be corrected here.
- **PCA on scATAC count matrices**: use TF-IDF + LSI for the extreme sparsity.
- **Treating peak width or count as biology** when the sets came from different
  callers or settings. Harmonise to a consensus set first.
- **Nearest-gene as a regulatory claim**: proximity is not targeting.

## Output Conventions

- Peak files: BED or narrowPeak/broadPeak format.
- Count matrices: AnnData (.h5ad) with peaks as `var`, samples/cells as `obs`.
- Differential results: CSV with `chr`, `start`, `end`, `log2FC`, `pvalue`,
  `padj`, `nearest_gene`, `distance_to_TSS`.
- Signal tracks: bigWig files (RPKM-normalized).
- Figures: peak heatmaps and average profiles, volcano plots for differential
  peaks, peak-annotation distribution over genomic features.

## Additional Available Packages

- **cooler** / **cooltools**: Hi-C contact matrices (`.cool`/`.mcool`) — a
  different assay from the ones above, and the route when the input is 3D
  contacts rather than peaks: compartments, TAD insulation, loop calling.

## References

- `references/diffbind-rpy2-api.md` — Differential binding analysis via rpy2
- `references/signal-tracks-api.md` — Coverage tracks, normalization, heatmaps, and profile plots
- `references/pybedtools-api.md` — Genomic interval operations in Python
- `references/pybigwig-api.md` — BigWig file reading and signal extraction
