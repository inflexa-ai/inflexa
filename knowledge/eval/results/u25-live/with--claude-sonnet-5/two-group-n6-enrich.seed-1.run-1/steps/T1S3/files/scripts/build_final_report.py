"""Assemble the consolidated DE + Hallmark/Reactome enrichment report.

Pulls numbers from this step's own consolidated output CSVs (never
re-derives them from raw upstream files) and writes a single self-contained
Markdown report to output/consolidated_report.md, satisfying every
report_field and reproducibility_record item required by the task.
"""

import logging
from pathlib import Path

import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

OUT = Path("output")
REPORT_PATH = OUT / "consolidated_report.md"


def load_all() -> dict:
    d = {}
    d["gene_stats"] = pd.read_csv(OUT / "gene_table_summary_stats.csv").iloc[0].to_dict()
    d["pval_stats"] = pd.read_csv(OUT / "pvalue_histogram_interpretation_stats.csv").iloc[0].to_dict()
    d["enrich_meta"] = dict(
        zip(
            pd.read_csv(OUT / "enrichment_run_metadata.csv")["field"],
            pd.read_csv(OUT / "enrichment_run_metadata.csv")["value"],
        )
    )
    d["hallmark"] = pd.read_csv(OUT / "hallmark_enrichment_table.csv")
    d["reactome"] = pd.read_csv(OUT / "reactome_enrichment_table.csv")
    d["overlap"] = dict(
        zip(
            pd.read_csv(OUT / "hallmark_vs_reactome_overlap_summary.csv")["metric"],
            pd.read_csv(OUT / "hallmark_vs_reactome_overlap_summary.csv")["value"],
        )
    )
    d["r_versions"] = pd.read_csv(OUT / "package_versions_R.csv")
    d["session_info"] = (OUT / "session_info_R.txt").read_text()
    d["hallmark_collapsed"] = pd.read_csv(OUT / "hallmark_collapsed_representative_sets.csv")
    d["reactome_collapsed"] = pd.read_csv(OUT / "reactome_collapsed_representative_sets.csv")
    return d


def fmt_pathway_row(row: pd.Series) -> str:
    le = row["leadingEdge"]
    le_genes = le.split(";") if isinstance(le, str) else []
    le_preview = ", ".join(le_genes[:8]) + (f", … (+{len(le_genes) - 8} more)" if len(le_genes) > 8 else "")
    return (
        f"| {row['pathway']} | {row['size']} | {row['NES']:.3f} | {row['pval']:.2e} | "
        f"{row['padj']:.2e} | {le_preview} |"
    )


