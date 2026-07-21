# Coverage Tracks, Heatmaps and Profile Plots

Producing normalized signal from aligned reads, and plotting it over regions of
interest. Everything here is built from `pysam`, `pyBigWig`, `bedtools`, `numpy`
and `matplotlib`, which are the staged route for this work.

Normalization is the part to get right: it is arithmetic you apply yourself from
the mapped-read total, and an unnormalized track compared against a normalized
one is a meaningless comparison. State which scaling you used in the output.

## BAM → binned, normalized coverage track

Count reads per bin with `pysam` — either `count_coverage()`, or `fetch()` into a
numpy bin array — then write the track with `pyBigWig` (`addHeader()` then
`addEntries()`). For a bedGraph instead of a bigWig, `bedtools genomecov -bg
-ibam` produces one directly.

Apply the scaling factor to the binned counts before writing:

| Scaling | Factor |
|-|-|
| CPM (counts per million) | `1e6 / total_mapped_reads` |
| RPKM | `1e9 / (total_mapped_reads * bin_size)` |
| BPM (per-bin TPM analogue) | normalize bins to sum to 1e6 |
| 1x / RPGC | `effective_genome_size / (total_mapped_reads * read_length)` |

Filter as you count, not afterwards: MAPQ threshold (30 is typical), skip PCR
duplicates by testing the flag, and drop blacklisted intervals if a blacklist is
available to you — if none is, say so rather than silently skipping the step,
because artefact regions dominate signal where they are present.

### Effective genome sizes

Needed for 1x/RPGC scaling only.

| Genome | Size |
|--------|------|
| hg38   | 2913022398 |
| hg19   | 2864785220 |
| mm10   | 2652783500 |
| mm9    | 2620345972 |
| dm6    | 142573017 |

## Comparing two BAMs (ChIP vs input)

Bin both BAMs on the **same** grid, then compute the ratio in numpy with an
explicit pseudocount — the pseudocount is a choice that changes the result at low
coverage, so pick one deliberately and report it. Log2 ratio is the usual form
for ChIP over input; subtraction is the alternative when the inputs are already
depth-matched.

## Sample correlation

Build a bins-by-samples count matrix (`pysam`, or `bedtools multicov` over a bin
BED), then correlate with `pandas` (`.corr(method="spearman")`) and plot with
`matplotlib`/`seaborn`. Spearman over Pearson unless the signal is already
variance-stabilized: raw coverage is heavy-tailed and Pearson will track the
extremes.

## Region heatmaps and profile plots

From an existing bigWig, extract per-region signal with `pyBigWig.values()` for
base resolution, or `.stats(nBins=...)` for a fixed number of bins per region —
the latter is what you want when regions differ in length and must be stacked
into one matrix. See `pybigwig-api.md`.

Anchor the windows explicitly (TSS-centred, peak-centred, or scaled gene body),
stack into a numpy array of regions × bins, then:

- **heatmap** — `matplotlib` `imshow`, rows sorted by mean signal or by a cluster
  assignment; state which, since the sort determines what the figure appears to show
- **profile** — column means across the region axis, with a confidence band from
  the column standard error

## Fingerprint / cumulative enrichment

Cumulative sum of a sorted binned count matrix, plotted per sample. A sharply
convex curve indicates strong enrichment; a diagonal indicates none. Useful as a
QC check on whether a ChIP worked at all before spending effort downstream.
