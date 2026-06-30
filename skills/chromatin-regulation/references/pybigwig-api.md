# pyBigWig API Reference

Python extension for reading and writing BigWig and BigBed files. Built on libBigWig for fast access to signal tracks. Supports both local and remote files.

## Opening Files

```python
import pyBigWig

# Open a local BigWig file for reading
bw = pyBigWig.open("signal.bw")

# Open a remote BigWig file (HTTP/HTTPS)
bw = pyBigWig.open("https://example.com/data/signal.bw")

# Open a BigBed file
bb = pyBigWig.open("annotations.bb")

# Open for writing
bw_out = pyBigWig.open("output.bw", "w")

# Check file type
print(bw.isBigWig())    # True
print(bw.isBigBed())    # False
```

## Header Information

```python
bw = pyBigWig.open("signal.bw")

# File header metadata
header = bw.header()
# Returns dict with keys:
# version: file format version
# nLevels: number of zoom levels
# nBasesCovered: total bases with values
# minVal: minimum signal value
# maxVal: maximum signal value
# sumData: sum of all values
# sumSquared: sum of squared values

print(f"Coverage: {header['nBasesCovered']} bases")
print(f"Value range: [{header['minVal']}, {header['maxVal']}]")
```

## Chromosome Information

```python
# Get all chromosomes and their sizes
chroms = bw.chroms()
# Returns dict: {'chr1': 248956422, 'chr2': 242193529, ...}

# Get size of a specific chromosome
chr1_size = bw.chroms("chr1")
# Returns int: 248956422

# Non-existent chromosome returns None
result = bw.chroms("chrUNKNOWN")
# Returns None
```

## Region Statistics (stats)

Compute summary statistics over a region. Uses zoom levels for speed by default.

```python
# Mean signal over a region (default statistic)
mean_val = bw.stats("chr1", 100000, 200000)
# Returns list: [0.5432...]

# Other statistic types
max_val = bw.stats("chr1", 100000, 200000, type="max")
min_val = bw.stats("chr1", 100000, 200000, type="min")
cov_val = bw.stats("chr1", 100000, 200000, type="coverage")  # fraction covered
std_val = bw.stats("chr1", 100000, 200000, type="std")        # standard deviation
sum_val = bw.stats("chr1", 100000, 200000, type="sum")

# Multiple bins (divide region into N equal bins)
binned = bw.stats("chr1", 100000, 200000, type="mean", nBins=10)
# Returns list of 10 values, one per bin

# Whole chromosome (omit start/end)
chr_mean = bw.stats("chr1")

# Exact statistics (slower but precise; default uses zoom-level approximations)
exact_mean = bw.stats("chr1", 100000, 200000, exact=True)
```

## Per-Base Values (values)

Retrieve the signal value at every single base in a region. Returns NaN for bases with no value.

```python
import numpy as np

# Get per-base signal (returns Python list)
vals = bw.values("chr1", 100000, 100100)
# Returns list of 100 float values

# Convert to numpy for analysis
vals_np = np.array(bw.values("chr1", 100000, 200000))

# Handle NaN values (bases with no data)
valid = vals_np[~np.isnan(vals_np)]
mean_signal = np.nanmean(vals_np)

# Example: signal in a window around a peak summit
summit = 150000
window = 500
signal = np.array(bw.values("chr1", summit - window, summit + window))
```

## Intervals

Retrieve non-zero intervals overlapping a region. More memory-efficient than `values()` for sparse tracks.

```python
# Get intervals as list of (start, end, value) tuples
intervals = bw.intervals("chr1", 100000, 200000)
# Returns: ((100000, 100050, 1.5), (100050, 100100, 2.3), ...)

# Each tuple: (start, end, value) -- 0-based half-open coordinates

# Convert to DataFrame
import pandas as pd
if intervals:
    df = pd.DataFrame(intervals, columns=["start", "end", "value"])
    df["chrom"] = "chr1"

# Whole chromosome
all_intervals = bw.intervals("chr1")
```

## Common Analysis Patterns

### Signal at Peak Summits

