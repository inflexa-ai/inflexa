# xcms -- LC-MS/GC-MS Preprocessing Pipeline

R/Bioconductor package for untargeted metabolomics data preprocessing: peak detection (CentWave), retention time alignment (Obiwarp, PeakGroups), correspondence (PeakDensity), and gap filling. The standard pipeline for converting raw mzML files into a sample-by-feature intensity matrix.

## Setup

```r
library(xcms)
library(MSnbase)
```

xcms depends on MSnbase for data classes. Both must be loaded. If using xcms >= 4.0 with the Spectra backend, also load `library(Spectra)` — but the MSnbase on-disk workflow below remains fully supported.

## Step 1: Read Raw Data

```r
# Define input files — must be absolute paths to centroided mzML files
files <- c(
  "/data/inputs/sample1.mzML",
  "/data/inputs/sample2.mzML",
  "/data/inputs/sample3.mzML",
  "/data/inputs/sample4.mzML"
)

# Phenotype data: one row per file, must match file order
pd <- data.frame(
  sample_name = c("ctrl_1", "ctrl_2", "treat_1", "treat_2"),
  sample_group = c("control", "control", "treatment", "treatment"),
  stringsAsFactors = FALSE
)

# Read data in on-disk mode (low memory usage)
raw_data <- readMSData(files = files, pdata = new("NAnnotatedDataFrame", pd),
                       mode = "onDisk")

# Quick inspection
raw_data
table(msLevel(raw_data))           # number of scans per MS level
rtime(raw_data)[1:10]              # first 10 retention times (seconds)
```

**File requirements**: Input files MUST be centroided mzML. CentWave expects centroid data — profile-mode files will produce garbage peaks or errors. Convert vendor raw files with msconvert (ProteoWizard) using `--filter "peakPicking vendor msLevel=1-"`. File paths must be absolute.

**On-disk mode**: `mode = "onDisk"` keeps spectra on disk and loads peaks on demand. This is essential for large datasets (dozens to hundreds of files). Never use `mode = "inMemory"` for production metabolomics workflows.

## Step 2: Peak Detection (CentWave)

### CentWaveParam Parameters

| Parameter | Description | Orbitrap | QTOF | Triple Quad |
|-----------|-------------|----------|------|-------------|
| `ppm` | Max allowed m/z deviation (ppm) between scans of one peak | 5 | 15 | 25 |
| `peakwidth` | Expected peak width range in seconds `c(min, max)` | `c(5, 20)` | `c(5, 30)` | `c(5, 30)` |
| `snthresh` | Signal-to-noise ratio threshold | 10 | 6 | 3 |
| `prefilter` | `c(k, I)` — require at least `k` scans with intensity >= `I` | `c(3, 5000)` | `c(3, 1000)` | `c(3, 500)` |
| `mzdiff` | Min m/z difference for two peaks to be separate | 0.001 | 0.01 | 0.05 |
| `noise` | Intensity threshold below which signals are ignored | 1000 | 500 | 100 |
| `integrate` | Integration method: 1 = Mexican hat, 2 = real data descent | 1 | 1 | 2 |

### Apply Peak Detection

```r
# Configure CentWave for Orbitrap data
cwp <- CentWaveParam(
  ppm = 5,
  peakwidth = c(5, 20),
  snthresh = 10,
  prefilter = c(3, 5000),
  mzdiff = 0.001,
  noise = 1000,
  integrate = 1L
)

# Run peak detection across all samples
xdata <- findChromPeaks(raw_data, param = cwp)

# Inspect results
head(chromPeaks(xdata))
# Returns a matrix: each row is a detected peak
# Columns: mz, mzmin, mzmax, rt, rtmin, rtmax, into (integrated intensity),
#           maxo (max intensity), sn (signal-to-noise), sample (sample index)

nrow(chromPeaks(xdata))                         # total peaks detected
table(chromPeaks(xdata)[, "sample"])             # peaks per sample
summary(chromPeaks(xdata)[, "into"])             # intensity distribution
```

### Parameter Tuning Tips