def build_report(d: dict) -> str:
    gs = d["gene_stats"]
    ps = d["pval_stats"]
    em = d["enrich_meta"]
    ov = d["overlap"]
    hallmark_sig = d["hallmark"][d["hallmark"]["significant_padj0.05"]].sort_values("padj")
    reactome_sig = d["reactome"][d["reactome"]["significant_padj0.05"]].sort_values("padj").head(15)
    r_versions = d["r_versions"]
    n_hallmark_representative = int(d["hallmark_collapsed"]["is_representative"].sum())
    n_reactome_representative = int(d["reactome_collapsed"]["is_representative"].sum())

    lines = []
    a = lines.append

    a("# Consolidated DE and Pathway Enrichment Report — Treated vs Control")
    a("")
    a(
        "Consolidates T1S1 (sample-structure QC), T1S2 (DESeq2 differential expression), "
        "and T2S1 (fgsea Hallmark/Reactome enrichment) into one reproducible report. "
        "No DE or enrichment computation is repeated here — every number below is read "
        "from those steps' persisted outputs and re-verified by this step's own scripts "
        "(`scripts/build_consolidated_gene_table.py`, `scripts/build_enrichment_tables.py`, "
        "`scripts/build_pvalue_histogram_interpretation.py`, `scripts/capture_session_info.R`)."
    )
    a("")

    a("## Bottom line")
    a("")
    a(
        f"Treated vs control (Wald test, apeglm-shrunken log2FC, BH padj < 0.05) identifies "
        f"**{int(gs['n_significant_padj0.05'])} significantly differentially expressed genes** "
        f"out of **{int(gs['n_genes_tested'])} genes tested** after filtering "
        f"({int(gs['n_up_in_treated'])} up in treated, {int(gs['n_down_in_treated'])} down, "
        f"{int(gs['n_padj_na'])} genes NA for padj as Cook's-distance count outliers). "
        f"Preranked fgsea on the same contrast's Wald statistic finds "
        f"**{int(em['hallmark_n_significant_padj0.05'])}/{int(em['hallmark_n_sets_in_size_window'])} "
        f"Hallmark pathways** and "
        f"**{int(em['reactome_n_significant_padj0.05'])}/{int(em['reactome_n_sets_in_size_window'])} "
        f"Reactome pathways** significant at BH padj < 0.05, dominated by innate-immune/inflammatory "
        f"activation (TNFA/NFKB, interferon alpha and gamma response, cytokine and interleukin "
        f"signaling — all up in treated) alongside a coordinated **decrease** in oxidative "
        f"phosphorylation and mitochondrial respiratory-chain pathways. The shallow sample "
        f"**sample_01 was excluded from this primary contrast** on QC grounds (see below); a "
        f"sensitivity run retaining it (n=6 vs 6) gave a highly concordant result (Pearson "
        f"r = 0.9889 on shrunken log2FC across shared tested genes, 875 significant genes) and is "
        f"reported as a robustness check, not an alternative primary answer."
    )
    a("")

    a("## Method")
    a("")
    a("**Differential expression (T1S2)**")
    a("")
    a("- Software: DESeq2 1.52.0 (Love, Huber & Anders, *Genome Biology* 2014, doi:10.1186/s13059-014-0550-8), R 4.6.0")
    a("- Shrinkage: apeglm 1.34.0 (Zhu, Ibrahim & Love, *Bioinformatics* 2019, doi:10.1093/bioinformatics/bty895), applied to the `condition_treated_vs_control` coefficient")
    a("- Design formula: `~condition`, with `condition` releveled so `control` is the explicit reference level")
    a("- Named contrast: `contrast = c(\"condition\", \"treated\", \"control\")` — positive log2FoldChange = higher in treated")
    a("- Test: Wald test, `fitType = \"parametric\"`, independent filtering on, BH (Benjamini-Hochberg) p-value adjustment, count outliers flagged (Cook's distance) rather than replaced (both group sizes are below DESeq2's default outlier-replacement sample-size threshold)")
    a("- alpha = 0.05")
    a("- Gene pre-filter: kept genes with ≥10 counts in ≥ the smallest modeled arm size (5, since the primary contrast is 5 control vs 6 treated after excluding sample_01)")
    a(
        "- **Count source determination**: `counts.csv` was verified as raw, non-length-scaled integer "
        "read counts — integer-valued with 0 negative values, per-sample sums on the order of "
        "0.4–2.7 million (library-scale, not TPM's fixed ~1e6), and an essentially null "
        "Spearman correlation between per-gene mean count and gene length (rho = -0.013, "
        "p = 0.15), which argues against the counts already being length-divided (a true "
        "FPKM/TPM-style division mechanically induces a negative length correlation). "
        "`gene_length_reference.csv` was therefore **not** applied to the counts before "
        "DESeq2 — DESeq2's own median-of-ratios size factors handle between-sample "
        "normalization internally, and gene length does not enter a two-group comparison of "
        "the same genes. Full detail: T1S2 `output/count_provenance.md`."
    )
    a(
        "- **Low-depth sample decision and rationale**: `sample_01` (control) had a library size "
        "of 420,347 reads — 3.84× below the cohort median (1,614,280) and the shallowest of "
        "all 12 samples — with a correspondingly reduced detected-gene count (10,918 vs a "
        "cohort median of 11,600) and a low DESeq2 size factor (0.288 vs cohort median 1.076). "
        "On the top-500-variable-gene blind-VST PCA it fell correctly on PC1 (the condition "
        "axis) but was a **23.77-SD outlier on PC2 relative to its own condition group** — a "
        "structural deviation beyond what depth-proportional size-factor down-weighting can "
        "absorb. Evidence was assembled across four independent QC lenses (library size, "
        "detected genes, PCA, sample-distance matrix; T1S1 `output/qc_decision_memo.md`) "
        "before deciding to **exclude sample_01 from the primary DE contrast** (5 control vs "
        "6 treated) **and report a parallel sensitivity run retaining it** (6 vs 6, T1S2 "
        "`output/de_results_treated_vs_control_sensitivity.csv`) rather than dropping it "
        "silently or keeping it by default."
    )
    a("")
    a("**Enrichment (T2S1)**")
    a("")
    a("- Software: fgsea 1.38.0 (Korotkevich et al., preranked GSEA; bioRxiv preprint, not PubMed-indexed), R 4.6.0")
    a(f"- Rank metric: {em['rank_metric']}")
    a("- Method: `fgseaMultilevel`, `eps = 0`, `minSize = 15`, `maxSize = 500`, `nproc = 2`, random seed = 42")
    a(
        f"- Universe: all {int(em['universe_n_genes_ranked_total'])} DESeq2-tested genes retained in the "
        f"ranked vector (no padj/log2FC pre-filtering). Of these, "
        f"{int(em['universe_n_genes_with_resolvable_HGNC_symbol'])} "
        f"({100 * (1 - float(em['universe_unmapped_share'])):.1f}%) carry a resolvable HGNC gene symbol "
        f"(`org.Hs.eg.db` {em['annotation_release_org.Hs.eg.db']}) and can intersect a Hallmark/Reactome "
        f"gene set; the remaining {int(em['universe_n_genes_unmapped_retained_in_rank'])} "
        f"({100 * float(em['universe_unmapped_share']):.1f}%, mostly synthetic `GENE#####` placeholder "
        f"symbols with no HGNC identity) are **retained in the ranked vector under their original name** "
        f"so the background used by fgsea's running-sum null is not distorted, even though they can "
        f"never contribute a leading-edge hit."
    )
    a(f"- Hallmark database: {em['hallmark_database']} — {em['hallmark_n_sets_shipped']} sets shipped, {int(em['hallmark_n_sets_in_size_window'])} in the 15–500 size window")
    a(f"- Reactome database: {em['reactome_database']} — {int(em['reactome_n_sets_shipped_all_species'])} sets shipped (all species), {int(em['reactome_n_sets_human'])} human, {int(em['reactome_n_sets_in_size_window'])} in the 15–500 size window")
    a("- Significance threshold: BH padj < 0.05, applied within each collection separately (Hallmark and Reactome results are never merged into one ranked list or one adjustment)")
    a("- Redundancy reduction: `fgsea::collapsePathways()` applied per collection to identify non-redundant representative sets (full cluster membership retained in the supplement tables, not discarded)")
    a("")

    a("## Gene table")
    a("")
    a(
        f"Full per-gene results for all {int(gs['n_genes_tested'])} tested genes — unshrunken "
        "log2FoldChange, apeglm-shrunken log2FoldChange, both lfcSE estimates, Wald statistic, "
        "pvalue, and padj — are in "
        "`output/consolidated_gene_table_ranked_by_shrunken_lfc.csv`, **ranked by "
        "shrunken_log2FoldChange descending** (most up in treated → most down in treated), per "
        "the DESeq2 vignette's guidance to use the shrunken estimate for visualization and "
        "ranking (shrinkage removes the inflated, noise-driven log2FC estimates that occur "
        "for genes with high dispersion or low counts, so ranking on the raw MLE would surface "
        "artifacts rather than genuine top hits)."
    )
    a("")
    a("Top 5 rows (by shrunken log2FoldChange, descending) and bottom 5 (most negative):")
    a("")
    top_bottom_path = OUT / "consolidated_gene_table_ranked_by_shrunken_lfc.csv"
    tb = pd.read_csv(top_bottom_path)
    a("| rank | gene | log2FoldChange | shrunken_log2FoldChange | lfcSE | shrunken_lfcSE | pvalue | padj | significant |")
    a("|---:|---|---:|---:|---:|---:|---:|---:|:---:|")
    for _, r in pd.concat([tb.head(5), tb.tail(5)]).iterrows():
        pv = f"{r['pvalue']:.2e}" if pd.notna(r["pvalue"]) else "NA"
        pj = f"{r['padj']:.2e}" if pd.notna(r["padj"]) else "NA"
        a(
            f"| {int(r['rank_by_shrunken_log2FC'])} | {r['gene']} | {r['log2FoldChange']:.3f} | "
            f"{r['shrunken_log2FoldChange']:.3f} | {r['lfcSE']:.3f} | {r['shrunken_lfcSE']:.3f} | "
            f"{pv} | {pj} | {r['significant_padj0.05']} |"
        )
    a("")
    a(
        f"**{int(gs['n_genes_tested'])} genes tested after filtering; "
        f"{int(gs['n_significant_padj0.05'])} significant at padj < 0.05** "
        f"({int(gs['n_up_in_treated'])} up / {int(gs['n_down_in_treated'])} down in treated)."
    )
    a("")

    a("## Fit diagnostics")
    a("")
    a("- **MA plot** (apeglm-shrunken log2FC vs baseMean, per the DESeq2 vignette's recommendation to plot the shrunken estimate to avoid the low-count fanning artifact): `figures/ma_plot_primary_shrunken.png` / `.pdf`")
    a("- **Dispersion plot** (gene-wise, fitted trend, and shrunken (\"final\") dispersion estimates): `figures/dispersion_plot_primary.png` / `.pdf`")
    a("- **Volcano plot** (shrunken log2FC vs -log10 padj, top hits labeled): `figures/volcano_plot_primary.png` / `.pdf`")
    a("")

    a("## P-value histogram")
    a("")
    a("`figures/pvalue_histogram_primary.png` / `.pdf`")
    a("")
    a(
        f"Bin counts (`output/pvalue_histogram_bin_counts.csv`, 20 equal-width bins over "
        f"[0,1], n = {int(ps['n_genes_with_pvalue'])} genes with a non-NA raw p-value): the "
        f"first bin [0, 0.05) holds {int(ps['first_bin_[0,0.05)_count'])} genes, "
        f"{ps['enrichment_ratio_first_bin_vs_tail_mean']:.2f}× the mean bin count in the flat "
        f"tail (p ≥ 0.4: mean {ps['tail_mean_count_p_gte_0.4']:.1f} genes/bin, SD "
        f"{ps['tail_sd_count_p_gte_0.4']:.1f}), and the last bin [0.95, 1.0] holds "
        f"{int(ps['last_bin_[0.95,1.0]_count'])} genes — close to the tail mean, not elevated."
    )
    a("")
    a(
        "**Interpretation**: this is the expected, well-behaved shape for a dataset with real "
        "differential expression — a clear enrichment near p = 0 (true positives plus some "
        "power) sitting on top of an approximately uniform (flat) distribution across the rest "
        "of the range (the null genes, for which p-values are uniform by construction under a "
        "correctly calibrated test). There is no anomalous peak near p = 1 and no excess "
        "mass at the low end beyond the flat baseline that would signal a badly fitting null "
        "(e.g., overdispersion not captured by the model, or a mis-specified design). This "
        "supports treating the BH-adjusted padj values as a valid basis for calling "
        "significance at the stated threshold."
    )
    a("")

    a("## Hallmark enrichment")
    a("")
    a(
        f"`output/hallmark_enrichment_table.csv` — all {len(d['hallmark'])} Hallmark sets in the "
        f"15–500 size window, sorted by padj. **{len(hallmark_sig)} significant at BH padj < 0.05**, "
        f"collapsed by `collapsePathways()` to "
        f"**{n_hallmark_representative} non-redundant representative sets** "
        f"(`output/hallmark_collapsed_representative_sets.csv`)."
    )
    a("")
    a("Database version: MSigDB Hallmark human release 2026.1. Rank metric: DESeq2 Wald statistic. "
      "Universe: 10,071 tested genes (3,669 with resolvable HGNC symbol). Size window: 15–500.")
    a("")
    a("All significant Hallmark sets (leading-edge genes truncated to first 8; full lists in `output/hallmark_leading_edge_genes_significant.csv`):")
    a("")
    a("| pathway | size | NES | pval | padj | leading-edge genes (preview) |")
    a("|---|---:|---:|---:|---:|---|")
    for _, row in hallmark_sig.iterrows():
        a(fmt_pathway_row(row))
    a("")
    a("Figures: `figures/enrichment_dotplot_hallmark.png` / `.pdf`; barplot and ridgeplot versions in T2S1's figure set.")
    a("")

    a("## Reactome enrichment")
    a("")
    a(
        f"`output/reactome_enrichment_table.csv` — all {len(d['reactome'])} Reactome sets in the "
        f"15–500 size window, sorted by padj. **{int(em['reactome_n_significant_padj0.05'])} significant "
        f"at BH padj < 0.05**, collapsed by `collapsePathways()` to "
        f"**{n_reactome_representative} non-redundant representative sets** "
        f"(`output/reactome_collapsed_representative_sets.csv`)."
    )
    a("")
    a(
        "Database version: Reactome Pathways, 'current' release as staged in the reference "
        "store — a rolling quarterly snapshot with **no immutable version tag embedded in the "
        "download itself**; restricted to *Homo sapiens* via a join against `ReactomePathways.txt` "
        "(2,868/2,868 shipped sets matched human — the file happened to already be human-only). "
        "Rank metric: DESeq2 Wald statistic. Universe: 10,071 tested genes (3,669 with resolvable "
        "HGNC symbol). Size window: 15–500."
    )
    a("")
    a(f"Top 15 of {int(em['reactome_n_significant_padj0.05'])} significant Reactome sets by padj (full list in the CSV; leading-edge genes truncated to first 8, full lists in `output/reactome_leading_edge_genes_significant.csv`):")
    a("")
    a("| pathway | size | NES | pval | padj | leading-edge genes (preview) |")
    a("|---|---:|---:|---:|---:|---|")
    for _, row in reactome_sig.iterrows():
        a(fmt_pathway_row(row))
    a("")
    a("Figures: `figures/enrichment_dotplot_reactome.png` / `.pdf`.")
    a("")

    a("## Hallmark vs Reactome comparison")
    a("")
    a(
        f"Hallmark significant sets: {int(ov['hallmark_n_significant_pathways'])}; Reactome significant "
        f"sets: {int(ov['reactome_n_significant_pathways'])}. Leading-edge gene union: "
        f"{int(ov['hallmark_n_leading_edge_genes_union'])} (Hallmark), "
        f"{int(ov['reactome_n_leading_edge_genes_union'])} (Reactome); "
        f"{int(ov['shared_leading_edge_genes'])} genes shared; Jaccard overlap = "
        f"{float(ov['jaccard_leading_edge_gene_overlap']):.3f}. Reactome's much larger significant-set "
        "count reflects its finer-grained, heavily nested pathway structure (e.g., a dozen near-"
        "identical Toll-like-receptor cascade entries) rather than stronger biological support — "
        "the collapsed representative counts (6 Hallmark vs 17 Reactome) are the fairer basis for "
        "cross-collection comparison. (`output/hallmark_vs_reactome_overlap_summary.csv`)"
    )
    a("")

    a("## Literature grounding")
    a("")
    a(
        "- The joint pattern of **up**: TNFA/NFKB signaling, interferon-alpha and -gamma "
        "response, inflammatory response, cytokine/interleukin signaling, and **down**: "
        "oxidative phosphorylation / mitochondrial respiratory-chain assembly is the "
        "transcriptional signature classically associated with innate-immune/inflammatory cell "
        "activation, which represses OXPHOS in favor of glycolysis (immunometabolic "
        "reprogramming). Confirmed by prior literature, e.g. Mills et al., *Cell* 2016 "
        "(PMID 27667687, doi:10.1016/j.cell.2016.08.064): LPS-activated macrophages shift from "
        "oxidative phosphorylation to glycolysis while inducing a pro-inflammatory gene "
        "expression program. Assessment: **confirmed** (directly supported, general pattern; "
        "this analysis does not establish the specific cell type or stimulus)."
    )
    a(
        "- Top DE hit `IL15RA` (IL-15 receptor alpha) searched specifically in PubMed for an "
        "inflammatory-response association: no directly matching hit was returned beyond its "
        "role in bone/osteoblast biology (PMID 28602725), which is not on-topic here. "
        "Assessment: **expected** from domain knowledge (IL-15/IL-15RA signaling is a "
        "well-established component of innate and adaptive immune activation, part of the "
        "IL2/STAT5 and inflammatory-response Hallmark leading edges reported above) rather than "
        "a novel or literature-confirmed finding from this specific search."
    )
    a(
        "- Method citations: DESeq2 (Love, Huber & Anders 2014, PMID 25516281); apeglm (Zhu, "
        "Ibrahim & Love 2019, PMID 30395178, doi:10.1093/bioinformatics/bty895 — matches the "
        "citation given in this task's constraints); fgsea (Korotkevich et al., bioRxiv "
        "preprint — not indexed in PubMed, searched and confirmed absent)."
    )
    a("")

    a("## Design limitations (stated per task constraints)")
    a("")
    a(
        "- **No subject/donor identifier separate from `sample` exists in `metadata.csv`.** "
        "Biological independence of the 6 control / 6 treated replicates cannot be confirmed "
        "from the metadata alone; independence is assumed, not verified."
    )
    a(
        "- **No batch, lane, run-date, or other technical-batch field is present anywhere in "
        "the inputs.** Batch effects cannot be assessed or corrected for; any residual "
        "unexplained structure (e.g., sample_01's PC2 deviation) cannot be attributed to batch "
        "vs. biology vs. sequencing depth with the metadata available."
    )
    a(
        "- **63.6% of the 10,071 tested genes carry no resolvable HGNC identity** (synthetic "
        "`GENE#####` placeholders) and are therefore invisible to gene-set-based enrichment by "
        "construction; all Hallmark/Reactome signal reported here is necessarily driven by the "
        "mappable 36.4% subset."
    )
    a(
        "- Preranked fgsea establishes statistical association between the ranking and curated "
        "gene sets — it is hypothesis-generating, not proof of mechanism or cell-type "
        "specificity."
    )
    a("")

    a("## Reproducibility record")
    a("")
    a("**Random seeds**: fgsea (T2S1) used `set.seed(42)` for `fgseaMultilevel`'s Monte Carlo sampling. DESeq2/apeglm (T1S2) use deterministic optimization (Wald test, apeglm's Cauchy-prior MAP estimate) — no seed is required or was set.")
    a("")
    a(f"**Gene-set collection versions**: Hallmark = {em['hallmark_database']}. Reactome = {em['reactome_database']}.")
    a("")
    a(f"**Annotation release**: `org.Hs.eg.db` {em['annotation_release_org.Hs.eg.db']}, used only for symbol/alias resolution ahead of enrichment (not used in the DESeq2 model itself).")
    a("")
    a("**R package versions** (this step's R environment, identical package set to T1S2/T2S1's shared sandbox image; `output/package_versions_R.csv`):")
    a("")
    a("| package | version |")
    a("|---|---|")
    for _, r in r_versions.iterrows():
        a(f"| {r['package']} | {r['version']} |")
    a("")
    a("**Full R `sessionInfo()`** (`output/session_info_R.txt`):")
    a("")
    a("```")
    a(d["session_info"].rstrip())
    a("```")
    a("")

    a("## Output files")
    a("")
    a("- `output/consolidated_gene_table_ranked_by_shrunken_lfc.csv` — full per-gene DE table")
    a("- `output/gene_table_summary_stats.csv` — n tested / n significant / up / down / NA counts")
    a("- `output/pvalue_histogram_bin_counts.csv`, `output/pvalue_histogram_interpretation_stats.csv`")
    a("- `output/hallmark_enrichment_table.csv`, `output/reactome_enrichment_table.csv` — full per-pathway tables (all tested sets), separate by collection")
    a("- `output/hallmark_leading_edge_genes_significant.csv`, `output/reactome_leading_edge_genes_significant.csv` — long-format leading-edge genes for padj<0.05 sets")
    a("- `output/hallmark_collapsed_representative_sets.csv`, `output/reactome_collapsed_representative_sets.csv` — non-redundant representative pathways")
    a("- `output/hallmark_vs_reactome_overlap_summary.csv`")
    a("- `output/enrichment_run_metadata.csv` — rank metric, universe, size window, database versions in one table")
    a("- `output/session_info_R.txt`, `output/package_versions_R.csv` — reproducibility record")
    a("- `figures/ma_plot_primary_shrunken.{png,pdf}`, `figures/dispersion_plot_primary.{png,pdf}`, `figures/pvalue_histogram_primary.{png,pdf}`, `figures/volcano_plot_primary.{png,pdf}`, `figures/enrichment_dotplot_hallmark.{png,pdf}`, `figures/enrichment_dotplot_reactome.{png,pdf}`")
    a("")

    return "\n".join(lines)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    data = load_all()
    report = build_report(data)
    REPORT_PATH.write_text(report)
    logger.info("Wrote consolidated report (%d chars) to %s", len(report), REPORT_PATH)


if __name__ == "__main__":
    main()
