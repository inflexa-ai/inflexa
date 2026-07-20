# Mordred API Reference

Python library for molecular descriptor calculation. Computes 1800+ 2D and 3D molecular descriptors from RDKit molecule objects. Useful for QSAR modeling, ADMET prediction, and molecular characterization.

## Core Imports

```python
import mordred
from mordred import Calculator, descriptors
from rdkit import Chem
import pandas as pd
import numpy as np
```

The import is `mordred` either way: the maintained distribution is the
community fork, which keeps the original module name. Upstream mordred's last
release (1.2.0, 2018) still calls `np.float`, removed in NumPy 1.24, so it
raises `AttributeError: module 'numpy' has no attribute 'float'` on import
under any current NumPy. If you see that, the unmaintained package is installed
rather than the fork — report it and fall back to RDKit descriptors. Do not
downgrade NumPy; that breaks the rest of the stack.

## Calculator Setup

### All Descriptors (2D Only)

```python
# Create calculator with all 2D descriptors (~1600 descriptors)
calc = Calculator(descriptors, ignore_3D=True)

# Check number of descriptors
print(len(calc.descriptors))  # ~1613
```

### All Descriptors (2D + 3D)

```python
# Include 3D descriptors (~1800+ total)
# Requires molecules with embedded 3D coordinates
calc = Calculator(descriptors, ignore_3D=False)
```

### Selective Descriptors

```python
from mordred import (
    Weight,         # molecular weight variants
    LogS,           # aqueous solubility
    TopoPSA,        # topological polar surface area
    ABCIndex,       # atom-bond connectivity index
    AcidBase,       # acid-base counts
    Aromatic,       # aromatic atom/bond proportion descriptors
    BondCount,      # bond type counts
    HydrogenBond,   # hydrogen bond descriptors
    RotatableBond,  # rotatable bond descriptors
    RingCount,      # ring descriptors
    SLogP,          # Wildman-Crippen logP
)

# Calculator with specific descriptor modules
calc = Calculator([Weight, SLogP, TopoPSA, HydrogenBond, RingCount])
print(len(calc.descriptors))  # 146 -- RingCount alone contributes 138
```

The module names are the ones listed in `mordred.descriptors.all`. Note there is
no `HBond` module (it is `HydrogenBond`) and no `AroRing` module (it is
`Aromatic`); importing either raises `ImportError`.

## Single Molecule Calculation

```python
mol = Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")  # aspirin

# Calculate all descriptors
result = calc(mol)
# Returns a mordred.Result object

# Access individual descriptors
first = result[0]           # by index (equivalent to result.ix[0])
mw = result["MW"]           # by descriptor name (equivalent to result.name["MW"])

# Convert to dict -- use asdict(), which gives STRING keys
result_dict = result.asdict()
# {"MW": 180.04, "AMW": 8.57, ...}
# Plain dict(result) also "works" but keys are Descriptor INSTANCES, not names.

# Check for errors (some descriptors fail on some molecules).
# Iterating a Result yields VALUES only, so use .items() to get name + value.
from mordred.error import MissingValueBase

for desc, value in result.items():
    if isinstance(value, MissingValueBase):
        print(f"{desc}: calculation failed ({value.header})")
```

### Gotchas -- Result objects

- `Result.__iter__` is `Result.values`, so iterating yields **values only**. `for name, value in result:` raises `TypeError: cannot unpack non-iterable float object`. Use `result.items()` to get `(Descriptor, value)` pairs.
- Failed descriptors come back as two classes: `mordred.error.Missing` (a known, expected failure -- e.g. a 3D descriptor on a 2D molecule) and `mordred.error.Error` (an unexpected exception). Both subclass `mordred.error.MissingValueBase`. Checking only `mordred.error.Error` misses the large majority: for aspirin with `ignore_3D=False`, 385 descriptors are missing but only 16 are `Error`. Test against `MissingValueBase` (or `mordred.error.is_missing`).
- `result.asdict()` gives string keys; `dict(result)` gives `Descriptor` instance keys. `result[0]` indexes by position, `result["MW"]` by name.
- `result.fill_missing(value=np.nan)` and `result.drop_missing()` return new `Result` objects -- they do not mutate in place.

## Batch Calculation with pandas

### DataFrame Output

```python
# Calculate descriptors for multiple molecules
mols = [Chem.MolFromSmiles(s) for s in smiles_list]
mols = [m for m in mols if m is not None]  # filter invalid

# Returns pandas DataFrame (molecules as rows, descriptors as columns)
df_desc = calc.pandas(mols)
# Shape: (n_mols, n_descriptors)
# Column names are descriptor names (strings)

# Check shape
print(f"Molecules: {df_desc.shape[0]}, Descriptors: {df_desc.shape[1]}")
```

### Handling NaN and Errors

```python
# Mordred returns error objects for failed calculations
# Convert to numeric, coercing errors to NaN
df_desc = calc.pandas(mols)

# Select only numeric columns (drops any all-error columns)
df_numeric = df_desc.select_dtypes(include=[np.number])

# Drop columns with too many NaN values
threshold = 0.5  # drop if >50% NaN
df_clean = df_numeric.dropna(axis=1, thresh=int(len(df_numeric) * (1 - threshold)))

# Fill remaining NaN (for ML input)
df_filled = df_clean.fillna(df_clean.median())
```

