# PyRanges API Reference

Python library for fast genomic interval manipulation built on pandas DataFrames. Coordinates are 0-based, half-open (start included, end excluded).

**Filenames in these examples are placeholders.** `peaks.bed` stands for a file you produced in this step. `genes.gtf` / `annotations.gff3` / `genes.bed` stand for a **gene annotation you must resolve before writing the script**, asking for it by what it is rather than by a path — reference data is provisioned per-environment, so the directory, the filename, and the genome build all vary and none are yours to assume. Pass the resolved absolute path. A genome GTF/GFF/BED annotation is **not currently in the reference inventory**: if you look and it is not there, report that annotation-dependent steps (promoter definition, nearest-gene assignment, gene-body overlap) cannot be run, and deliver the interval results that need no annotation. Never invent a path and never skip the step silently.

## Construction

```python
import pyranges as pr
import pandas as pd

# From pandas DataFrame (requires Chromosome, Start, End columns; Strand optional)
df = pd.DataFrame({
    "Chromosome": ["chr1", "chr1", "chr2", "chr2"],
    "Start":      [100,    500,    200,    800],
    "End":        [300,    700,    400,    1000],
    "Strand":     ["+",    "+",    "-",    "-"],
    "Name":       ["a",    "b",    "c",    "d"],
    "Score":      [1.5,    2.3,    0.8,    3.1],
})
gr = pr.PyRanges(df)

# From BED file
gr = pr.read_bed("peaks.bed")

# From GFF/GTF file
gr = pr.read_gff3("annotations.gff3")
gr = pr.read_gtf("genes.gtf")

# From dict
gr = pr.PyRanges({"Chromosome": ["chr1"], "Start": [100], "End": [200]})
```

## Basic Properties and Access

```python
# Underlying DataFrame
df = gr.df                     # pandas DataFrame (PyRanges 0.x)
df = gr.as_df()                # also works

# Column access
print(gr.Chromosome)           # Series
print(gr.columns)              # column names
print(len(gr))                 # number of intervals

# Subset by chromosome
chr1 = gr["chr1"]              # PyRanges with only chr1 intervals
chr1_plus = gr["chr1", "+"]    # also filter by strand
```

## Overlap Operations

```python
peaks = pr.read_bed("peaks.bed")
genes = pr.read_bed("genes.bed")

# intersect: return overlapping sub-intervals (trimmed to overlap region)
overlap_regions = peaks.intersect(genes)

# With strandedness control
overlap_regions = peaks.intersect(genes, strandedness="same")    # same strand
overlap_regions = peaks.intersect(genes, strandedness="opposite")
overlap_regions = peaks.intersect(genes, strandedness=False)     # ignore strand

# overlap: return full intervals from peaks that overlap any gene
overlapping_peaks = peaks.overlap(genes)
overlapping_peaks = peaks.overlap(genes, strandedness=False)

# subtract: remove portions of peaks that overlap genes
non_genic = peaks.subtract(genes)

# count_overlaps: count how many genes each peak overlaps
peaks_with_counts = peaks.count_overlaps(genes)
# Adds a "NumberOverlaps" column
```

## Join Operations

```python
# join: pair intervals from both sets that overlap (like SQL inner join)
joined = peaks.join(genes, strandedness=False)
# Result contains columns from both PyRanges, suffixed to avoid collisions
# e.g. Start, End, Start_b, End_b, Name, Name_b

# join with suffix control
joined = peaks.join(genes, suffix="_gene", strandedness=False)
```

## Nearest

```python
# nearest: find the nearest interval in genes for each peak
nearest = peaks.nearest(genes, strandedness=False)
# Adds Distance column (0 for overlapping intervals)

# Upstream/downstream only
nearest_up = peaks.nearest(genes, how="upstream")
nearest_down = peaks.nearest(genes, how="downstream")
```

## Merge and Cluster

