# matchms -- Mass Spectral Similarity Scoring

Python library for importing, processing, and comparing tandem mass spectrometry (MS/MS) data. Supports spectral matching against reference libraries, similarity scoring, and preprocessing pipelines.

## Importing Spectra

### From MGF Files

```python
from matchms.importing import load_from_mgf

spectra = list(load_from_mgf("spectra.mgf"))
# Returns list of matchms.Spectrum objects

print(f"Loaded {len(spectra)} spectra")
print(spectra[0].metadata)       # dict of metadata fields
print(spectra[0].peaks.mz)       # numpy array of m/z values
print(spectra[0].peaks.intensities)  # numpy array of intensities
```

### From mzML Files

```python
from matchms.importing import load_from_mzml

# Loads MS2 spectra from mzML
spectra = list(load_from_mzml("experiment.mzML"))
```

### From MSP Files

```python
from matchms.importing import load_from_msp

# `library_msp_path` is a path you resolved — see Spectral Library Matching Workflow.
spectra = list(load_from_msp(library_msp_path))
```

### From JSON (matchms Format)

```python
from matchms.importing import load_from_json
from matchms.exporting import save_as_json

# Save/load in matchms native JSON format
save_as_json(spectra, "spectra.json")
spectra = list(load_from_json("spectra.json"))
```

## Spectrum Objects

```python
from matchms import Spectrum
import numpy as np

# Create a spectrum manually
spectrum = Spectrum(
    mz=np.array([100.0, 150.0, 200.05, 250.1], dtype="float"),
    intensities=np.array([10, 50, 100, 30], dtype="float"),
    metadata={
        "precursor_mz": 300.15,
        "charge": 1,
        "compound_name": "Example Compound",
        "smiles": "C1=CC=CC=C1",
        "inchi": "InChI=1S/C6H6/c1-2-4-6-5-3-1/h1-6H",
        "retention_time": 5.23,
    },
)

# Access properties
print(spectrum.peaks.mz)              # m/z array
print(spectrum.peaks.intensities)     # intensity array
print(spectrum.get("precursor_mz"))   # metadata value (returns None if missing)
print(spectrum.metadata)              # full metadata dict
```

## Spectrum Filtering / Preprocessing

matchms provides individual filter functions and a pipeline processor.

### Individual Filters

```python
from matchms.filtering import (
    default_filters,
    normalize_intensities,
    select_by_mz,
    select_by_relative_intensity,
    reduce_to_number_of_peaks,
    add_precursor_mz,
    add_parent_mass,
    require_precursor_mz,
    require_minimum_number_of_peaks,
)

# Apply filters sequentially (each returns a new Spectrum or None)
spectrum = default_filters(spectrum)       # standardize metadata keys, fix formats
spectrum = normalize_intensities(spectrum) # scale intensities to max=1.0
spectrum = select_by_mz(spectrum, mz_from=10.0, mz_to=1000.0)  # m/z range filter
spectrum = select_by_relative_intensity(spectrum, intensity_from=0.01)  # min relative intensity
spectrum = reduce_to_number_of_peaks(spectrum, n_max=100)  # keep top N peaks
spectrum = require_precursor_mz(spectrum)  # returns None if no precursor_mz
spectrum = require_minimum_number_of_peaks(spectrum, n_required=5)  # None if < 5 peaks
```

**Gotcha**: Filters return `None` when a spectrum fails a requirement. Always check for `None` when applying filters that can reject spectra.

### Pipeline Processing

```python
from matchms.filtering import SpectrumProcessor

processor = SpectrumProcessor(
    filters=[
        "default_filters",
        "normalize_intensities",
        ("select_by_mz", {"mz_from": 10.0, "mz_to": 1000.0}),
        ("select_by_relative_intensity", {"intensity_from": 0.01}),
        ("reduce_to_number_of_peaks", {"n_max": 200}),
        ("require_minimum_number_of_peaks", {"n_required": 5}),
    ]
)

# Process all spectra, filtering out None results
processed = [processor.process_spectrum(s) for s in spectra]
processed = [s for s in processed if s is not None]
```

### Applying Filters to a Collection

```python
from matchms import filtering as msfilters

def clean_spectrum(s):
    """Standard preprocessing pipeline."""
    s = msfilters.default_filters(s)
    s = msfilters.add_parent_mass(s)
    s = msfilters.normalize_intensities(s)
    s = msfilters.select_by_mz(s, mz_from=10, mz_to=1000)
    s = msfilters.select_by_relative_intensity(s, intensity_from=0.01)
    s = msfilters.reduce_to_number_of_peaks(s, n_max=200, ratio_desired=0.5)
    s = msfilters.require_minimum_number_of_peaks(s, n_required=5)
    return s

spectra_clean = [clean_spectrum(s) for s in spectra]
spectra_clean = [s for s in spectra_clean if s is not None]
```

## Similarity Scoring

### Available Similarity Measures

| Class | Description | Key Parameters |
|-------|-------------|----------------|
| `CosineGreedy` | Fast cosine similarity (greedy matching) | `tolerance`, `mz_power`, `intensity_power` |
| `CosineHungarian` | Optimal cosine similarity (Hungarian algorithm) | `tolerance`, `mz_power`, `intensity_power` |
| `ModifiedCosine` | Accounts for precursor m/z shift | `tolerance`, `mz_power`, `intensity_power` |
| `FingerprintSimilarity` | Molecular fingerprint-based | `similarity_measure` |
| `MetadataMatch` | Compare metadata fields | `field`, `match_type` |