- Start with the instrument-appropriate defaults from the table above.
- If too few peaks: lower `snthresh` and `noise`, widen `peakwidth` range.
- If too many noise peaks: raise `snthresh`, tighten `prefilter`, increase `noise`.
- `ppm` should match your instrument's mass accuracy specification.
- `peakwidth` depends on chromatographic method (HILIC peaks are wider than RP-C18).
- Use `integrate = 2L` for noisy data or when peaks have poor shape — it follows the raw signal more closely.

## Step 3: Retention Time Alignment

### Option A: ObiwarpParam (Sample-Wise Warping)

Warps each sample's RT axis to a reference sample using dynamic time warping on the full m/z-RT profile. Best for datasets with significant RT drift.

```r
owp <- ObiwarpParam(
  binSize = 0.6,        # m/z bin size for profile matrix (Da)
  response = 1,         # response factor (0-100, higher = more correction)
  distFun = "cor_opt",  # distance function: "cor", "cor_opt", "cov", "euc"
  gapInit = 0.3,        # penalty for opening a gap
  gapExtend = 2.4       # penalty for extending a gap
)

xdata <- adjustRtime(xdata, param = owp)
```

### Option B: PeakGroupsParam (Landmark-Based Alignment)

Uses well-behaved peaks present in most samples as landmarks for RT correction. Lighter-weight and works well when RT drift is moderate.

```r
pgp <- PeakGroupsParam(
  minFraction = 0.9,    # min fraction of samples a peak must appear in to be a landmark
  span = 0.4,           # smoothing for LOESS RT correction curve
  smooth = "loess"      # smoothing method: "loess" or "linear"
)

xdata <- adjustRtime(xdata, param = pgp)
```

### Inspect Alignment

```r
# Check if retention times were adjusted
hasAdjustedRtime(xdata)   # TRUE after alignment

# Plot RT correction: shows raw vs adjusted RT per sample
plotAdjustedRtime(xdata)
```

**Do NOT re-run findChromPeaks after adjustRtime.** After alignment, peak positions (rt, rtmin, rtmax) in the `chromPeaks` matrix are automatically updated to adjusted retention times. Re-running peak detection would use the adjusted RTs as if they were raw, producing incorrect results.

## Step 4: Correspondence (Peak Grouping)

Groups peaks across samples into consensus features. Each feature represents the same chemical entity detected across multiple samples.

```r
pdp <- PeakDensityParam(
  sampleGroups = pd$sample_group,  # MUST match sample order in the data object
  bw = 5,                          # RT bandwidth for grouping (seconds)
  minFraction = 0.5,               # min fraction of samples in at least one group
  minSamples = 1,                  # min number of samples a peak must appear in
  binSize = 0.025                  # m/z bin size for grouping (Da)
)

xdata <- groupChromPeaks(xdata, param = pdp)

# Inspect features
featureDefinitions(xdata)
# Returns a DataFrame: mzmed, mzmin, mzmax, rtmed, rtmin, rtmax, npeaks,
#                       peakidx (indices into chromPeaks matrix)

nrow(featureDefinitions(xdata))    # number of consensus features
```

**sampleGroups is required.** `PeakDensityParam` uses sample groups to compute `minFraction` within each group. The vector must have one element per sample and match the sample order in the data object. Using incorrect group assignments will cause features to be dropped or incorrectly grouped.

### Tuning Correspondence

- `bw` should approximate the remaining RT variability after alignment. Start with 5 seconds; reduce to 2-3 if alignment was excellent.
- `minFraction = 0.5` means a feature must appear in at least 50% of samples in at least one group. Lower this for rare features; raise for stricter filtering.
- `binSize = 0.025` works for high-resolution data. Increase to 0.05-0.1 for lower resolution.

## Step 5: Gap Filling

Fills in missing peak integrations for features where a peak was not originally detected in some samples. Integrates the raw signal in the expected m/z-RT region.

