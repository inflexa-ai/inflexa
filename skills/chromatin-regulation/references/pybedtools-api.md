# pybedtools API Reference

Python wrapper around the BEDTools command-line suite. Provides a pythonic interface for genomic interval manipulation with seamless pandas integration.

**Filenames in these examples are placeholders.** `peaks.bed` stands for a file you produced in this step; `genes.gtf` / `genes.bed` stand for reference annotation you must **resolve before you write the script**, asking for it by what it *is* rather than by a path — reference data is provisioned per-environment, so the directory, the filename, and the genome build all vary and none are yours to assume. Pass the resolved absolute path. GENCODE gene annotation and UCSC chromosome-sizes files are **in the reference inventory** — chromosome sizes as a default install, the annotation as an opt-in download. Resolve what you need before writing the script; if it is absent, report it and proceed with the interval operations that need no annotation, rather than inventing a path or skipping the step silently.

## BedTool Construction

```python
import pybedtools

# From a BED/GFF/VCF file
peaks = pybedtools.BedTool("peaks.bed")
genes = pybedtools.BedTool("genes.gtf")

# From a string (useful for testing)
peaks = pybedtools.BedTool(
    "chr1\t100\t200\tpeak1\t50\t+\n"
    "chr1\t500\t700\tpeak2\t80\t-\n",
    from_string=True,
)

# From a pandas DataFrame
import pandas as pd
df = pd.DataFrame({
    "chrom": ["chr1", "chr1", "chr2"],
    "start": [100, 500, 200],
    "end":   [200, 700, 400],
    "name":  ["a", "b", "c"],
    "score": [50, 80, 60],
    "strand": ["+", "-", "+"],
})
bt = pybedtools.BedTool.from_dataframe(df)

# From a list of intervals
intervals = [
    pybedtools.Interval("chr1", 100, 200, name="a", score="50", strand="+"),
    pybedtools.Interval("chr1", 500, 700, name="b", score="80", strand="-"),
]
bt = pybedtools.BedTool(intervals)
```

## Intersect

```python
peaks = pybedtools.BedTool("peaks.bed")
genes = pybedtools.BedTool("genes.bed")

# Default: report overlapping intervals from peaks
result = peaks.intersect(genes)

# Report original peak entries that overlap any gene
result = peaks.intersect(genes, u=True)

# Report peaks that do NOT overlap any gene
result = peaks.intersect(genes, v=True)

# Write both sides of the overlap (wa = write A, wb = write B)
result = peaks.intersect(genes, wa=True, wb=True)

# Minimum overlap fraction (50% of peak must overlap gene)
result = peaks.intersect(genes, f=0.5)

# Reciprocal overlap (50% in both directions)
result = peaks.intersect(genes, f=0.5, r=True)

# Strand-specific intersection
result = peaks.intersect(genes, s=True)    # same strand
result = peaks.intersect(genes, S=True)    # opposite strand

# Multiple B files
result = peaks.intersect(b=["genes.bed", "enhancers.bed"], wa=True, wb=True)
```

## Subtract

```python
# Remove portions of peaks that overlap genes
non_genic = peaks.subtract(genes)

# Remove peaks entirely if any overlap (like intersect -v)
non_overlapping = peaks.subtract(genes, A=True)

# Minimum overlap fraction required for subtraction
result = peaks.subtract(genes, f=0.5)
```

## Closest

```python
# Find nearest gene for each peak
nearest = peaks.closest(genes)

# Report distance in the last column
nearest = peaks.closest(genes, d=True)

# Upstream only (strand-aware)
nearest = peaks.closest(genes, D="a", iu=True)

# Downstream only
nearest = peaks.closest(genes, D="a", id=True)

# Report all ties (not just the first closest)
nearest = peaks.closest(genes, d=True, t="all")
```

## Merge

```python
# Merge overlapping intervals (input must be sorted)
merged = peaks.sort().merge()

# Merge if within 1000bp
merged = peaks.sort().merge(d=1000)

# Count merged intervals
merged = peaks.sort().merge(c=4, o="count")

# Collapse names of merged intervals
merged = peaks.sort().merge(c=4, o="collapse")

# Aggregate scores (mean)
merged = peaks.sort().merge(c=5, o="mean")
```

## Slop (Extend Intervals)

```python
# Genome file: tab-delimited file with chrom\tsize
# e.g. chr1\t248956422\nchr2\t242193529
#
# NOT usable here: pybedtools.chromsizes("hg38") fetches chromosome sizes from
# UCSC over the network, and there is no egress — the call fails outright.
# Build the genome file from your own data instead (see Genome File Requirements),
# and pass its resolved path as `g=`.

# Extend 500bp in both directions
extended = peaks.slop(b=500, g=genome_file)

# Extend asymmetrically
extended = peaks.slop(l=1000, r=500, g=genome_file)

# Extend by percentage of interval size
extended = peaks.slop(l=0.5, r=0.5, g=genome_file, pct=True)

# Strand-aware extension (l = upstream, r = downstream)
extended = peaks.slop(l=2000, r=0, g=genome_file, s=True)
```