### Pairwise Comparison

```python
from matchms.similarity import CosineGreedy, CosineHungarian, ModifiedCosine

cosine_greedy = CosineGreedy(tolerance=0.005, mz_power=0.0, intensity_power=1.0)

# Compare two spectra
score = cosine_greedy.pair(reference_spectrum, query_spectrum)
print(f"Score: {score.score:.4f}, Matched peaks: {score.matches}")
# score.score -> float (0 to 1)
# score.matches -> int (number of matched peak pairs)
```

### Matrix Scoring (All-vs-All or References-vs-Queries)

```python
from matchms import calculate_scores

# Calculate all pairwise scores between references and queries
scores = calculate_scores(
    references=library_spectra,     # list of Spectrum
    queries=query_spectra,          # list of Spectrum
    similarity_function=CosineGreedy(tolerance=0.005),
    is_symmetric=False,             # True if references == queries
)

# Access results
scores_array = scores.scores                 # sparse or dense array
best_matches = scores.scores_by_query(query_spectra[0], sort=True)

# Iterate over high-scoring matches
for (reference, query, score) in scores:
    if score["score"] > 0.7 and score["matches"] >= 6:
        ref_name = reference.get("compound_name")
        query_id = query.get("spectrum_id")
        print(f"{query_id} matches {ref_name}: {score['score']:.3f}")
```

### Modified Cosine (Neutral Loss Matching)

Accounts for the mass difference between precursor ions, enabling matching even when spectra are from different adducts or charge states.

```python
mod_cosine = ModifiedCosine(tolerance=0.005)

score = mod_cosine.pair(reference, query)
# Matches peaks considering the precursor mass shift
# Requires both spectra to have "precursor_mz" in metadata
```

**Gotcha**: `ModifiedCosine` requires valid `precursor_mz` metadata on both spectra. Apply `require_precursor_mz` filter first.

## Spectral Library Matching Workflow

**Resolve the reference library before you write this script, and check it exists.** An experimental MS/MS library is in the reference inventory, but as an opt-in download rather than part of a default install — so it is resolvable and may not be staged. Ask for it by what it is, never by a path or filename: reference data is provisioned per-environment, so the directory and the filename vary and neither is yours to assume. Read the resolved entry's stated contents before filtering — it says which records are true fragmentation spectra and which ionisation modes are covered, and both of those filters have to be applied before matching means anything.

If no library is available, **report that plainly and stop the annotation step there** — hand back the preprocessed query spectra and the feature table with m/z, RT, and adduct/isotope annotation, which are complete and useful without compound identifications. Do not invent a library path, do not substitute an unrelated spectrum collection, and do not silently skip matching and present formula guesses as identifications.

```python
from matchms.importing import load_from_mgf, load_from_msp
from matchms.filtering import default_filters, normalize_intensities, \
    select_by_mz, reduce_to_number_of_peaks, require_minimum_number_of_peaks
from matchms.similarity import ModifiedCosine
from matchms import calculate_scores

# 1. Load library and query spectra.
# `library_msp_path` is the absolute path you resolved for the reference library
# (see the note above); `unknown_features.mgf` is a file you produced this step.
library = list(load_from_msp(library_msp_path))
queries = list(load_from_mgf("unknown_features.mgf"))

# 2. Preprocess both sets
def preprocess(s):
    s = default_filters(s)
    s = normalize_intensities(s)
    s = select_by_mz(s, mz_from=10, mz_to=1000)
    s = reduce_to_number_of_peaks(s, n_max=200, ratio_desired=0.5)
    s = require_minimum_number_of_peaks(s, n_required=5)
    return s

library = [s for s in (preprocess(s) for s in library) if s is not None]
queries = [s for s in (preprocess(s) for s in queries) if s is not None]

# 3. Score
scores = calculate_scores(library, queries, ModifiedCosine(tolerance=0.01))

# 4. Extract best matches per query
results = []
for i, query in enumerate(queries):
    matches = scores.scores_by_query(query, name="ModifiedCosine_score", sort=True)
    for ref, score_tuple in matches[:5]:  # top 5
        if score_tuple["score"] > 0.6 and score_tuple["matches"] >= 4:
            results.append({
                "query_idx": i,
                "query_precursor_mz": query.get("precursor_mz"),
                "match_name": ref.get("compound_name"),
                "score": score_tuple["score"],
                "matched_peaks": score_tuple["matches"],
            })

import pandas as pd
matches_df = pd.DataFrame(results)
matches_df.to_csv("output/spectral_matches.csv", index=False)
```

## Version Notes

- matchms >= 0.18: `SpectrumProcessor` class for pipeline-style filtering.
- matchms >= 0.24: `Scores` object uses sparse storage by default for large comparisons.
- `CosineGreedy` is faster but may miss the optimal peak assignment in complex spectra. Use `CosineHungarian` for publication-quality results.
- `mz_power=0.0, intensity_power=1.0` weights matching by intensity only (recommended for metabolomics). Default `mz_power=0.0, intensity_power=1.0`.
- `tolerance` is in Da (absolute). For high-resolution data, use 0.005 Da; for unit-resolution, use 0.5 Da.
