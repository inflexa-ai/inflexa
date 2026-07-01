# pymzml -- Lightweight mzML Parser

Python module for high-throughput parsing of mzML mass spectrometry files. Minimal dependencies (numpy, regex). Provides fast iteration over spectra with random access support. Lightweight alternative to pyteomics when only mzML reading is needed.

## Reading mzML Files

### Basic Iteration

```python
import pymzml

run = pymzml.run.Reader("experiment.mzML")

for spectrum in run:
    # spectrum.ID -> native spectrum ID (int or string)
    # spectrum.ms_level -> MS level (1, 2, etc.)
    # spectrum.scan_time_in_minutes() -> retention time in minutes

    if spectrum.ms_level == 1:
        print(f"MS1 scan {spectrum.ID} at RT={spectrum.scan_time_in_minutes():.2f} min")
        print(f"  Peaks: {len(spectrum.mz)} m/z values")

    elif spectrum.ms_level == 2:
        precursor = spectrum.selected_precursors
        if precursor:
            prec_mz = precursor[0].get("mz", None)
            prec_charge = precursor[0].get("charge", None)
            print(f"MS2 scan {spectrum.ID}: precursor m/z={prec_mz}")
```

### Reader Parameters

```python
run = pymzml.run.Reader(
    "experiment.mzML",
    MS_precisions={                # override m/z precision per MS level
        1: 5e-6,                   # MS1: 5 ppm
        2: 20e-6,                  # MS2: 20 ppm
    },
    obo_version="4.1.33",         # controlled vocabulary version (optional)
    skip_chromatogram=False,       # set True to skip chromatogram entries
)
```

**Gotcha**: `pymzml.run.Reader` accepts file paths or file-like objects. Gzipped `.mzML.gz` files are supported natively.

### Random Access by Spectrum ID

```python
run = pymzml.run.Reader("experiment.mzML")

# Access specific spectrum by native ID
spectrum = run[2540]
print(f"Spectrum {spectrum.ID}: {len(spectrum.mz)} peaks")

# Access chromatogram by ID
tic = run["TIC"]                    # total ion chromatogram
# For MRM: run["transition_445-672"]
```

## Accessing Peak Data

```python
spectrum = run[100]

# m/z and intensity as numpy arrays
mz_array = spectrum.mz                 # numpy.ndarray of m/z values
intensity_array = spectrum.i           # numpy.ndarray of intensities

# Peaks as list of (mz, intensity) tuples
for mz, intensity in spectrum.peaks("raw"):
    if intensity > 1000:
        print(f"  m/z={mz:.4f}, I={intensity:.0f}")

# Centroided peaks (if data is profile mode)
centroided = spectrum.peaks("centroided")

# Highest intensity peaks
top_peaks = spectrum.highest_peaks(n=10)  # list of (mz, intensity)
```

### Peak Filtering

```python
# Filter by m/z range
spectrum.reduce(mz_range=(200.0, 800.0))

# Filter by intensity threshold
mz = spectrum.mz
intensity = spectrum.i
mask = intensity > 500
filtered_mz = mz[mask]
filtered_int = intensity[mask]
```

## TIC and BPC Extraction

### Total Ion Chromatogram (TIC)

```python
import numpy as np

run = pymzml.run.Reader("experiment.mzML")

tic_rt = []
tic_intensity = []

for spectrum in run:
    if spectrum.ms_level == 1:
        rt = spectrum.scan_time_in_minutes()
        total_intensity = np.sum(spectrum.i) if len(spectrum.i) > 0 else 0
        tic_rt.append(rt)
        tic_intensity.append(total_intensity)

# Or use the TIC property if stored in the file
try:
    tic_chrom = run["TIC"]
    tic_rt = tic_chrom.time
    tic_intensity = tic_chrom.i
except KeyError:
    pass  # TIC chromatogram not stored in file; use manual extraction above
```

### Base Peak Chromatogram (BPC)

