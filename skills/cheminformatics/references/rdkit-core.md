# RDKit Core API Reference

Core cheminformatics toolkit for molecular I/O, descriptor calculation, scaffold analysis, fingerprinting, drawing, and 3D conformer generation.

## Core Imports

```python
from rdkit import Chem
from rdkit.Chem import AllChem, Descriptors, Draw, PandasTools
from rdkit.Chem.Scaffolds import MurckoScaffold
from rdkit.Chem import FilterCatalog
from rdkit import DataStructs
import pandas as pd
import numpy as np
```

## Molecule I/O

### From SMILES

```python
mol = Chem.MolFromSmiles("CCO")           # ethanol
mol = Chem.MolFromSmiles("c1ccccc1")      # benzene (aromatic)

# ALWAYS check for None -- invalid SMILES return None
if mol is None:
    print("Invalid SMILES")

# Back to canonical SMILES
smi = Chem.MolToSmiles(mol)                # canonical form
smi = Chem.MolToSmiles(mol, isomericSmiles=True)  # preserve stereochemistry
```

### From SDF Files

```python
# Single molecule from MOL file
mol = Chem.MolFromMolFile("compound.mol")

# Multiple molecules from SDF
suppl = Chem.SDMolSupplier("compounds.sdf")
mols = [mol for mol in suppl if mol is not None]

# With properties from SDF
suppl = Chem.SDMolSupplier("compounds.sdf", removeHs=True)
for mol in suppl:
    if mol is None:
        continue
    name = mol.GetProp("_Name") if mol.HasProp("_Name") else "unknown"
```

### PandasTools Integration

```python
# Load SDF directly into DataFrame with molecule column
df = PandasTools.LoadSDF("compounds.sdf", smilesName="SMILES", molColName="ROMol")
# df has 'ROMol' column with RDKit mol objects and all SDF properties as columns

# Add molecule column from SMILES column in existing DataFrame
PandasTools.AddMoleculeColumnToFrame(df, smilesCol="SMILES", molCol="ROMol")

# Write DataFrame back to SDF
PandasTools.WriteSDF(df, "output.sdf", molColName="ROMol", properties=list(df.columns))
```

### Gotchas -- Molecule I/O

- `MolFromSmiles()` returns `None` for invalid SMILES. Always check before using.
- `SDMolSupplier` can yield `None` for malformed entries. Always filter.
- `removeHs=True` (default) strips explicit hydrogens on read. Set `removeHs=False` if hydrogen positions matter (e.g., for 3D work).
- `MolToSmiles()` produces canonical SMILES by default. Two identical molecules always produce the same canonical SMILES.

## Descriptors

### Common Molecular Properties

```python
mol = Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O")  # aspirin

mw    = Descriptors.MolWt(mol)               # molecular weight
logp  = Descriptors.MolLogP(mol)             # Wildman-Crippen logP
tpsa  = Descriptors.TPSA(mol)               # topological polar surface area
hbd   = Descriptors.NumHDonors(mol)          # hydrogen bond donors
hba   = Descriptors.NumHAcceptors(mol)       # hydrogen bond acceptors
rotb  = Descriptors.NumRotatableBonds(mol)   # rotatable bonds
ha    = Descriptors.HeavyAtomCount(mol)      # heavy atom count
rings = Descriptors.RingCount(mol)           # ring count
```

### Batch Descriptor Calculation

```python
def compute_properties(mols):
    """Compute standard drug-like properties for a list of molecules."""
    records = []
    for mol in mols:
        if mol is None:
            continue
        records.append({
            "SMILES": Chem.MolToSmiles(mol),
            "MW": Descriptors.MolWt(mol),
            "logP": Descriptors.MolLogP(mol),
            "TPSA": Descriptors.TPSA(mol),
            "HBD": Descriptors.NumHDonors(mol),
            "HBA": Descriptors.NumHAcceptors(mol),
            "RotBonds": Descriptors.NumRotatableBonds(mol),
            "HeavyAtoms": Descriptors.HeavyAtomCount(mol),
            "RingCount": Descriptors.RingCount(mol),
        })
    return pd.DataFrame(records)
```

### Lipinski Rule of Five

```python
def lipinski_ro5(mol):
    """Check Lipinski Rule of Five. Returns dict of violations."""
    violations = {}
    mw = Descriptors.MolWt(mol)
    logp = Descriptors.MolLogP(mol)
    hbd = Descriptors.NumHDonors(mol)
    hba = Descriptors.NumHAcceptors(mol)

    if mw > 500:
        violations["MW"] = f"{mw:.1f} > 500"
    if logp > 5:
        violations["logP"] = f"{logp:.2f} > 5"
    if hbd > 5:
        violations["HBD"] = f"{hbd} > 5"
    if hba > 10:
        violations["HBA"] = f"{hba} > 10"

    return violations
```

