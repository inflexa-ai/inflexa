# cheminformatics-skill Specification

## Purpose

Define the `cheminformatics` skill pack — the runtime knowledge the
`cheminformatics-agent` reads (via `skill_search` / `skill_read`) to pick and
execute molecular-analysis methods. The pack is the source of truth for the
agent's method-selection decision tree, figure/output conventions, and
anti-patterns, plus focused per-package API references. It assumes Python with
RDKit as the core toolkit, supplemented by datamol, mordred, and DeepChem, and it
spans the agent's full surface: SAR triage, library profiling, compound
comparison, QSAR, ADMET, structure processing, target-engagement assessment,
drug-perturbation connectivity scoring, and selectivity profiling. References
cover the most-used patterns rather than exhaustive API docs — for deeper
exploration the agent falls back to Context7 (`resolveLibraryId` + `queryDocs`).

## Requirements

### Requirement: Skill pack structure

The system SHALL provide the pack at `skills/cheminformatics/` with a `SKILL.md`
manifest and a `references/` directory of API reference files.

#### Scenario: Pack exists with manifest and references

- **WHEN** `skills/cheminformatics/` is listed
- **THEN** `SKILL.md` exists
- **AND** `references/` exists with reference files

### Requirement: SKILL.md manifest and decision tree

`SKILL.md` SHALL carry YAML frontmatter with `name: cheminformatics`, a
`description`, a semver `version`, and `tags` (including `cheminformatics`,
`rdkit`, `sar`, `qsar`, `drug-discovery`). The body SHALL contain a
method-selection decision tree covering, at minimum:

1. **SAR triage** — Murcko scaffold decomposition, property profiling (MW, logP, TPSA, HBD/HBA, RotBonds), druglikeness (Lipinski Ro5, Veber, Ghose), PAINS/structural-alert filtering, scaffold-activity matrix
2. **Library profiling** — property distributions, chemical diversity (Tanimoto on Morgan fingerprints + clustering), chemical-space map (UMAP/t-SNE), structural-alert sweep
3. **Compound comparison** — per-set property comparison, scaffold overlap, chemical-space overlap
4. **QSAR modeling** — fingerprint + sklearn for small data (<1K), DeepChem featurizer + MLP for medium (1K–100K), DeepChem GCN/AttentiveFP for large (>100K)
5. **ADMET prediction** — computed descriptors (rdkit + mordred), rule-based filters, learned models (DeepChem)
6. **Structure processing** — format conversion, standardization (datamol), salt stripping, 3D conformer generation
7. **Target engagement, connectivity scoring, and selectivity profiling** — occupancy/engagement assessment, CMap-style perturbation-signature matching, and kinase/selectivity panels

The body SHALL also include figure conventions, output conventions, and
cheminformatics-specific anti-patterns.

#### Scenario: Decision tree covers SAR triage

- **WHEN** the agent reads `SKILL.md`
- **THEN** it finds Murcko scaffold guidance referencing `rdkit.Chem.Scaffolds.MurckoScaffold`
- **AND** PAINS filtering referencing `rdkit.Chem.FilterCatalog`
- **AND** property profiling referencing `rdkit.Chem.Descriptors` and `datamol`

#### Scenario: Decision tree routes QSAR by dataset size

- **WHEN** the agent reads `SKILL.md`
- **THEN** it routes small datasets (<1K) to fingerprint + sklearn
- **AND** large datasets (>100K) to DeepChem graph neural networks

### Requirement: Reference file inventory

The `references/` directory SHALL contain focused per-package/per-topic files
covering: RDKit core (`rdkit-core.md`), datamol (`datamol-api.md`), mordred
(`mordred-api.md`), DeepChem (`deepchem-api.md`), structural alerts
(`structural-alerts.md`), target engagement (`target-engagement.md`),
selectivity scoring (`selectivity-scoring.md`), and gseapy-based connectivity
(`gseapy-connectivity.md`).

#### Scenario: Reference inventory is complete

- **WHEN** `skills/cheminformatics/references/` is listed
- **THEN** it contains `rdkit-core.md`, `datamol-api.md`, `mordred-api.md`, `deepchem-api.md`, and `structural-alerts.md`
- **AND** it contains `target-engagement.md`, `selectivity-scoring.md`, and `gseapy-connectivity.md`

#### Scenario: rdkit-core covers scaffolds and structural alerts

- **WHEN** the agent reads `references/rdkit-core.md`
- **THEN** it finds signatures for `MurckoScaffold.GetScaffoldForMol` and `MurckoScaffold.MakeScaffoldGeneric`
- **AND** `references/structural-alerts.md` covers building a `FilterCatalog` from PAINS/Brenk/NIH catalogs and interpreting matches

### Requirement: Token budget

The pack (SKILL.md + all reference files) SHALL stay focused on the most-used
patterns and signatures rather than exhaustive documentation; its combined size
is on the order of ~2,375 lines across the manifest and eight reference files.

#### Scenario: Pack size is in the expected range

- **WHEN** the combined line count of `SKILL.md` and every file in `references/` is measured
- **THEN** it totals on the order of ~2,375 lines (manifest + eight reference files), not ~1,000–1,400
