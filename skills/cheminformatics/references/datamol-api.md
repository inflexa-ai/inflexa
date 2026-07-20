# datamol API Reference

Python library built on top of RDKit providing a simplified, high-level API for molecular manipulation, standardization, fingerprinting, clustering, and scaffold analysis. Designed for modern cheminformatics workflows with pandas and numpy integration.

## Core Imports

```python
import datamol as dm
import pandas as pd
import numpy as np
```

## Standardization

The primary reason to use datamol: a convenient wrapper over the RDKit
standardizer. Note that it does **not** strip salts or neutralize by default --
you have to opt in.

### Full Standardization Pipeline

```python
# Signature:
# dm.standardize_mol(mol, disconnect_metals=False, normalize=True,
#                    reionize=True, uncharge=False, stereo=True) -> Mol

mol = dm.to_mol("CC(=O)Oc1ccccc1C(=O)[O-].[Na+]")  # aspirin sodium salt

# Defaults only normalize/reionize/fix stereo -- the salt survives
std_mol = dm.standardize_mol(mol)
dm.to_smiles(std_mol)
# Result: "CC(=O)Oc1ccccc1C(=O)[O-].[Na+]"  (unchanged!)

# To actually strip the salt and neutralize, keep the largest fragment first,
# then ask standardize_mol to uncharge:
std_mol = dm.standardize_mol(dm.keep_largest_fragment(mol), uncharge=True)
std_smi = dm.to_smiles(std_mol)
# Result: "CC(=O)Oc1ccccc1C(=O)O"

# One-liner from SMILES -- same defaults, so also does NOT strip the salt
std_smi = dm.standardize_smiles("CC(=O)Oc1ccccc1C(=O)[O-].[Na+]")
```

### Individual Standardization Steps

```python
mol = dm.to_mol(smi)

# Fix common issues (valence errors, kekulization)
mol = dm.fix_mol(mol)

# Sanitize (RDKit sanitization + additional checks)
mol = dm.sanitize_mol(mol)

# Keep only the largest fragment (this is what strips salts/counterions)
mol = dm.keep_largest_fragment(mol)

# Standardize: normalize + reionize + stereo by default.
# Pass uncharge=True to neutralize; disconnect_metals=True to cut metal bonds.
mol = dm.standardize_mol(mol, uncharge=True)
```

### Batch Standardization

```python
smiles_list = ["CCO.[Na+]", "c1ccccc1CC(=O)[O-]", "INVALID", "CC(=O)O"]

# dm.to_mol() returns None for invalid SMILES, and dm.standardize_mol(None)
# raises ValueError("Molecule is None") -- so guard before standardizing.
def safe_standardize(smi):
    mol = dm.to_mol(smi)
    if mol is None:
        return None
    return dm.standardize_mol(dm.keep_largest_fragment(mol), uncharge=True)

std_mols = [safe_standardize(s) for s in smiles_list]
std_smiles = [dm.to_smiles(m) if m is not None else None for m in std_mols]

# Filter out failures
valid = [(s, m) for s, m in zip(smiles_list, std_mols) if m is not None]
```

### Gotchas -- Standardization

- `dm.standardize_mol()` does **not** return `None` on failure -- it returns a `Mol`, and raises `ValueError` if you hand it `None`. Check the output of `dm.to_mol()` instead. Likewise `dm.standardize_smiles("INVALID")` raises rather than returning `None`.
- Standardization does **not** strip salts and does **not** neutralize by default (`uncharge=False`). Use `dm.keep_largest_fragment()` for salt stripping and pass `uncharge=True` to neutralize.
- `dm.standardize_mol()` does **not** canonicalize tautomers -- a keto and an enol form both survive unchanged. Call `dm.canonical_tautomer(mol)` explicitly if you need tautomer-invariant comparison.

## Molecule I/O

### SMILES