```python
# merge: collapse overlapping intervals into single intervals
merged = peaks.merge()

# merge with a slack distance (merge if within 1000 bp)
merged = peaks.merge(slack=1000)

# merge grouped by a metadata column
merged = peaks.merge(by="Name")

# cluster: assign a cluster ID to overlapping intervals (no collapsing)
clustered = peaks.cluster()
# Adds a "Cluster" column
```

## Extend and Resize

```python
# extend: grow intervals symmetrically
extended = peaks.extend(100)       # add 100 bp on each side

# extend directionally (strand-aware)
extended = peaks.extend({"5": 500, "3": 200})

# Resize: set all intervals to a fixed width, anchored at midpoint.
# There is no single resize() call — recompute the coordinates on the frame.
WIDTH = 500
df = peaks.df.copy()
midpoint = (df["Start"] + df["End"]) // 2
df["Start"] = (midpoint - WIDTH // 2).clip(lower=0)
df["End"] = df["Start"] + WIDTH
resized = pr.PyRanges(df)
```

## Genome Arithmetic

```python
# tile_genome: split a whole genome into fixed-width, non-overlapping bins.
# The chromosome-sizes dict is illustrative — derive real sizes from your BAM
# header or VCF contig lines rather than hardcoding a build's lengths.
tiles = pr.tile_genome(chrom_sizes, tile_size=10000)

# Split an existing interval set into chunks:
windowed = peaks.window(1000)   # cut each interval into 1000 bp pieces
tiled = peaks.tile(1000)        # snap each interval onto a fixed 1000 bp grid
```

## Conversion

```python
# To pandas DataFrame
df = gr.df                     # or gr.as_df()

# To BED file
gr.to_bed("output.bed")

# To GFF3 file
gr.to_gff3("output.gff3")

# To GTF file
gr.to_gtf("output.gtf")

# To BigWig (requires chromsizes)
# gr.to_bigwig("output.bw", chromsizes)
```

## Sorting and Filtering

```python
# Sort by genomic position
sorted_gr = gr.sort()

# Filter with pandas-style boolean indexing
filtered = gr[gr.Score > 1.0]
filtered = gr[gr.Chromosome == "chr1"]

# Apply function to each chromosome/strand group
result = gr.apply(lambda df: df[df.Score > df.Score.median()])
```

## Common Workflow: Peak Annotation

```python
import pyranges as pr
import pandas as pd

peaks = pr.read_bed("peaks.bed")
genes = pr.read_gtf("genes.gtf")

# Get promoter regions (2kb upstream of TSS)
tss = genes[genes.Feature == "gene"].copy()
tss_df = tss.df.copy()
tss_df.loc[tss_df.Strand == "+", "End"] = tss_df.loc[tss_df.Strand == "+", "Start"] + 1
tss_df.loc[tss_df.Strand == "-", "Start"] = tss_df.loc[tss_df.Strand == "-", "End"] - 1
tss = pr.PyRanges(tss_df)
promoters = tss.extend({"5": 2000, "3": 0})

# Find peaks in promoters
peaks_in_promoters = peaks.overlap(promoters, strandedness=False)

# Annotate peaks with nearest gene
annotated = peaks.nearest(genes[genes.Feature == "gene"], strandedness=False)
result_df = annotated.df
```

## Gotchas

- **Coordinates are 0-based half-open**: Start is included, End is excluded. A 1-bp interval at position 100 is `Start=100, End=101`.
- **Strand is optional**: If Strand column is absent, the PyRanges is unstranded and strandedness parameters are ignored.
- **strandedness default**: Most operations default to `"same"` strand matching when both objects are stranded. Pass `strandedness=False` to ignore strand.
- **Column name collisions in join**: When joining two PyRanges with same column names, the second set gets a suffix (default `"_b"`).
- **PyRanges 0.x vs 1.x**: The API changed between major versions. `.df` returns the DataFrame in 0.x; 1.x may use `.as_df()`. Check your installed version.
- **Empty results**: Operations that yield no overlaps return an empty PyRanges (length 0), not None.
- **merge() drops metadata**: By default, `merge()` only keeps Chromosome, Start, End, Strand. Use `by=` to preserve grouping columns, or use `cluster()` to keep all columns.