### Gotchas -- Batch Calculation

- `calc.pandas()` is the recommended method for batch processing. Returns a proper DataFrame. Signature: `calc.pandas(mols, nproc=None, nmols=None, quiet=False, ipynb=False, id=-1)`.
- Failed descriptors come back as `mordred.error.Missing` / `mordred.error.Error` objects, not NaN, so those columns land with dtype `object`. `select_dtypes(include=[np.number])` drops them. For aspirin with `ignore_3D=False`, 385 of 1826 columns are `object` this way.
- `select_dtypes(include=[np.number])` also keeps `int64` columns and drops `bool` ones -- check `df.dtypes` if you care about the boolean descriptors.
- Calculation speed: ~100-500 molecules per second for all 2D descriptors. For large datasets (>10K), consider using only selected descriptor modules.

## 2D vs 3D Descriptors

```python
# 2D only -- no conformer needed (faster, always works)
calc_2d = Calculator(descriptors, ignore_3D=True)
df_2d = calc_2d.pandas(mols)

# 2D + 3D -- requires embedded 3D coordinates
from rdkit.Chem import AllChem

mols_3d = []
for mol in mols:
    mol3 = Chem.AddHs(mol)
    result = AllChem.EmbedMolecule(mol3, AllChem.ETKDGv3())
    if result == 0:
        AllChem.MMFFOptimizeMolecule(mol3)
        mols_3d.append(mol3)

calc_3d = Calculator(descriptors, ignore_3D=False)
df_3d = calc_3d.pandas(mols_3d)
```

### Gotchas -- 2D vs 3D

- `ignore_3D=True` (default recommended) skips 3D descriptors. Much faster and no conformer generation needed.
- 3D descriptors require `AllChem.EmbedMolecule()` beforehand. Molecules without 3D coordinates produce errors for 3D descriptors.
- 3D descriptor calculation is significantly slower. Only use when spatial/shape information is genuinely needed.

## Common Descriptor Groups

Counts below are exact for mordred 1.2 (`len(Calculator(Module).descriptors)`).

| Module | Description | Count |
|-|-|-|
| `Weight` | Molecular weight variants (average, exact) | 2 |
| `SLogP` | Wildman-Crippen logP and molar refractivity | 2 |
| `TopoPSA` | Topological polar surface area | 2 |
| `HydrogenBond` | Hydrogen bond donor/acceptor counts | 2 |
| `RotatableBond` | Rotatable bond count and ratio | 2 |
| `RingCount` | Ring counts, by size/aromaticity/heteroatom | 138 |
| `Aromatic` | Aromatic atom and bond proportions | 2 |
| `BondCount` | Bond type counts (single, double, aromatic) | 9 |
| `AcidBase` | Acidic/basic group counts | 2 |
| `LogS` | Aqueous solubility (estimated) | 1 |
| `ABCIndex` | Atom-bond connectivity indices | 2 |

`RingCount` is by far the largest of these -- adding it to a "small" selective
calculator takes you from a handful of descriptors to well over a hundred.

## QSAR Workflow Example

```python
from mordred import Calculator, descriptors
from rdkit import Chem
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score

# Load data
df = pd.read_csv("compounds_with_activity.csv")

# Parse molecules
mols = [Chem.MolFromSmiles(s) for s in df["SMILES"]]
valid_mask = [m is not None for m in mols]
mols_valid = [m for m in mols if m is not None]
y = df.loc[valid_mask, "pIC50"].values

# Calculate descriptors (2D only)
calc = Calculator(descriptors, ignore_3D=True)
X_desc = calc.pandas(mols_valid)

# Clean descriptors
X_numeric = X_desc.select_dtypes(include=[np.number])
X_clean = X_numeric.dropna(axis=1, thresh=int(len(X_numeric) * 0.8))
X_filled = X_clean.fillna(X_clean.median())

# Remove low-variance features
from sklearn.feature_selection import VarianceThreshold
selector = VarianceThreshold(threshold=0.01)
X_selected = pd.DataFrame(
    selector.fit_transform(X_filled),
    columns=X_filled.columns[selector.get_support()],
)

# Train model
X_train, X_test, y_train, y_test = train_test_split(X_selected, y, test_size=0.2, random_state=42)
model = RandomForestRegressor(n_estimators=200, random_state=42, n_jobs=-1)
model.fit(X_train, y_train)
y_pred = model.predict(X_test)
print(f"R2: {r2_score(y_test, y_pred):.3f}")
```

## Gotchas

- Mordred descriptor names are long and descriptive (e.g., `"nAcid"`, `"SLogP"`, `"TPSA(Tot)"`). Use them as-is for reproducibility.
- Some descriptors are strongly correlated. For ML, apply feature selection (variance threshold, correlation filter) before training.
- The `Calculator` object is reusable. Create once, apply to many molecules.
- Mordred requires RDKit molecules. Always convert SMILES to mol objects first.
- `calc.pandas([])` does **not** raise -- it returns an empty DataFrame with the full descriptor columns, shape `(0, n_descriptors)`. Guard on `df.empty` rather than expecting an exception.
- An `AttributeError` for `numpy.float` on `import mordred` means the unmaintained upstream package is installed rather than the community fork; it cannot be used with a current NumPy. Report it and fall back to RDKit descriptors rather than working around it.