```r
fcp <- FillChromPeaksParam(
  expandMz = 0,     # expand m/z range for integration (0 = use feature m/z range)
  expandRt = 0,     # expand RT range for integration (0 = use feature RT range)
  ppm = 10          # m/z expansion in ppm (alternative to expandMz)
)

xdata <- fillChromPeaks(xdata, param = fcp)

# Check fill statistics
# Filled peaks are flagged in chromPeaks with is_filled = TRUE
sum(chromPeakData(xdata)$is_filled)        # number of filled peaks
```

Gap filling reduces the number of missing values (NA/zero) in the final feature matrix. This is critical because many downstream statistical methods cannot handle missing data or treat zeros as meaningful.

## Step 6: Extract Feature Matrix

```r
# Extract integrated intensities (area under the curve)
intensity_matrix <- featureValues(xdata, value = "into")
# Returns a matrix: rows = features, columns = samples
# "into" = integrated peak area; alternatives: "maxo" (max intensity), "intb" (baseline-corrected)

dim(intensity_matrix)                  # features x samples
head(intensity_matrix[, 1:4])

# Get feature definitions (m/z and RT for each feature)
feat_defs <- featureDefinitions(xdata)

# Build a clean feature table with descriptive row names
feat_ids <- paste0("M", round(feat_defs$mzmed, 4), "T", round(feat_defs$rtmed, 1))
rownames(intensity_matrix) <- feat_ids

# Transpose so rows = samples, columns = features (standard layout for statistics)
feature_table <- t(intensity_matrix)

# Convert to data frame
feature_df <- as.data.frame(feature_table)
feature_df$sample_name <- pd$sample_name
feature_df$sample_group <- pd$sample_group
```

**featureValues replaces the older groupval function.** If working with legacy code that calls `groupval()`, replace it with `featureValues(value = "into")`.

### Feature Definitions Table

```r
# Build metadata table for all features
feat_meta <- data.frame(
  feature_id = feat_ids,
  mz = feat_defs$mzmed,
  mzmin = feat_defs$mzmin,
  mzmax = feat_defs$mzmax,
  rt = feat_defs$rtmed,
  rtmin = feat_defs$rtmin,
  rtmax = feat_defs$rtmax,
  npeaks = feat_defs$npeaks,
  stringsAsFactors = FALSE
)
```

## Complete Workflow Example

```r
library(xcms)
library(MSnbase)

# --- 1. Read data ---
files <- c(
  "/data/inputs/ctrl_1.mzML",
  "/data/inputs/ctrl_2.mzML",
  "/data/inputs/ctrl_3.mzML",
  "/data/inputs/treat_1.mzML",
  "/data/inputs/treat_2.mzML",
  "/data/inputs/treat_3.mzML"
)

pd <- data.frame(
  sample_name = c("ctrl_1", "ctrl_2", "ctrl_3", "treat_1", "treat_2", "treat_3"),
  sample_group = c("control", "control", "control", "treatment", "treatment", "treatment"),
  stringsAsFactors = FALSE
)

raw_data <- readMSData(files = files, pdata = new("NAnnotatedDataFrame", pd),
                       mode = "onDisk")

# --- 2. Peak detection (CentWave, Orbitrap settings) ---
cwp <- CentWaveParam(
  ppm = 5,
  peakwidth = c(5, 20),
  snthresh = 10,
  prefilter = c(3, 5000),
  mzdiff = 0.001,
  noise = 1000,
  integrate = 1L
)
xdata <- findChromPeaks(raw_data, param = cwp)

cat("Detected", nrow(chromPeaks(xdata)), "peaks across", length(files), "samples\n")

# --- 3. RT alignment (Obiwarp) ---
owp <- ObiwarpParam(binSize = 0.6, response = 1, distFun = "cor_opt",
                    gapInit = 0.3, gapExtend = 2.4)
xdata <- adjustRtime(xdata, param = owp)

# --- 4. Correspondence (PeakDensity) ---
pdp <- PeakDensityParam(
  sampleGroups = pd$sample_group,
  bw = 5,
  minFraction = 0.5,
  minSamples = 1,
  binSize = 0.025
)
xdata <- groupChromPeaks(xdata, param = pdp)

cat("Grouped into", nrow(featureDefinitions(xdata)), "features\n")

# --- 5. Gap filling ---
fcp <- FillChromPeaksParam(expandMz = 0, expandRt = 0, ppm = 10)
xdata <- fillChromPeaks(xdata, param = fcp)

# --- 6. Extract feature matrix ---
intensity_matrix <- featureValues(xdata, value = "into")
feat_defs <- featureDefinitions(xdata)

feat_ids <- paste0("M", round(feat_defs$mzmed, 4), "T", round(feat_defs$rtmed, 1))
rownames(intensity_matrix) <- feat_ids

# Transpose: rows = samples, columns = features
feature_table <- as.data.frame(t(intensity_matrix))
feature_table$sample_name <- pd$sample_name
feature_table$sample_group <- pd$sample_group

# Feature metadata
feat_meta <- data.frame(
  feature_id = feat_ids,
  mz = feat_defs$mzmed,
  rt = feat_defs$rtmed,
  npeaks = feat_defs$npeaks,
  stringsAsFactors = FALSE
)

cat("Final matrix:", nrow(feature_table), "samples x",
    ncol(feature_table) - 2, "features\n")
cat("Missing values:", sum(is.na(intensity_matrix)), "/",
    length(intensity_matrix), "\n")
```

