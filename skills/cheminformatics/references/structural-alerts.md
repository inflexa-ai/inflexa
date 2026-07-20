# Structural Alerts API Reference

RDKit's FilterCatalog module for screening molecules against known problematic substructure patterns. Covers PAINS (pan-assay interference compounds), Brenk, NIH, and ZINC filter sets. Essential for compound triage in drug discovery and HTS hit validation.

## Core Imports

```python
from rdkit import Chem
from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
import pandas as pd
```

## Building a FilterCatalog

### Single Catalog (PAINS)

```python
params = FilterCatalogParams()
params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
catalog = FilterCatalog(params)
```

### Available Catalogs

| Catalog | Description | Filter Count |
|---------|-------------|-------------|
| `PAINS` | All PAINS filters (A + B + C combined) | ~480 |
| `PAINS_A` | PAINS class A (most likely to interfere) | ~16 |
| `PAINS_B` | PAINS class B (likely to interfere) | ~55 |
| `PAINS_C` | PAINS class C (possible interference) | ~409 |
| `BRENK` | Brenk structural alerts (reactive/toxic groups) | ~105 |
| `NIH` | NIH/MLPCN alerts (HTS artifacts) | ~90 |
| `ZINC` | ZINC filters (purchasable compound quality) | ~18 |

### Multiple Catalogs Combined

```python
params = FilterCatalogParams()
params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
params.AddCatalog(FilterCatalogParams.FilterCatalogs.BRENK)
params.AddCatalog(FilterCatalogParams.FilterCatalogs.NIH)
catalog = FilterCatalog(params)
```

## Checking a Single Molecule

```python
mol = Chem.MolFromSmiles("O=C1C=CC(=O)C=C1")  # benzoquinone (PAINS hit)

# Get first match (fastest -- stops at first hit)
entry = catalog.GetFirstMatch(mol)

if entry is not None:
    alert_name = entry.GetDescription()
    print(f"FLAGGED: {alert_name}")
else:
    print("CLEAN: no alerts")
```

### Getting All Matches

```python
# A molecule can match multiple alerts
entries = catalog.GetMatches(mol)

alerts = []
for entry in entries:
    alerts.append({
        "description": entry.GetDescription(),
        "filter_set": entry.GetProp("FilterSet") if entry.HasProp("FilterSet") else "unknown",
    })

print(f"Total alerts: {len(alerts)}")
for a in alerts:
    print(f"  - {a['description']} ({a['filter_set']})")
```

## Batch Screening

### Screen a List of Molecules

```python
def screen_alerts(smiles_list, catalog):
    """Screen molecules against a FilterCatalog.

    Returns DataFrame with SMILES, flagged status, and alert descriptions.
    """
    results = []
    for smi in smiles_list:
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            results.append({
                "SMILES": smi,
                "valid": False,
                "flagged": None,
                "alert": None,
                "n_alerts": None,
            })
            continue

        entries = catalog.GetMatches(mol)
        alert_descs = [e.GetDescription() for e in entries]

        results.append({
            "SMILES": smi,
            "valid": True,
            "flagged": len(alert_descs) > 0,
            "alert": "; ".join(alert_descs) if alert_descs else None,
            "n_alerts": len(alert_descs),
        })

    return pd.DataFrame(results)

# Usage
params = FilterCatalogParams()
params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
params.AddCatalog(FilterCatalogParams.FilterCatalogs.BRENK)
catalog = FilterCatalog(params)

df_alerts = screen_alerts(df["SMILES"].tolist(), catalog)

# Summary statistics
total = df_alerts["valid"].sum()
flagged = df_alerts["flagged"].sum()
clean_pct = (total - flagged) / total * 100
print(f"Clean: {clean_pct:.1f}% ({total - flagged}/{total})")
```

### Separate Screening per Catalog

```python
def screen_by_catalog(smiles_list):
    """Screen molecules against each catalog separately."""
    catalog_names = {
        "PAINS": FilterCatalogParams.FilterCatalogs.PAINS,
        "BRENK": FilterCatalogParams.FilterCatalogs.BRENK,
        "NIH": FilterCatalogParams.FilterCatalogs.NIH,
        "ZINC": FilterCatalogParams.FilterCatalogs.ZINC,
    }

    # Build each catalog ONCE -- construction compiles hundreds of SMARTS.
    catalogs = {}
    for name, cat_enum in catalog_names.items():
        params = FilterCatalogParams()
        params.AddCatalog(cat_enum)
        catalogs[name] = FilterCatalog(params)

    results = []
    for smi in smiles_list:
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            continue

        row = {"SMILES": smi}
        for name, cat in catalogs.items():
            entry = cat.GetFirstMatch(mol)
            row[f"{name}_flagged"] = entry is not None
            row[f"{name}_alert"] = entry.GetDescription() if entry else None
        results.append(row)

    return pd.DataFrame(results)

df_by_catalog = screen_by_catalog(df["SMILES"].tolist())
```

## Common PAINS Substructures

These substructure classes are frequently flagged. Knowing them helps interpret results.

