# pyteomics -- Python Proteomics Toolkit

Lightweight Python library for common proteomics data analysis tasks: reading mass spectrometry formats (mzML, mzXML, pepXML, protXML), mass calculations, and peptide/protein sequence manipulation.

## Reading mzML Files

`pyteomics.mzml.MzML(source)` returns an indexed iterator over spectra. Each spectrum is a dict with m/z arrays, intensity arrays, and metadata.

```python
from pyteomics import mzml

# Basic iteration
with mzml.MzML("experiment.mzML") as reader:
    for spectrum in reader:
        ms_level = spectrum["ms level"]
        rt = spectrum["scanList"]["scan"][0]["scan start time"]

        if ms_level == 1:
            mz_array = spectrum["m/z array"]           # numpy array
            intensity_array = spectrum["intensity array"]  # numpy array
            print(f"MS1 scan at RT={rt:.2f}: {len(mz_array)} peaks")

        elif ms_level == 2:
            precursor = spectrum["precursorList"]["precursor"][0]
            selected_ion = precursor["selectedIonList"]["selectedIon"][0]
            precursor_mz = selected_ion["selected ion m/z"]
            print(f"MS2 scan: precursor m/z={precursor_mz:.4f}")
```

### Indexed Access

```python
# Random access by spectrum index (requires use_index=True, default for MzML class)
with mzml.MzML("experiment.mzML") as reader:
    # Access by native ID
    spectrum = reader["controllerType=0 controllerNumber=1 scan=1500"]

    # Access by index number
    spectrum = reader[100]

    # Get total number of spectra
    n_spectra = len(reader)
```

### read() Function (Non-Indexed)

```python
# Functional interface -- iterative parsing, lower memory
for spectrum in mzml.read("experiment.mzML", iterative=True):
    pass

# Disable binary decoding for metadata-only scans
for spectrum in mzml.read("experiment.mzML", decode_binary=False):
    scan_time = spectrum["scanList"]["scan"][0]["scan start time"]
```

**Key parameters for `mzml.read()` and `MzML()`**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `source` | -- | File path or file object |
| `iterative` | `True` | Iterative parsing (lower memory) |
| `use_index` | `False` (`read`) / `True` (`MzML`) | Build byte offset index for random access |
| `decode_binary` | `True` | Decode binary arrays (m/z, intensity) |
| `dtype` | `None` | Override dtype for arrays (e.g., `float32`) |
| `huge_tree` | `False` | Disable XML security limits for large files |

## Reading mzXML Files

```python
from pyteomics import mzxml

with mzxml.MzXML("experiment.mzXML") as reader:
    for spectrum in reader:
        ms_level = spectrum["msLevel"]
        rt = spectrum["retentionTime"]          # in seconds
        mz = spectrum["m/z array"]
        intensity = spectrum["intensity array"]

        if "precursorMz" in spectrum:
            prec_mz = spectrum["precursorMz"][0]["precursorMz"]
```

**Gotcha**: mzXML uses `"msLevel"` (camelCase), while mzML uses `"ms level"` (space-separated). Retention time key names also differ.

## Parsing pepXML (Peptide-Spectrum Matches)

```python
from pyteomics import pepxml

for psm in pepxml.read("search_results.pep.xml"):
    spectrum_id = psm["spectrum"]
    assumed_charge = psm["assumed_charge"]

    for hit in psm.get("search_hit", []):
        peptide = hit["peptide"]
        protein = hit["proteins"][0]["protein"]
        num_matched = hit["num_matched_ions"]
        scores = hit["search_score"]            # dict of score name -> value

        # Common scores (engine-dependent)
        xcorr = scores.get("xcorr", None)
        deltacn = scores.get("deltacn", None)
        expect = scores.get("expect", None)

        print(f"{peptide} -> {protein} (expect={expect})")
```

### PepXML with PeptideProphet Probabilities

```python
for psm in pepxml.read("interact.pep.xml"):
    for hit in psm.get("search_hit", []):
        analysis = hit.get("analysis_result", [])
        for result in analysis:
            if result.get("analysis") == "peptideprophet":
                prob = result["peptideprophet_result"]["probability"]
```

## Parsing protXML (Protein Inference)

```python
from pyteomics import protxml

for protein_group in protxml.read("interact.prot.xml"):
    group_prob = protein_group.get("probability", 0)

    for protein in protein_group.get("protein", []):
        protein_name = protein["protein_name"]
        coverage = protein.get("percent_coverage", 0)
        n_peptides = protein.get("total_number_peptides", 0)
        prob = protein.get("probability", 0)

        peptides = protein.get("peptide", [])
        for pep in peptides:
            seq = pep["peptide_sequence"]
            is_unique = pep.get("is_nondegenerate_evidence") == "Y"
```

## Mass Calculation Utilities

```python
from pyteomics import mass, parser

# Monoisotopic mass of a peptide
peptide = "ACDEFGHIK"
mono_mass = mass.calculate_mass(sequence=peptide, type="M")  # neutral mass
mz_2plus = mass.calculate_mass(sequence=peptide, type="M", charge=2)  # m/z at z=2

# With modifications (using Unimod names)
mod_mass = mass.calculate_mass(
    parsed_sequence=[("A", ), ("C", "Carbamidomethyl"), ("D", ), ("E", )],
    type="M"
)

# Mass from formula
water_mass = mass.calculate_mass(formula="H2O")

# Fast mass calculation from composition
comp = mass.Composition(sequence="PEPTIDE")
neutral_mass = comp.mass()

# Theoretical isotope distribution (mass is already imported above)
isotope_dist = mass.isotopic_composition_abundance(
    formula="C50H71N13O12"
)
```

### Peptide Sequence Parsing

```python
from pyteomics import parser

# Cleave a protein sequence in silico
protein_seq = "MKWVTFISLLFLFSSAYSRGVFRRDAHKSEVAHRFKDLGEENFK..."
peptides = parser.cleave(protein_seq, "trypsin", missed_cleavages=2)

# Available enzymes
enzymes = parser.expasy_rules  # dict of enzyme name -> regex

# Count amino acids
aa_count = parser.amino_acid_composition("ACDEFGHIK")
```

## Building a Feature Table from mzML

```python
import pandas as pd
from pyteomics import mzml
import numpy as np

records = []
with mzml.MzML("experiment.mzML") as reader:
    for spec in reader:
        if spec["ms level"] == 1:
            scan_time = spec["scanList"]["scan"][0]["scan start time"]
            mz = spec["m/z array"]
            intensity = spec["intensity array"]

            # Basic peak picking: top N peaks
            top_idx = np.argsort(intensity)[-100:]
            for i in top_idx:
                records.append({
                    "rt": scan_time,
                    "mz": mz[i],
                    "intensity": intensity[i],
                })

feature_table = pd.DataFrame(records)
```

## Gotchas and Notes

- **Memory**: For large mzML files (>1GB), use `iterative=True` and avoid `use_index=True` to reduce memory.
- **Namespace keys**: mzML spectrum dict keys use controlled vocabulary terms (e.g., `"ms level"`, `"total ion current"`). Use `spectrum.keys()` to discover available fields.
- **Binary precision**: Default decoding matches the precision in the file (32-bit or 64-bit). Override with `dtype` parameter.
- **Gzipped files**: pyteomics can read `.mzML.gz` files directly.
- **Thread safety**: File readers are NOT thread-safe. Use separate reader instances per thread.
- **Version**: pyteomics >= 4.6 supports mzML 1.1 and mzXML 3.2. The `MzML` class (capital M) provides indexed access; the `read()` function is a simpler iterator.