## Window (Nearby Intervals)

```python
# Find genes within 10kb of each peak
nearby = peaks.window(genes, w=10000)
```

## Sort

```python
# Sort by chromosome then start position
sorted_peaks = peaks.sort()

# Sort by a specific column
sorted_peaks = peaks.sort(chrThenSizeA=True)  # by chrom then size ascending
```

## Coverage and Counting

```python
# Count overlaps of reads with features
coverage = genes.coverage(reads)
# Appends columns: count, bases_covered, feature_length, fraction_covered

# Genome coverage histogram.
# `genome="hg38"` resolves chromosome sizes over the network and fails here —
# pass `g=<resolved genome file path>` instead (see Genome File Requirements).
genomecov = pybedtools.BedTool("reads.bam").genome_coverage(g=genome_file, bg=True)
# bedGraph-format output: chrom, start, end, coverage
```

## Conversion to/from pandas

```python
# BedTool to pandas DataFrame
df = peaks.to_dataframe()
# Columns named: chrom, start, end, name, score, strand (for 6-col BED)

# With custom column names
df = peaks.to_dataframe(names=["chrom", "start", "end", "peak_id", "signal", "strand"])

# pandas DataFrame to BedTool
bt = pybedtools.BedTool.from_dataframe(df)
```

## Saving Results

```python
# Save to file
result.saveas("output.bed")

# Compress output
result.saveas("output.bed.gz")

# Method chaining with save
peaks.intersect(genes, u=True).sort().merge().saveas("merged_peaks_in_genes.bed")
```

## Method Chaining

```python
# pybedtools supports method chaining for complex operations
result = (
    peaks
    .slop(b=500, g=genome_file)
    .intersect(genes, u=True)
    .sort()
    .merge(d=100)
    .saveas("result.bed")
)
```

## Genome File Requirements

Many operations require a genome file (chromosome sizes). **`pybedtools.chromsizes("hg38")` is not usable here** — it queries UCSC over the network and there is no egress. Two offline routes, in this order:

**Prefer your own BAM header when you have one.** UCSC chromosome-sizes files are in the reference inventory (hg38 and mm39, installed by default), and resolving one is the right move when you have no aligned reads. But a BAM header is derived from the exact build your intervals were mapped to, so it cannot disagree with them on contig naming or length — whereas a staged file can, silently. If you resolve a staged one, check its build and its `chr` prefixing against your data first.

```python
# PREFERRED: generate from a BAM header. Your aligned reads already carry the
# exact chromosome names and lengths of the build they were mapped to, so this
# is both offline and guaranteed to match your intervals.
import pysam
bam = pysam.AlignmentFile("sample.bam", "rb")
with open("output/genome.txt", "w") as f:
    for item in bam.header["SQ"]:
        f.write(f"{item['SN']}\t{item['LN']}\n")

genome_file = "output/genome.txt"

# Alternative: from a FASTA index, if you have a FASTA and its .fai.
#   cut -f1,2 <resolved>.fai > output/genome.txt
# The only genome FASTA in the reference inventory is a PGx-scoped GRCh38 bundle
# shipped as a .tar; the store is read-only, so it must be extracted into your
# working directory before anything can read it or its index.
```

If you have no BAM and no FASTA index, resolve the staged chromosome-sizes file for your build. If that is absent too, say so and skip the operations that require a genome file — do not invent a chromosome-sizes path.

## Temporary File Management

```python
# pybedtools creates temp files automatically. Clean them up when done.
pybedtools.cleanup()

# Set temp directory (important in containers with limited /tmp).
# Point it inside your working directory — that is the one place you may write.
import os
os.makedirs("tmp", exist_ok=True)
pybedtools.set_tempdir("tmp")

# Delete all temp files on exit
import atexit
atexit.register(pybedtools.cleanup)
```

## Gotchas

- **Input must be sorted** for `merge()`, `complement()`, `genomecov()`, and `cluster()`. Always call `.sort()` first.
- **Genome file required** for `slop()`, `flank()`, `complement()`, `genomecov()`, and `random()`. Without it you get cryptic errors. Build one from your BAM header, or resolve a staged chromosome-sizes file (see Genome File Requirements) — the built-in `pybedtools.chromsizes()` lookup needs network egress and always fails here.
- **Coordinate system**: BED is 0-based half-open. GFF/GTF is 1-based inclusive. pybedtools handles this internally but be aware when converting to/from pandas.
- **Temp files accumulate**: pybedtools creates temporary files for each operation. Call `pybedtools.cleanup()` periodically or register it with `atexit`.
- **to_dataframe() column naming**: Default column names depend on the number of columns. For non-standard BED files, always pass explicit `names=`.
- **BAM input**: Some methods accept BAM files directly (e.g., `intersect`, `coverage`). BAM files must be sorted and indexed.
- **Large files**: For very large files (>10M intervals), operations may be slow. Consider shelling out to the `bedtools` CLI directly for better performance, or pre-filter data.
- **from_dataframe column order**: The DataFrame must have columns in BED order (chrom, start, end, ...). Column names don't matter; position does.