```python
# Parse SMILES to molecule
mol = dm.to_mol("CCO")
mol = dm.to_mol("CCO", sanitize=True)  # default

# Molecule to SMILES
smi = dm.to_smiles(mol)
smi = dm.to_smiles(mol, canonical=True, isomeric=True)  # defaults
```

### SDF Files

```python
# Read SDF (returns list of molecules)
mols = dm.read_sdf("compounds.sdf")

# Read with properties as DataFrame
df = dm.read_sdf("compounds.sdf", as_df=True)
# Columns: 'smiles' + all SDF properties. NO mol objects by default.

# To also get RDKit mol objects, name the column explicitly
df = dm.read_sdf("compounds.sdf", as_df=True, mol_column="mol")
# Columns: 'smiles', 'mol', + all SDF properties

# Write molecules to SDF
dm.to_sdf(mols, "output.sdf")

# Write DataFrame with molecule column
dm.to_sdf(df, "output.sdf", mol_column="mol")
```

### Gotchas -- I/O

- The reader is `dm.read_sdf()`. There is no `dm.from_sdf()` -- that name raises `AttributeError`.
- `dm.to_mol()` returns `None` for invalid SMILES (same as RDKit). Always check.
- `dm.read_sdf()` with `as_df=True` gives you a `smiles` column, **not** mol objects. Pass `mol_column="mol"` if you need `Mol` instances.
- When reading large SDF files (>100K), consider `max_num_mols=` or chunked reading to manage memory.

## Fingerprints

```python
# Signature:
# dm.to_fp(mol, as_array=True, fp_type="ecfp", fold_size=None, **fp_args)
# **fp_args are forwarded verbatim to the underlying RDKit generator, so they
# use RDKit's names (fpSize, radius, ...) -- NOT n_bits.

# Morgan fingerprint (ECFP) as numpy array
fp = dm.to_fp(mol, fp_type="ecfp", fpSize=2048, radius=2)
# Returns: np.ndarray of shape (2048,), dtype uint8

# Other fingerprint types
fp_rdkit = dm.to_fp(mol, fp_type="rdkit", fpSize=2048)
fp_topological = dm.to_fp(mol, fp_type="topological", fpSize=2048)
fp_maccs = dm.to_fp(mol, fp_type="maccs")  # MACCS keys: 167 bits in RDKit (bit 0 unused)

# See every supported name
dm.list_supported_fingerprints().keys()
# ecfp, fcfp, topological, atompair, rdkit, maccs, pattern, layered, erg,
# estate, avalon-count, and the "-count" variants

# Batch fingerprinting
fps = np.array([dm.to_fp(m, fp_type="ecfp", fpSize=2048, radius=2)
                for m in mols if m is not None])
# Shape: (n_mols, 2048)
```

### Gotchas -- Fingerprints

- There is **no** `fp_type="morgan"`. The Morgan/ECFP fingerprint is `fp_type="ecfp"`; passing `"morgan"` raises `ValueError`.
- There is **no** `n_bits` argument. The bit count is `fpSize` for `ecfp`/`fcfp`/`rdkit`/`topological`/`atompair`, and `nBits` for `avalon`/`secfp`. Passing `n_bits` raises an RDKit `ArgumentError`.
- datamol's default `ecfp` radius is **3** (ECFP6), not RDKit's default of 2. Pass `radius=2` explicitly if you want ECFP4.
- `dm.to_fp()` returns a numpy array of dtype `uint8` (not an RDKit DataStructs object). Convenient for ML but not directly compatible with `DataStructs.TanimotoSimilarity()`. Pass `as_array=False` to get the RDKit bit vector back.
- For Tanimoto similarity on datamol fingerprints, use `np.dot(a, b) / (np.sum(a) + np.sum(b) - np.dot(a, b))` or use `as_array=False`.
- `dm.to_fp(None)` raises `ValueError` -- it does not return `None`. Filter invalid molecules first.

## Clustering

### Butina Clustering