## Saving Results

```r
# Save intensity matrix (samples x features)
write.csv(feature_table, "output/feature_intensity_matrix.csv", row.names = FALSE)

# Save feature definitions (metadata per feature)
write.csv(feat_meta, "output/feature_definitions.csv", row.names = FALSE)

# Save the full xcms object for reproducibility (optional, can be large)
save(xdata, file = "output/xcms_result.RData")
```

## Version Notes

- **xcms >= 4.0** (Bioconductor 3.18+): Recommended. Uses `XcmsExperiment` class internally. The `XCMSnExp` class from xcms 3.x is still supported but deprecated for new code.
- **MSnbase**: Provides the `OnDiskMSnExp` data class used by `readMSData(mode = "onDisk")`. Required for the workflow above.
- **Spectra backend**: xcms 4.x can also work with `MsExperiment` + `Spectra` objects from the Spectra package. This is the forward-looking approach but the MSnbase workflow above remains fully functional.
- **featureValues()** replaces the older `groupval()` function from xcms 1.x/2.x. Legacy code should be updated.
- **readMSData()** is from MSnbase. In the Spectra-based workflow, use `readMsExperiment()` from the MsExperiment package instead.

## Gotchas

- **Files must be centroided mzML.** CentWave assumes centroid input. Profile-mode data will yield incorrect peak detection. Convert with msconvert: `--filter "peakPicking vendor msLevel=1-"`.
- **Do NOT re-run findChromPeaks after adjustRtime.** Alignment updates peak positions in place. Re-running peak detection on adjusted data double-corrects retention times.
- **sampleGroups must match sample order.** The vector passed to `PeakDensityParam(sampleGroups = ...)` must have one element per sample in the same order as the files used in `readMSData()`. Mismatched order silently produces wrong grouping.
- **featureValues replaces groupval.** The older `groupval()` function is deprecated. Use `featureValues(xdata, value = "into")`.
- **On-disk mode for large datasets.** Always use `mode = "onDisk"` in `readMSData()`. In-memory mode loads all spectra into RAM and will crash on datasets with more than ~20 files.
- **Retention times are in seconds.** All xcms RT values (rt, rtmin, rtmax, peakwidth) are in seconds, not minutes. Divide by 60 for display if needed.
- **NAs in the feature matrix.** Before gap filling, `featureValues()` returns `NA` for samples where a peak was not detected. After `fillChromPeaks()`, most NAs are replaced with integrated values — but some may remain if the raw signal region is empty.
- **Peak integration values.** `"into"` = integrated area under the curve (most commonly used). `"maxo"` = apex intensity. `"intb"` = baseline-corrected integrated area. Use `"into"` unless you have a specific reason for alternatives.
- **ppm is relative, not absolute.** `CentWaveParam(ppm = 5)` means 5 parts per million. For a peak at m/z 500, this allows a 0.0025 Da deviation. Do not confuse with absolute Da tolerance.