```python
run = pymzml.run.Reader("experiment.mzML")

bpc_rt = []
bpc_intensity = []
bpc_mz = []

for spectrum in run:
    if spectrum.ms_level == 1:
        rt = spectrum.scan_time_in_minutes()
        if len(spectrum.i) > 0:
            max_idx = np.argmax(spectrum.i)
            bpc_rt.append(rt)
            bpc_intensity.append(spectrum.i[max_idx])
            bpc_mz.append(spectrum.mz[max_idx])

import pandas as pd
bpc_df = pd.DataFrame({"rt_min": bpc_rt, "base_peak_mz": bpc_mz,
                        "base_peak_intensity": bpc_intensity})
```

## Extracted Ion Chromatogram (EIC/XIC)

```python
def extract_eic(mzml_path, target_mz, tolerance_da=0.01, ms_level=1):
    """Extract ion chromatogram for a target m/z."""
    run = pymzml.run.Reader(mzml_path)
    rt_values = []
    intensity_values = []

    for spectrum in run:
        if spectrum.ms_level == ms_level:
            rt = spectrum.scan_time_in_minutes()
            mz = spectrum.mz
            intensities = spectrum.i

            # Find peaks within tolerance
            mask = np.abs(mz - target_mz) <= tolerance_da
            if np.any(mask):
                intensity_values.append(np.max(intensities[mask]))
            else:
                intensity_values.append(0.0)
            rt_values.append(rt)

    return np.array(rt_values), np.array(intensity_values)

rt, eic = extract_eic("experiment.mzML", target_mz=180.0634, tolerance_da=0.01)
```

## Spectrum Metadata

```python
spectrum = run[100]

# Common metadata access
ms_level = spectrum.ms_level                    # int: 1, 2, ...
scan_time = spectrum.scan_time_in_minutes()     # float: RT in minutes
tic_value = spectrum.TIC                        # total ion current (if available)
scan_window = spectrum.scan_window              # (mz_low, mz_high) or None

# Precursor info (MS2+)
precursors = spectrum.selected_precursors       # list of dicts
# Each dict may have: "mz", "charge", "i" (intensity)

# ID
native_id = spectrum.ID                         # spectrum native ID
index = spectrum.index                          # 0-based index
```

## Writing mzML (Optional)

```python
# pymzml can write mzML files (e.g., after filtering)
run = pymzml.run.Reader("input.mzML")
writer = pymzml.run.Writer(filename="filtered.mzML", run=run)

for spectrum in run:
    if spectrum.ms_level == 1:
        writer.addSpec(spectrum)

writer.close()
```

## Building a Feature Summary Table

```python
import pymzml
import numpy as np
import pandas as pd

run = pymzml.run.Reader("experiment.mzML")

records = []
for spectrum in run:
    if spectrum.ms_level == 1 and len(spectrum.mz) > 0:
        records.append({
            "scan_id": spectrum.ID,
            "rt_min": spectrum.scan_time_in_minutes(),
            "n_peaks": len(spectrum.mz),
            "tic": float(np.sum(spectrum.i)),
            "base_peak_mz": float(spectrum.mz[np.argmax(spectrum.i)]),
            "base_peak_int": float(np.max(spectrum.i)),
            "mz_range_low": float(np.min(spectrum.mz)),
            "mz_range_high": float(np.max(spectrum.mz)),
        })

summary = pd.DataFrame(records)
summary.to_csv("output/scan_summary.csv", index=False)
```

## Gotchas and Notes

- **Memory**: pymzml streams spectra from disk. Memory usage stays low even for multi-GB files.
- **Spectrum.mz / .i**: These are properties, not methods. They return numpy arrays. An empty spectrum returns empty arrays.
- **scan_time_in_minutes()**: This is a method (note the parentheses). Returns `None` if scan time is not recorded.
- **selected_precursors**: Returns a list of dicts. May be empty for MS1 spectra. Always check length before accessing.
- **Index vs ID**: `spectrum.index` is the 0-based sequential index; `spectrum.ID` is the native ID string/int from the file. Use `run[ID]` for random access.
- **Thread safety**: Reader objects are NOT thread-safe. Create separate instances per thread.
- **Version**: pymzml 2.5+ supports mzML 1.1.1. The `run.Writer` API is stable since 2.4.
- **vs. pyteomics**: pymzml is faster for pure mzML iteration. pyteomics supports more formats (mzXML, pepXML, protXML) and provides mass calculation utilities. Choose pymzml when you only need mzML reading.