```python
# Cluster molecules by structural similarity
# cutoff: Tanimoto distance threshold (0.4 = 60% similarity minimum)
# Signature: dm.cluster_mols(mols, cutoff=0.2, feature_fn=None, n_jobs=1)
cluster_indices, cluster_mols = dm.cluster_mols(mols, cutoff=0.4)
# Returns a 2-TUPLE:
#   cluster_indices: tuple of tuples of molecule indices
#   cluster_mols:    list of lists of the Mol objects themselves

# Get cluster assignments
cluster_ids = [None] * len(mols)
for i, cluster in enumerate(cluster_indices):
    for idx in cluster:
        cluster_ids[idx] = i

# Largest clusters
cluster_sizes = [len(c) for c in cluster_indices]
sorted_clusters = sorted(enumerate(cluster_indices), key=lambda x: len(x[1]), reverse=True)
```

### Gotchas -- Clustering

- `dm.cluster_mols()` returns **two** values, `(cluster_indices, cluster_mols)`. Assigning it to a single name gives you the tuple, and `len(c) for c in ...` then silently measures the two halves rather than the clusters.
- `cutoff=0.4` is Tanimoto *distance* (1 - similarity). Lower cutoff = tighter clusters (higher similarity required). The datamol default is `0.2`.
- Butina clustering is deterministic but order-dependent. The first molecule in each cluster is the centroid.
- Clustering fingerprints come from `dm.to_fp()` defaults (ECFP6) unless you pass your own `feature_fn`.
- For very large libraries (>50K), clustering can be slow. Consider subsetting or using approximate methods.

## Scaffolds

```python
# Murcko scaffold -- returns a Mol, NOT a SMILES string
scaffold_mol = dm.to_scaffold_murcko(mol, make_generic=False)
scaffold_smi = dm.to_smiles(scaffold_mol)
# e.g. aspirin -> "c1ccccc1"

# Generic scaffold: atoms become dummy/any atoms (*), bond orders are kept
generic_smi = dm.to_smiles(dm.to_scaffold_murcko(mol, make_generic=True))
# e.g. aspirin -> "*1:*:*:*:*:*:1"

# Batch scaffold extraction
scaffolds = [
    dm.to_smiles(dm.to_scaffold_murcko(m, make_generic=True))
    for m in mols if m is not None
]

# Scaffold distribution
scaffold_counts = pd.Series(scaffolds).value_counts()
```

### Gotchas -- Scaffolds

- The function is `dm.to_scaffold_murcko()` and it returns a **`Mol`**. There is no `dm.to_scaffold_smiles()`; wrap the result in `dm.to_smiles()` yourself. Feeding the `Mol` straight into `pd.Series(...).value_counts()` groups by object identity, so every molecule looks unique.
- `make_generic=True` replaces atoms with **dummy atoms (`*`)**, not carbons, and leaves bond orders alone (`dm.make_scaffold_generic()` only changes bond order when called directly with `include_bonds=True`). It still serves the purpose of grouping compounds that differ only in heteroatom substitution.
- Acyclic molecules produce an empty scaffold string (`""`). Filter or handle these cases.

## Descriptors

```python
# Individual descriptors
mw   = dm.descriptors.mw(mol)       # molecular weight
logp = dm.descriptors.clogp(mol)    # Crippen logP -- the name is clogp, not logp
tpsa = dm.descriptors.tpsa(mol)     # topological polar surface area
hba  = dm.descriptors.n_hba(mol)    # hydrogen bond acceptors
hbd  = dm.descriptors.n_hbd(mol)    # hydrogen bond donors
rotb = dm.descriptors.n_rotatable_bonds(mol)  # rotatable bonds
ha   = dm.descriptors.n_heavy_atoms(mol)      # heavy atom count
rings = dm.descriptors.n_rings(mol)            # ring count

# Everything at once (returns a dict of ~25 descriptors)
props = dm.descriptors.compute_many_descriptors(mol)

# Batch version (returns a DataFrame)
df_props = dm.descriptors.batch_compute_many_descriptors(mols)

# Batch via DataFrame
def compute_dm_properties(mols):
    records = []
    for mol in mols:
        if mol is None:
            continue
        records.append({
            "SMILES": dm.to_smiles(mol),
            "MW": dm.descriptors.mw(mol),
            "logP": dm.descriptors.clogp(mol),
            "TPSA": dm.descriptors.tpsa(mol),
            "HBA": dm.descriptors.n_hba(mol),
            "HBD": dm.descriptors.n_hbd(mol),
            "RotBonds": dm.descriptors.n_rotatable_bonds(mol),
        })
    return pd.DataFrame(records)
```

