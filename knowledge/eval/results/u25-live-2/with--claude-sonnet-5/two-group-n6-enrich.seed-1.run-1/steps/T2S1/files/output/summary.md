All numbers below are confirmed against the persisted JSON/CSV artifacts.

# fgsea Preranked GSEA Summary — Hallmark and WikiPathways (Treated vs Control)

## Key Quantitative Results

**Ranking input** (`hallmark_treated_vs_control_summary.json`, `wikipathways_treated_vs_control_summary.json`):
- Ranking metric: **`stat`** — the DESeq2 Wald statistic — for both runs.
- **9,782 genes** ranked (`n_genes_ranked`), taken from the full T1S2 DESeq2 results table with no p-value/fold-change pre-cut.
- For context, T1S2's own summary (`de_treated_vs_control_summary.json`, read via prior run) reports the DESeq2 test used the Wald test on a 6-vs-6 design.

**Hallmark (MSigDB, 2026.1, 50 sets)** (`hallmark_treated_vs_control_summary.json`):
- All **50/50** Hallmark sets fell inside the 15–500 size window and were tested (`n_sets_tested: 50`).
- **3,541** of the 9,782 ranked genes are members of at least one Hallmark set (`n_genes_in_sets`).
- **16 sets significant at BH-padj < 0.05** (`n_significant: 16`): 14 with positive NES, 2 with negative NES (`n_up: 14`, `n_down: 2`).
- Collapsed to **8 main (non-redundant) pathways** (`n_main_pathways: 8`).
- Top collapsed hits, from `hallmark_treated_vs_control_collapsed.csv`:
  - `HALLMARK_TNFA_SIGNALING_VIA_NFKB` — NES = 2.943, padj = 4.30e-33, size = 169; 5 sets folded in (APOPTOSIS, KRAS_SIGNALING_UP, UV_RESPONSE_UP, HYPOXIA, IL2_STAT5_SIGNALING).
  - `HALLMARK_OXIDATIVE_PHOSPHORYLATION` — NES = −3.072, padj = 2.88e-29, size = 151; no sets folded.
  - `HALLMARK_INTERFERON_GAMMA_RESPONSE` — NES = 2.770, padj = 1.04e-25, size = 168; 3 sets folded in (INTERFERON_ALPHA_RESPONSE, ALLOGRAFT_REJECTION, IL6_JAK_STAT3_SIGNALING).
  - `HALLMARK_INFLAMMATORY_RESPONSE` — NES = 2.085, padj = 9.95e-9, size = 170.
  - `HALLMARK_P53_PATHWAY` — NES = 1.792, padj = 9.49e-5, size = 168.
  - `HALLMARK_ADIPOGENESIS` — NES = −1.722, padj = 1.81e-4, size = 170.
  - `HALLMARK_COMPLEMENT` — NES = 1.596, padj = 3.68e-3, size = 166.
  - `HALLMARK_UNFOLDED_PROTEIN_RESPONSE` — NES = 1.441, padj = 4.69e-2, size = 96.

**WikiPathways (2026.07.10, secondary collection)** (`wikipathways_treated_vs_control_summary.json`):
- **987** pathways in the staged collection; **402** fell inside the 15–500 window among the ranked genes and were tested (`n_sets_tested`).
- **2,673** of the 9,782 ranked genes are members of at least one tested WikiPathways set (`n_genes_in_sets`).
- **101 sets significant at BH-padj < 0.05** (`n_significant: 101`): 94 positive, 7 negative NES.
- Collapsed to **32 main pathways** (`n_main_pathways: 32`).
- Top collapsed hits, from `wikipathways_treated_vs_control_collapsed.csv`:
  - `Electron_transport_chain_OXPHOS_system_in_mitochondria_(WP111)` — NES = −2.774, padj = 5.71e-14, size = 59; 4 sets folded in.
  - `Cancer_pathways_(WP5434)` — NES = 1.942, padj = 1.39e-6, size = 266; 29 sets folded in.
  - `Cytosolic_DNA_sensing_pathway_(WP4655)` — NES = 2.362, padj = 1.51e-6, size = 26; 9 sets folded in.
  - `miRNA_role_in_immune_response_in_sepsis_(WP4329)` — NES = 2.307, padj = 4.62e-6, size = 29.
  - `Gastrin_signaling_(WP4659)` — NES = 2.174, padj = 7.62e-6, size = 75.