### Gotchas -- Descriptors

- `MolLogP` is Wildman-Crippen (computed, not experimental). It's fast but approximate.
- `TPSA` uses the Ertl definition by default (topological, no 3D needed).
- `NumRotatableBonds` excludes amide C-N bonds by default (Lipinski convention).

## Scaffolds

### Murcko Scaffold Decomposition

```python
from rdkit.Chem.Scaffolds import MurckoScaffold

mol = Chem.MolFromSmiles("c1ccc(NC(=O)c2ccccn2)cc1")

# Full Murcko scaffold (preserves atom types and bond orders)
scaffold = MurckoScaffold.GetScaffoldForMol(mol)
scaffold_smi = Chem.MolToSmiles(scaffold)

# Generic scaffold (all atoms -> C, all bonds -> single)
generic = MurckoScaffold.MakeScaffoldGeneric(scaffold)
generic_smi = Chem.MolToSmiles(generic)
```

### Batch Scaffold Extraction

```python
def get_scaffolds(smiles_list, generic=False):
    """Extract Murcko scaffolds from a list of SMILES."""
    scaffolds = []
    for smi in smiles_list:
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            scaffolds.append(None)
            continue
        scaf = MurckoScaffold.GetScaffoldForMol(mol)
        if generic:
            scaf = MurckoScaffold.MakeScaffoldGeneric(scaf)
        scaffolds.append(Chem.MolToSmiles(scaf))
    return scaffolds

# Usage
df["scaffold"] = get_scaffolds(df["SMILES"].tolist(), generic=True)
scaffold_counts = df["scaffold"].value_counts()
```

### Gotchas -- Scaffolds

- `GetScaffoldForMol` returns a full ring system scaffold (retains heteroatoms). Use `MakeScaffoldGeneric` for carbon-only frameworks.
- Single-atom or acyclic molecules may produce empty scaffolds. Check for empty SMILES after extraction.

## Fingerprints

### Morgan Fingerprints (ECFP)

```python
# Morgan radius=2 = ECFP4, radius=3 = ECFP6
fp = AllChem.GetMorganFingerprintAsBitVect(mol, radius=2, nBits=2048)

# Batch fingerprinting
fps = [AllChem.GetMorganFingerprintAsBitVect(m, radius=2, nBits=2048)
       for m in mols if m is not None]

# Convert to numpy array
arr = np.zeros((1,), dtype=np.int8)
DataStructs.ConvertToNumpyArray(fp, arr)
# Or for a batch:
fp_array = np.array([list(fp) for fp in fps], dtype=np.int8)
```

### RDKit Fingerprints (Daylight-like)

```python
fp = Chem.RDKFingerprint(mol, fpSize=2048)
```

### Tanimoto Similarity

```python
# Pairwise
sim = DataStructs.TanimotoSimilarity(fp1, fp2)

# One-to-many (bulk)
sims = DataStructs.BulkTanimotoSimilarity(fp1, fps_list)
# Returns list of float similarities

# Distance matrix for clustering
from rdkit.ML.Cluster import Butina

# Build distance matrix (lower triangle)
n = len(fps)
dists = []
for i in range(1, n):
    sims = DataStructs.BulkTanimotoSimilarity(fps[i], fps[:i])
    dists.extend([1 - s for s in sims])

# Butina clustering
clusters = Butina.ClusterData(dists, n, distThresh=0.4, isDistData=True)
# Returns tuple of tuples: each inner tuple contains indices of cluster members
```

### Gotchas -- Fingerprints

- **Always use `GetMorganFingerprintAsBitVect` (bit vector) for Tanimoto**, not `GetMorganFingerprint` (count vector). Tanimoto on count vectors gives different (usually lower) similarity values.
- Morgan radius=2 = ECFP4 (diameter 4). This is the most common default.
- `nBits=2048` is standard. Higher values (4096) reduce collisions but increase memory.
- `BulkTanimotoSimilarity` is much faster than looping over `TanimotoSimilarity` for one-to-many comparisons.

## Drawing

### Molecule Grid Images

```python
# Grid of molecules with labels
img = Draw.MolsToGridImage(
    mols[:12],
    molsPerRow=4,
    subImgSize=(300, 300),
    legends=[f"IC50: {v:.1f} nM" for v in ic50_values[:12]],
)
img.save("mol_grid.png")
```

### Single Molecule Image