## Batch Processing with Parallelization

```python
# Parallel processing using datamol's built-in parallelization
# Wraps joblib under the hood

def standardize_and_fp(smi):
    """Standardize SMILES and compute fingerprint."""
    mol = dm.to_mol(smi)
    if mol is None:
        return None
    mol = dm.standardize_mol(dm.keep_largest_fragment(mol), uncharge=True)
    return dm.to_fp(mol, fp_type="ecfp", fpSize=2048, radius=2)

# Process in parallel
results = dm.parallelized(standardize_and_fp, smiles_list, n_jobs=-1)
# n_jobs=-1 uses all available cores

# Filter None results
fps = [r for r in results if r is not None]
fps_array = np.array(fps)
```

### Gotchas -- Parallelization

- `dm.parallelized()` uses joblib. RDKit `Mol` objects *are* picklable, so passing mol objects works -- but pickling large mol lists costs more than passing SMILES strings and re-parsing in the worker, so SMILES is usually faster.
- Note that `dm.parallelized()` defaults to `n_jobs=-1`; pass `n_jobs=1` to run serially.
- `n_jobs=-1` uses all CPUs. In sandbox environments, check available cores first.
- For small datasets (<1K), parallelization overhead may exceed the benefit. Use serial processing instead.

## Complete Standardization + Profiling Workflow

```python
import datamol as dm
import pandas as pd
import numpy as np

# Read input
df = pd.read_csv("compounds.csv")

# Standardize (guard None -- standardize_mol raises on a None input)
def _std(s):
    m = dm.to_mol(s)
    if m is None:
        return None
    return dm.standardize_mol(dm.keep_largest_fragment(m), uncharge=True)

df["std_mol"] = df["SMILES"].apply(_std)
df["valid"] = df["std_mol"].apply(lambda m: m is not None)
print(f"Valid: {df['valid'].sum()}/{len(df)}")

# Filter valid
df_valid = df[df["valid"]].copy()
df_valid["std_SMILES"] = df_valid["std_mol"].apply(dm.to_smiles)

# Compute properties
df_valid["MW"] = df_valid["std_mol"].apply(dm.descriptors.mw)
df_valid["logP"] = df_valid["std_mol"].apply(dm.descriptors.clogp)
df_valid["TPSA"] = df_valid["std_mol"].apply(dm.descriptors.tpsa)
df_valid["HBD"] = df_valid["std_mol"].apply(dm.descriptors.n_hbd)
df_valid["HBA"] = df_valid["std_mol"].apply(dm.descriptors.n_hba)
df_valid["RotBonds"] = df_valid["std_mol"].apply(dm.descriptors.n_rotatable_bonds)

# Scaffolds
df_valid["scaffold"] = df_valid["std_mol"].apply(
    lambda m: dm.to_smiles(dm.to_scaffold_murcko(m, make_generic=True))
)

# Fingerprints for clustering
fps = np.array([
    dm.to_fp(m, fp_type="ecfp", fpSize=2048, radius=2)
    for m in df_valid["std_mol"]
])

# Cluster -- note the 2-tuple return
mols_list = df_valid["std_mol"].tolist()
cluster_indices, cluster_mols = dm.cluster_mols(mols_list, cutoff=0.4)
df_valid["cluster"] = [
    next(i for i, c in enumerate(cluster_indices) if j in c)
    for j in range(len(mols_list))
]
```