**WikiPathways GMT conversion** (`logs/convert_wikipathways_gmt.log`):
- Source file's raw members were NCBI Entrez Gene IDs, not the HGNC symbols the reference catalog claimed.
- **987** pathways processed, **987** written out (**0** dropped for having no mappable members).
- **41,847 / 41,847** gene tokens (100.0% mapping rate) converted from Entrez ID to current HGNC symbol via the NCBI human `gene_info` table, producing `output/wikipathways_human_2026.07.10_hgnc_symbols.gmt`, which is what fgsea was actually run against (not the raw staged file).

**Software versions** (`session_info.txt`): R 4.6.0 (2026-04-24), fgsea 1.38.0, ggplot2 4.0.3, data.table 1.18.4.

## Method Choices and Rationale

- **Ranking statistic = DESeq2 Wald `stat`.** Chosen per plan constraint (doi:10.1101/060012); this is a disputed choice across labs (alternatives: shrunken log2 fold-change, signed −log10 p-value), so it is reported explicitly rather than left implicit.
- **fgseaMultilevel with `eps=0`** for maximum p-value precision (both summary JSONs record `eps: 0`), `minSize=15`, `maxSize=500`, seed 20260904 for reproducible tie-breaking and collapse.
- **BH adjustment** applied to both collections (`padj_cutoff: 0.05` in both JSONs).
- **`collapsePathways()`** used to fold redundant significant sets onto one representative per group, keeping the full uncollapsed table (`*_results.csv`) as a supplement in both collections.
- **Full ranked list, no pre-threshold**, per the plan's `enrichment_input = ranked_list` requirement — all 9,782 genes that received a Wald statistic in T1S2 were used, not a p-value- or fold-change-filtered subset.
- **WikiPathways GMT preprocessing**: the staged file was found to carry Entrez Gene IDs rather than the HGNC symbols its reference-catalog description promised. `scripts/convert_wikipathways_gmt.py` parses the `%`-delimited descriptor into a readable pathway name and WikiPathways ID, and maps every Entrez ID to its current HGNC symbol via NCBI `gene_info` before running fgsea — done rather than silently using symbol-based reference data against Entrez-ID gene sets, which would have produced near-zero overlap.
- **WikiPathways run as a secondary, corroborating collection** per plan, given its larger size and known redundancy relative to the curated 50-set Hallmark collection.

## Quality Notes

- Ranked gene pool: 9,782 genes (from T1S2, post low-count filtering, pre-p-value threshold).
- Gene-set coverage: 3,541 ranked genes overlap Hallmark; 2,673 overlap the converted WikiPathways collection — both are healthy, non-trivial overlaps, not "a handful of genes."
- Both fgsea runs completed under the same seed (20260904) and `eps=0` precision setting, and used identical size-window (15–500) and BH-adjustment settings, satisfying the plan's requirement that both collections be run comparably.
- WikiPathways Entrez→symbol mapping achieved 100% coverage (41,847/41,847 tokens), so no pathway was degraded or dropped by identifier mismatch after conversion.

## Limitations

- **Ranking-metric dependency**: results are conditional on ranking by the Wald statistic; a different ranking choice (shrunken LFC, signed −log10 p) could shift which sets cross the significance threshold or change leading-edge composition, particularly for borderline sets.
- **Association, not causation**: enrichment indicates the treated-vs-control expression shift resembles these curated gene programs (TNFα/NF-κB, interferon-α/γ, OXPHOS suppression); it does not establish that these pathways are causally or mechanistically engaged.
- **Reference-metadata mismatch**: the WikiPathways GMT's inventory description ("HGNC symbols") did not match its actual content (Entrez Gene IDs); this was caught and corrected in this run via a documented preprocessing script, but it means the raw staged file cannot be used as-is with symbol-based ranked lists elsewhere.
- **WikiPathways redundancy**: even after collapsing, 32 main pathways remain from 101 significant sets, reflecting substantial biological/pathway overlap (e.g., 29 sets folded into `Cancer_pathways_(WP5434)` alone) — this collection is a broader, noisier corroboration of the Hallmark result, not an independently precise second opinion.
- **Organism/context**: the underlying dataset provides no explicit statement of organism or treatment identity (per the upstream data profile), so the biological interpretation of "treated" remains unconstrained by the input metadata; enrichment results should be read as hypotheses about which programs move together, not as proof of a specific mechanism.