| PAINS Class | Example Substructure | Mechanism |
|-------------|---------------------|-----------|
| Quinones | Benzoquinone, naphthoquinone | Redox cycling, thiol reactivity |
| Rhodanines | 2-thioxothiazolidin-4-one | Promiscuous binding, aggregation |
| Catechols | 1,2-dihydroxybenzene | Metal chelation, redox cycling |
| Curcuminoids | Diarylheptanoid scaffold | Assay interference, aggregation |
| Hydroxyphenyl hydrazones | ArOH-C=N-NH | Metal chelation |
| Alkylidene barbiturates | Knoevenagel products | Michael acceptor reactivity |

## False Positive Guidance

PAINS and structural alerts are heuristic screening tools, not definitive rejection criteria.

### When a Flag Does NOT Mean Rejection

- **Approved drugs contain PAINS substructures**: Some legitimate drugs contain flagged motifs (e.g., catechol in dopamine, quinone in doxorubicin). A PAINS flag on a known drug does not invalidate the drug.
- **Assay-dependent relevance**: PAINS were derived from analysis of HTS artifacts across multiple assay technologies. If your assay is orthogonal (e.g., cell-based phenotypic), some flags may not apply.
- **Context matters**: A rhodanine in a focused kinase library with confirmed crystal structure binding is different from a rhodanine in an unvalidated HTS hit.

### Best Practices for Reporting

```python
# DO: Report specific alert descriptions
print(f"Flagged: {entry.GetDescription()}")
# Output: "Flagged: quinone_A(370)"

# DON'T: Just say "PAINS hit"
# Bad: "This compound is a PAINS hit and should be excluded"

# DO: Report clean percentage with context
print(f"PAINS clean: {clean_pct:.1f}% ({n_clean}/{n_total})")
print(f"Most common alerts: {top_alerts}")

# DO: Flag for review, don't silently filter
df["pains_flag"] = df_alerts["alert"]
# Keep flagged compounds in dataset, mark them for manual review
```

### Decision Framework

1. **Flag** all structural alert matches in the output.
2. **Report** the specific alert description (not just "PAINS hit").
3. **Quantify** the clean percentage for the library.
4. **Do NOT silently remove** flagged compounds -- present them with their flags.
5. **Context note**: State that PAINS flags indicate potential assay interference and warrant experimental validation, not automatic exclusion.

## Complete Screening Workflow

```python
from rdkit import Chem
from rdkit.Chem.FilterCatalog import FilterCatalog, FilterCatalogParams
from rdkit.Chem import Descriptors
import pandas as pd

# Build combined catalog
params = FilterCatalogParams()
params.AddCatalog(FilterCatalogParams.FilterCatalogs.PAINS)
params.AddCatalog(FilterCatalogParams.FilterCatalogs.BRENK)
params.AddCatalog(FilterCatalogParams.FilterCatalogs.NIH)
catalog = FilterCatalog(params)

# Screen library
smiles_list = df["SMILES"].tolist()
df_results = screen_alerts(smiles_list, catalog)

# Combine with Lipinski Ro5
for idx, smi in enumerate(smiles_list):
    mol = Chem.MolFromSmiles(smi)
    if mol is None:
        continue
    ro5_violations = []
    if Descriptors.MolWt(mol) > 500:
        ro5_violations.append("MW>500")
    if Descriptors.MolLogP(mol) > 5:
        ro5_violations.append("logP>5")
    if Descriptors.NumHDonors(mol) > 5:
        ro5_violations.append("HBD>5")
    if Descriptors.NumHAcceptors(mol) > 10:
        ro5_violations.append("HBA>10")
    df_results.loc[idx, "ro5_violations"] = "; ".join(ro5_violations) if ro5_violations else None
    df_results.loc[idx, "ro5_pass"] = len(ro5_violations) == 0

# Summary
n_valid = df_results["valid"].sum()
n_pains_clean = (~df_results["flagged"].fillna(True)).sum()
n_ro5_pass = df_results["ro5_pass"].fillna(False).sum()
print(f"Valid molecules: {n_valid}/{len(df_results)}")
print(f"Alert-free: {n_pains_clean}/{n_valid} ({n_pains_clean/n_valid*100:.1f}%)")
print(f"Ro5 pass: {n_ro5_pass}/{n_valid} ({n_ro5_pass/n_valid*100:.1f}%)")
```

## Gotchas

- `GetFirstMatch()` returns `None` when clean, a `FilterCatalogEntry` when flagged. Do NOT compare with `False` -- use `is not None`.
- `GetMatches()` returns all matching filters. A single molecule can match multiple alerts from the same or different catalogs.
- `FilterCatalog` construction compiles several hundred SMARTS patterns and is NOT cheap. Build each catalog ONCE, outside the per-molecule loop, and reuse it. Rebuilding per molecule recompiles the full PAINS/Brenk pattern set on every row and dominates runtime on any real library.
- Alert descriptions are strings like `"quinone_A(370)"`. These are the filter names from the original PAINS publications. Report them as-is for traceability.
- PAINS filters were published in three tiers (A, B, C). Class A filters have the strongest evidence of interference. If triaging a large library, prioritize Class A flags.