```python
img = Draw.MolToImage(mol, size=(400, 300))
img.save("molecule.png")
```

### Highlighting Substructures

```python
# Highlight a substructure match
pattern = Chem.MolFromSmarts("c1ccccc1")  # benzene ring
match = mol.GetSubstructMatch(pattern)
img = Draw.MolToImage(mol, size=(400, 300), highlightAtoms=match)
img.save("highlighted.png")
```

### Gotchas -- Drawing

- `MolsToGridImage` returns a PIL Image. Save with `.save("file.png")`.
- Use `subImgSize=(300,300)` or larger for legible images. Default is (200,200).
- `legends` must match the length of the molecules list.
- For publication-quality SVG: `Draw.MolToFile(mol, "mol.svg", size=(300,300))`.

## 3D Conformer Generation

```python
from rdkit.Chem import AllChem

mol = Chem.MolFromSmiles("CCO")
mol = Chem.AddHs(mol)  # Add hydrogens for 3D embedding

# Generate 3D conformer using ETKDGv3
result = AllChem.EmbedMolecule(mol, AllChem.ETKDGv3())
# result = 0 on success, -1 on failure

# Optimize geometry with MMFF
AllChem.MMFFOptimizeMolecule(mol, maxIters=500)

# Multiple conformers
cids = AllChem.EmbedMultipleConfs(mol, numConfs=50, params=AllChem.ETKDGv3())
# Optimize each. Returns one (not_converged, energy) tuple per
# conformer, in conformer order: results[i] belongs to cids[i].
results = AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=500)

# Get lowest energy conformer. Pair each result with its conformer ID
# BEFORE dropping the ones that failed to converge — a position in a
# filtered energy list is not a conformer ID.
converged = [
    (energy, cid)
    for (not_converged, energy), cid in zip(results, cids)
    if not_converged == 0
]
if not converged:
    raise RuntimeError(
        "No conformer converged — raise maxIters, or check that MMFF "
        "parameters exist for this molecule."
    )
best_energy, best_cid = min(converged)

# Write to SDF
writer = Chem.SDWriter("conformer.sdf")
writer.write(mol, confId=best_cid)
writer.close()
```

### Gotchas -- 3D

- Always `AddHs()` before embedding. Without hydrogens, geometry is poor.
- `EmbedMolecule` returns -1 on failure (happens with strained or very large molecules). Check the return value.
- `ETKDGv3()` is the recommended embedding method (improved torsion angles).
- `MMFFOptimizeMolecule` returns 0 on success, 1 if not converged, -1 if MMFF params not available.
- `MMFFOptimizeMoleculeConfs` returns a list of `(not_converged, energy)` 2-tuples — one per conformer, in conformer order, aligned with the `cids` from `EmbedMultipleConfs`. Never `argmin` over a filtered energy list and use the result as a `confId`: filtering renumbers the positions, so the moment one conformer fails to converge you silently write out a different conformer than the lowest-energy one. Carry the `cid` alongside the energy instead.
- `confId` is a conformer ID, not a list position. `writer.write(mol, confId=...)` with a stale position writes the wrong geometry rather than erroring.

## PandasTools Integration

### Full Workflow with DataFrames

```python
# Load SDF into DataFrame
df = PandasTools.LoadSDF("library.sdf", smilesName="SMILES", molColName="ROMol")

# Compute properties
df["MW"] = df["ROMol"].apply(Descriptors.MolWt)
df["logP"] = df["ROMol"].apply(Descriptors.MolLogP)
df["TPSA"] = df["ROMol"].apply(Descriptors.TPSA)
df["HBD"] = df["ROMol"].apply(Descriptors.NumHDonors)
df["HBA"] = df["ROMol"].apply(Descriptors.NumHAcceptors)
df["RotBonds"] = df["ROMol"].apply(Descriptors.NumRotatableBonds)

# Add scaffolds
df["scaffold"] = df["ROMol"].apply(
    lambda m: Chem.MolToSmiles(MurckoScaffold.MakeScaffoldGeneric(
        MurckoScaffold.GetScaffoldForMol(m)
    )) if m else None
)

# Fingerprints as numpy for ML
fps = np.array([
    list(AllChem.GetMorganFingerprintAsBitVect(m, 2, nBits=2048))
    for m in df["ROMol"] if m is not None
], dtype=np.int8)
```

### Gotchas -- PandasTools

- `LoadSDF` returns all SDF properties as string columns. Cast numeric columns explicitly.
- The `"ROMol"` column contains RDKit mol objects. These do not serialize to CSV -- drop before saving or convert to SMILES.
- `WriteSDF` requires the `molColName` parameter to identify the molecule column.