```python
import pyBigWig
import pandas as pd
import numpy as np

bw = pyBigWig.open("chip_signal.bw")
peaks = pd.read_csv("peaks.bed", sep="\t", header=None,
                     names=["chrom", "start", "end", "name", "score", "strand"])

# Get mean signal at each peak
peaks["mean_signal"] = [
    bw.stats(row.chrom, row.start, row.end, type="mean")[0]
    for _, row in peaks.iterrows()
]

# Get max signal at each peak
peaks["max_signal"] = [
    bw.stats(row.chrom, row.start, row.end, type="max")[0]
    for _, row in peaks.iterrows()
]

bw.close()
```

### Signal Profile Around TSS

```python
bw = pyBigWig.open("chip_signal.bw")

tss_list = [(chrom, pos) for chrom, pos in zip(df["chrom"], df["tss"])]
window = 3000
n_bins = 100

profiles = []
for chrom, tss in tss_list:
    start = max(0, tss - window)
    end = tss + window
    binned = bw.stats(chrom, start, end, type="mean", nBins=n_bins)
    profiles.append([v if v is not None else 0 for v in binned])

# Average profile
avg_profile = np.nanmean(profiles, axis=0)

bw.close()
```

### Compare Two BigWig Tracks

```python
bw1 = pyBigWig.open("condition1.bw")
bw2 = pyBigWig.open("condition2.bw")

regions = pd.read_csv("regions.bed", sep="\t", header=None,
                       names=["chrom", "start", "end"])

ratios = []
for _, row in regions.iterrows():
    s1 = bw1.stats(row.chrom, row.start, row.end, type="mean")[0] or 0
    s2 = bw2.stats(row.chrom, row.start, row.end, type="mean")[0] or 0
    if s2 > 0:
        ratios.append(np.log2((s1 + 1) / (s2 + 1)))
    else:
        ratios.append(np.nan)

regions["log2_ratio"] = ratios

bw1.close()
bw2.close()
```

## Writing BigWig Files

```python
import pyBigWig

bw = pyBigWig.open("output.bw", "w")

# Step 1: Add header with chromosome sizes (must come first, must be in order)
bw.addHeader([
    ("chr1", 248956422),
    ("chr2", 242193529),
    ("chr3", 198295559),
])

# Step 2: Add entries (bedGraph-like format)
# Entries must be added in chromosomal order, non-overlapping
bw.addEntries(
    ["chr1", "chr1", "chr1"],       # chromosomes
    [0, 100, 200],                   # starts
    ends=[100, 200, 300],            # ends
    values=[1.0, 2.5, 0.8],         # signal values
)

# Add entries for next chromosome
bw.addEntries(
    ["chr2", "chr2"],
    [0, 500],
    ends=[500, 1000],
    values=[3.2, 1.1],
)

# Step 3: Close (triggers index building -- can be slow for large files)
bw.close()
```

## Closing Files

```python
# Always close files when done
bw.close()

# Or use context manager pattern (not natively supported, but you can wrap it)
# Manual pattern:
try:
    bw = pyBigWig.open("signal.bw")
    vals = bw.stats("chr1", 0, 1000)
finally:
    bw.close()
```

## Gotchas

- **stats() uses zoom-level approximations by default**: For genome-browser-style queries this is fine, but for precise calculations use `exact=True`. The difference can be significant for small regions.
- **values() returns a Python list, not numpy**: Convert with `np.array()` for efficient computation. For large regions, this list can consume substantial memory.
- **NaN for uncovered bases**: `values()` returns `nan` for positions without data. Always use `np.nanmean()` etc. instead of `np.mean()`.
- **stats() returns a list**: Even for a single bin, the return value is a list (e.g., `[0.5]`). Access with `[0]`. Returns `[None]` if the region has no data.
- **Chromosome names must match exactly**: BigWig chromosome names are case-sensitive. `chr1` and `Chr1` are different. Check `bw.chroms()` for the exact names used.
- **Writing order matters**: When writing, entries must be added in chromosome order matching the header, and within each chromosome they must be non-overlapping and sorted by start position.
- **Remote file access**: Opening remote files works but can be slow. For repeated queries, download the file first.
- **No context manager**: pyBigWig does not support Python `with` statements natively. Always use try/finally or explicit `close()`.
- **addHeader is required before addEntries**: Calling addEntries before addHeader will fail silently or produce a corrupt file.
