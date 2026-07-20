# datamol API Reference

Python library built on top of RDKit providing a simplified, high-level API for molecular manipulation, standardization, fingerprinting, clustering, and scaffold analysis. Designed for modern cheminformatics workflows with pandas and numpy integration.

## Core Imports

```python
import datamol as dm
import pandas as pd
import numpy as np
```

## Standardization

The primary reason to use datamol: a single-call standardization pipeline that handles salt stripping, neutralization, and tautomer canonicalization.

### Full Standardization Pipeline

```python
# Standardize a single molecule
mol = dm.to_mol("CC(=O)Oc1ccccc1C(=O)[O-].[Na+]")  # aspirin sodium salt
std_mol = dm.standardize_mol(mol)
std_smi = dm.to_smiles(std_mol)
# Result: "CC(=O)Oc1ccccc1C(=O)O"  (salt stripped, neutralized)

# One-liner from SMILES
std_smi = dm.standardize_smiles("CC(=O)Oc1ccccc1C(=O)[O-].[Na+]")
```

### Individual Standardization Steps

```python
mol = dm.to_mol(smi)

# Fix common issues (valence errors, kekulization)
mol = dm.fix_mol(mol)

# Sanitize (RDKit sanitization + additional checks)
mol = dm.sanitize_mol(mol)

# Full standardization (fix + sanitize + uncharge + strip salts + normalize)
mol = dm.standardize_mol(mol)
```

### Batch Standardization

```python
smiles_list = ["CCO.[Na+]", "c1ccccc1CC(=O)[O-]", "INVALID", "CC(=O)O"]

# Standardize batch -- invalid SMILES produce None
std_mols = [dm.standardize_mol(dm.to_mol(s)) for s in smiles_list]
std_smiles = [dm.to_smiles(m) if m is not None else None for m in std_mols]

# Filter out failures
valid = [(s, m) for s, m in zip(smiles_list, std_mols) if m is not None]
```

### Gotchas -- Standardization

- `dm.standardize_mol()` returns `None` for molecules it cannot fix. Always check.
- Standardization strips salts by default. If you need the counterion, use lower-level RDKit salt stripping with `dontRemoveEverything=True`.
- Tautomer canonicalization may change the drawn structure but preserves chemical identity.

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
mols = dm.from_sdf("compounds.sdf")

# Read with properties as DataFrame
df = dm.from_sdf("compounds.sdf", as_df=True)
# Returns DataFrame with 'mol' column and all SDF properties

# Write molecules to SDF
dm.to_sdf(mols, "output.sdf")

# Write DataFrame with molecule column
dm.to_sdf(df, "output.sdf", mol_column="mol")
```

### Gotchas -- I/O

- `dm.to_mol()` returns `None` for invalid SMILES (same as RDKit). Always check.
- `dm.from_sdf()` with `as_df=True` creates a `mol` column containing RDKit mol objects.
- When reading large SDF files (>100K), consider chunked reading to manage memory.

## Fingerprints

```python
# Morgan fingerprint (ECFP) as numpy array
fp = dm.to_fp(mol, fp_type="morgan", n_bits=2048, radius=2)
# Returns: np.ndarray of shape (2048,), dtype int8

# Other fingerprint types
fp_rdkit = dm.to_fp(mol, fp_type="rdkit", n_bits=2048)
fp_topological = dm.to_fp(mol, fp_type="topological", n_bits=2048)
fp_maccs = dm.to_fp(mol, fp_type="maccs")  # MACCS keys: 167 bits in RDKit (bit 0 unused)

# Batch fingerprinting
fps = np.array([dm.to_fp(m, fp_type="morgan", n_bits=2048, radius=2)
                for m in mols if m is not None])
# Shape: (n_mols, 2048)
```

### Gotchas -- Fingerprints

- `dm.to_fp()` returns a numpy array (not an RDKit DataStructs object). This is convenient for ML but not directly compatible with `DataStructs.TanimotoSimilarity()`.
- For Tanimoto similarity on datamol fingerprints, use `np.dot(a, b) / (np.sum(a) + np.sum(b) - np.dot(a, b))` or convert back to RDKit bit vectors.
- Morgan radius=2 in datamol corresponds to ECFP4, same as RDKit.

## Clustering

### Butina Clustering

```python
# Cluster molecules by structural similarity
# cutoff: Tanimoto distance threshold (0.4 = 60% similarity minimum)
clusters = dm.cluster_mols(mols, cutoff=0.4)
# Returns: list of lists, each inner list contains molecule indices

# Get cluster assignments
cluster_ids = [None] * len(mols)
for i, cluster in enumerate(clusters):
    for idx in cluster:
        cluster_ids[idx] = i

