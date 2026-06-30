# pybedtools API Reference

Python wrapper around the BEDTools command-line suite. Provides a pythonic interface for genomic interval manipulation with seamless pandas integration.

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
genome = pybedtools.chromsizes("hg38")
# Or use a file: genome = "hg38.genome"

# Extend 500bp in both directions
extended = peaks.slop(b=500, g="hg38.genome")

# Extend asymmetrically
extended = peaks.slop(l=1000, r=500, g="hg38.genome")

# Extend by percentage of interval size
extended = peaks.slop(l=0.5, r=0.5, g="hg38.genome", pct=True)

# Strand-aware extension (l = upstream, r = downstream)
extended = peaks.slop(l=2000, r=0, g="hg38.genome", s=True)
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

# Genome coverage histogram
genomecov = pybedtools.BedTool("reads.bam").genome_coverage(genome="hg38", bg=True)
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
    .slop(b=500, g="hg38.genome")
    .intersect(genes, u=True)
    .sort()
    .merge(d=100)
    .saveas("result.bed")
)
```

## Genome File Requirements

Many operations require a genome file (chromosome sizes). Ways to provide it:

```python
# Use built-in genome
genome = pybedtools.chromsizes("hg38")

# From a file (tab-delimited: chrom\tsize)
# chr1  248956422
# chr2  242193529

# Generate from a BAM header
import pysam
bam = pysam.AlignmentFile("sample.bam", "rb")
with open("genome.txt", "w") as f:
    for item in bam.header["SQ"]:
        f.write(f"{item['SN']}\t{item['LN']}\n")

# Generate from a FASTA index
# cut -f1,2 ref.fa.fai > genome.txt
```

## Temporary File Management

```python
# pybedtools creates temp files automatically. Clean them up when done.
pybedtools.cleanup()

# Set temp directory (important in containers with limited /tmp)
pybedtools.set_tempdir("/path/to/tmp")

# Delete all temp files on exit
import atexit
atexit.register(pybedtools.cleanup)
```

## Gotchas

- **Input must be sorted** for `merge()`, `complement()`, `genomecov()`, and `cluster()`. Always call `.sort()` first.
- **Genome file required** for `slop()`, `flank()`, `complement()`, `genomecov()`, and `random()`. Without it you get cryptic errors.
- **Coordinate system**: BED is 0-based half-open. GFF/GTF is 1-based inclusive. pybedtools handles this internally but be aware when converting to/from pandas.
- **Temp files accumulate**: pybedtools creates temporary files for each operation. Call `pybedtools.cleanup()` periodically or register it with `atexit`.
- **to_dataframe() column naming**: Default column names depend on the number of columns. For non-standard BED files, always pass explicit `names=`.
- **BAM input**: Some methods accept BAM files directly (e.g., `intersect`, `coverage`). BAM files must be sorted and indexed.
- **Large files**: For very large files (>10M intervals), operations may be slow. Consider using `bedtools` CLI directly via `execute_command` for better performance, or pre-filter data.
- **from_dataframe column order**: The DataFrame must have columns in BED order (chrom, start, end, ...). Column names don't matter; position does.