# Largest clusters
cluster_sizes = [len(c) for c in clusters]
sorted_clusters = sorted(enumerate(clusters), key=lambda x: len(x[1]), reverse=True)
```

### Gotchas -- Clustering

- `cutoff=0.4` is Tanimoto *distance* (1 - similarity). Lower cutoff = tighter clusters (higher similarity required).
- Butina clustering is deterministic but order-dependent. The first molecule in each cluster is the centroid.
- For very large libraries (>50K), clustering can be slow. Consider subsetting or using approximate methods.

## Scaffolds

```python
# Murcko scaffold as SMILES
scaffold_smi = dm.to_scaffold_smiles(mol, make_generic=False)

# Generic scaffold (all atoms -> C, all bonds -> single)
generic_smi = dm.to_scaffold_smiles(mol, make_generic=True)

# Batch scaffold extraction
scaffolds = [dm.to_scaffold_smiles(m, make_generic=True) for m in mols if m is not None]

# Scaffold distribution
scaffold_counts = pd.Series(scaffolds).value_counts()
```

### Gotchas -- Scaffolds

- `make_generic=True` produces carbon-only frameworks. Useful for grouping structurally related compounds with different heteroatom substitutions.
- Acyclic molecules produce empty scaffold strings. Filter or handle these cases.

## Descriptors

```python
# Individual descriptors
mw   = dm.descriptors.mw(mol)       # molecular weight
logp = dm.descriptors.logp(mol)     # Crippen logP
tpsa = dm.descriptors.tpsa(mol)     # topological polar surface area
hba  = dm.descriptors.n_hba(mol)    # hydrogen bond acceptors
hbd  = dm.descriptors.n_hbd(mol)    # hydrogen bond donors
rotb = dm.descriptors.n_rotatable_bonds(mol)  # rotatable bonds
ha   = dm.descriptors.n_heavy_atoms(mol)      # heavy atom count
rings = dm.descriptors.n_rings(mol)            # ring count

# Batch via DataFrame
def compute_dm_properties(mols):
    records = []
    for mol in mols:
        if mol is None:
            continue
        records.append({
            "SMILES": dm.to_smiles(mol),
            "MW": dm.descriptors.mw(mol),
            "logP": dm.descriptors.logp(mol),
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
    mol = dm.standardize_mol(dm.to_mol(smi))
    if mol is None:
        return None
    return dm.to_fp(mol, fp_type="morgan", n_bits=2048, radius=2)

# Process in parallel
results = dm.parallelized(standardize_and_fp, smiles_list, n_jobs=-1)
# n_jobs=-1 uses all available cores

# Filter None results
fps = [r for r in results if r is not None]
fps_array = np.array(fps)
```

### Gotchas -- Parallelization

- `dm.parallelized()` uses joblib multiprocessing. RDKit mol objects cannot be pickled across processes -- pass SMILES strings, not mol objects.
- `n_jobs=-1` uses all CPUs. In sandbox environments, check available cores first.
- For small datasets (<1K), parallelization overhead may exceed the benefit. Use serial processing instead.

## Complete Standardization + Profiling Workflow

```python
import datamol as dm
import pandas as pd
import numpy as np

# Read input
df = pd.read_csv("compounds.csv")

# Standardize
df["std_mol"] = df["SMILES"].apply(lambda s: dm.standardize_mol(dm.to_mol(s)))
df["valid"] = df["std_mol"].apply(lambda m: m is not None)
print(f"Valid: {df['valid'].sum()}/{len(df)}")

# Filter valid
df_valid = df[df["valid"]].copy()
df_valid["std_SMILES"] = df_valid["std_mol"].apply(dm.to_smiles)

# Compute properties
df_valid["MW"] = df_valid["std_mol"].apply(dm.descriptors.mw)
df_valid["logP"] = df_valid["std_mol"].apply(dm.descriptors.logp)
df_valid["TPSA"] = df_valid["std_mol"].apply(dm.descriptors.tpsa)
df_valid["HBD"] = df_valid["std_mol"].apply(dm.descriptors.n_hbd)
df_valid["HBA"] = df_valid["std_mol"].apply(dm.descriptors.n_hba)
df_valid["RotBonds"] = df_valid["std_mol"].apply(dm.descriptors.n_rotatable_bonds)

# Scaffolds
df_valid["scaffold"] = df_valid["std_mol"].apply(
    lambda m: dm.to_scaffold_smiles(m, make_generic=True)
)

# Fingerprints for clustering
fps = np.array([
    dm.to_fp(m, fp_type="morgan", n_bits=2048, radius=2)
    for m in df_valid["std_mol"]
])

# Cluster
mols_list = df_valid["std_mol"].tolist()
clusters = dm.cluster_mols(mols_list, cutoff=0.4)
```
