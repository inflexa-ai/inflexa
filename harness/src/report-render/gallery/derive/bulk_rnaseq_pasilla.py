# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pydeseq2",
#   "pandas",
#   "numpy",
#   "scipy",
# ]
# ///
"""Pasilla (Brooks et al. 2011) bulk RNA-seq DE analysis with pydeseq2.

Source: Bioconductor `pasilla` experiment-data package, extracted at
raw/bulk_rnaseq/pasilla/inst/extdata/. Design: ~condition, contrast
treated vs untreated (Drosophila melanogaster Pasilla RNAi knock-down).

Gene symbols come from FlyBase's own bulk correspondence table
(raw/bulk_rnaseq/fbgn_annotation_ID_fb_2026_03.tsv.gz, release FB2026_03),
downloaded once from https://s3ftp.flybase.org/releases/FB2026_03/
precomputed_files/genes/fbgn_annotation_ID_fb_2026_03.tsv.gz. Ensembl
BioMart (www.ensembl.org/biomart, which currently 308-redirects to
jun2026.archive.ensembl.org) and the Ensembl REST /lookup/id bulk
endpoint were tried first, as the task suggests, but both returned
HTTP 429/500/timeout errors for every request during this run (checked
with plain, query-free pings, not just our own query) -- a live EBI/
Ensembl-side outage, not a bug in this script. FlyBase is the primary
source of these FBgn identifiers, so its own table is used instead, per
the task's "or another real mapping source" fallback.

Re-running this script reproduces the same output: pydeseq2's DESeq2
port has no internal random sampling in the fit path used here, and the
only other randomness (PCA/clustering sign, size-factor tie-breaks) is
deterministic linear algebra, so no seed is required for pydeseq2 itself.
A seed is still set for numpy for defense in depth.
"""

import gzip

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import leaves_list, linkage
from scipy.spatial.distance import pdist, squareform

from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

np.random.seed(0)

RAW_DIR = "gallery-data/raw/bulk_rnaseq/pasilla/inst/extdata"
FLYBASE_MAP_PATH = (
    "gallery-data/raw/bulk_rnaseq/"
    "fbgn_annotation_ID_fb_2026_03.tsv.gz"
)
OUT_DIR = "gallery-data/derived/bulk_rnaseq"


def load_counts_and_metadata():
    counts = pd.read_csv(f"{RAW_DIR}/pasilla_gene_counts.tsv", sep="\t", index_col=0)
    ann = pd.read_csv(f"{RAW_DIR}/pasilla_sample_annotation.csv")
    ann["sample"] = ann["file"].str.replace("fb$", "", regex=True)
    ann = ann.set_index("sample")
    metadata = ann.loc[counts.columns, ["condition", "type"]].copy()
    metadata["condition"] = metadata["condition"].astype(str)
    metadata["type"] = metadata["type"].astype(str)
    return counts, metadata


def load_flybase_symbol_map():
    """Parse FlyBase's bulk FBgn<->annotation-ID table (columns: gene_symbol,
    organism_abbreviation, primary_FBgn#, secondary_FBgn#(s), annotation_ID,
    secondary_annotation_ID(s)) into an FBgn -> gene_symbol dict.

    The pasilla counts (2011 data) use some FBgn IDs that FlyBase has since
    merged into a current gene record. Such an old ID shows up only in the
    secondary_FBgn#(s) column, so map secondary IDs to the same symbol too,
    preferring a gene's own primary-ID mapping when both are present.
    """
    primary_map, secondary_map = {}, {}
    with gzip.open(FLYBASE_MAP_PATH, "rt") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            symbol, _organism, primary, secondary = parts[0], parts[1], parts[2], parts[3]
            primary_map[primary] = symbol
            for sec_id in secondary.split(","):
                sec_id = sec_id.strip()
                if sec_id:
                    secondary_map.setdefault(sec_id, symbol)
    return primary_map, secondary_map


def map_gene_symbols(gene_ids):
    primary_map, secondary_map = load_flybase_symbol_map()
    mapping = {}
    for gid in gene_ids:
        if gid in primary_map:
            mapping[gid] = primary_map[gid]
        elif gid in secondary_map:
            mapping[gid] = secondary_map[gid]
    return mapping


def main():
    counts, metadata = load_counts_and_metadata()

    genes_to_keep = counts.index[counts.sum(axis=1) >= 10]
    counts_filt = counts.loc[genes_to_keep]
    counts_df = counts_filt.T  # samples x genes, as pydeseq2 expects

    dds = DeseqDataSet(
        counts=counts_df,
        metadata=metadata,
        design="~condition",
        refit_cooks=True,
        quiet=True,
    )
    dds.deseq2()

    stats = DeseqStats(dds, contrast=["condition", "treated", "untreated"], quiet=True)
    stats.summary()
    res = stats.results_df.copy()
    res.index.name = "gene_id"

    fbgn_to_symbol = map_gene_symbols(res.index)
    res.insert(0, "gene_symbol", res.index.map(fbgn_to_symbol).fillna(""))
    res = res.reset_index()

    de_path = f"{OUT_DIR}/de_results.csv"
    res.to_csv(de_path, index=False)

    # display_label: gene_symbol, falling back to the FBgn gene_id when no
    # symbol was mapped. Used only for picking/labeling genes in
    # heatmap_top_genes.csv and top_gene_counts.csv, so every gene selected
    # by padj/log2FoldChange there -- mapped or not -- gets a usable row
    # label. de_results.csv itself, written just above, keeps gene_symbol
    # blank for the 36 unmapped genes; it is not touched by this column.
    res["display_label"] = res["gene_symbol"].where(res["gene_symbol"] != "", res["gene_id"])

    # ---- normalized counts (size-factor normalized, linear scale) ----
    normed = pd.DataFrame(
        dds.layers["normed_counts"], index=dds.obs_names, columns=dds.var_names
    )

    # ---- VST matrix for PCA / sample distances ----
    dds.vst(use_design=False)
    vst = pd.DataFrame(dds.layers["vst_counts"], index=dds.obs_names, columns=dds.var_names)

    # ---- PCA on top-500 most-variable genes (DESeq2::plotPCA convention) ----
    gene_var = vst.var(axis=0, ddof=1).sort_values(ascending=False)
    top500 = gene_var.index[:500]
    X = vst[top500].to_numpy()
    Xc = X - X.mean(axis=0)
    U, S, _Vt = np.linalg.svd(Xc, full_matrices=False)
    scores = U * S
    percent_var = (S**2) / np.sum(S**2) * 100

    pca_df = pd.DataFrame(
        {
            "sample": vst.index,
            "PC1": scores[:, 0],
            "PC2": scores[:, 1],
            "condition": metadata.loc[vst.index, "condition"].values,
            "type": metadata.loc[vst.index, "type"].values,
        }
    )
    pca_df.to_csv(f"{OUT_DIR}/pca_samples.csv", index=False)
    pc1_pct = round(float(percent_var[0]), 2)
    pc2_pct = round(float(percent_var[1]), 2)

    # ---- sample-to-sample distances on the full VST matrix (all filtered genes) ----
    dmat = squareform(pdist(vst.to_numpy(), metric="euclidean"))
    link = linkage(pdist(vst.to_numpy(), metric="euclidean"), method="complete")
    order = leaves_list(link)
    samples = vst.index.to_numpy()
    ordered_samples = samples[order]
    order_rank = {s: i for i, s in enumerate(ordered_samples)}

    rows = []
    for i, a in enumerate(samples):
        for j, b in enumerate(samples):
            rows.append(
                {
                    "sample_a": a,
                    "sample_b": b,
                    "distance": dmat[i, j],
                    "row_order": order_rank[a],
                    "col_order": order_rank[b],
                }
            )
    sample_dist_df = pd.DataFrame(rows)
    sample_dist_df.to_csv(f"{OUT_DIR}/sample_distances.csv", index=False)

    # ---- heatmap of top 40 DE genes (|log2FC|>1, ranked by padj) ----
    candidates = res[
        res["padj"].notna() & (res["log2FoldChange"].abs() > 1)
    ].sort_values("padj")
    top40 = candidates.head(40)

    log_norm = np.log2(normed[top40["gene_id"]] + 1)  # samples x genes
    z = (log_norm - log_norm.mean(axis=0)) / log_norm.std(axis=0, ddof=1)
    z_by_gene = z.T  # genes x samples
    z_by_gene.index = top40["display_label"].values

    gene_link = linkage(pdist(z_by_gene.to_numpy(), metric="euclidean"), method="average")
    gene_order_idx = leaves_list(gene_link)
    sample_link = linkage(pdist(z_by_gene.T.to_numpy(), metric="euclidean"), method="average")
    sample_order_idx = leaves_list(sample_link)

    gene_symbols = z_by_gene.index.to_numpy()
    ordered_genes = gene_symbols[gene_order_idx]
    gene_rank = {g: i for i, g in enumerate(ordered_genes)}
    ordered_samples_hm = z_by_gene.columns.to_numpy()[sample_order_idx]
    sample_rank_hm = {s: i for i, s in enumerate(ordered_samples_hm)}

    hm_rows = []
    for gsym in z_by_gene.index:
        for samp in z_by_gene.columns:
            hm_rows.append(
                {
                    "gene_symbol": gsym,
                    "sample": samp,
                    "zscore": z_by_gene.loc[gsym, samp],
                    "gene_order": gene_rank[gsym],
                    "sample_order": sample_rank_hm[samp],
                    "condition": metadata.loc[samp, "condition"],
                    "type": metadata.loc[samp, "type"],
                }
            )
    heatmap_df = pd.DataFrame(hm_rows)
    heatmap_df.to_csv(f"{OUT_DIR}/heatmap_top_genes.csv", index=False)

    # ---- top 6 DE genes by padj, normalized counts per sample ----
    top6 = res[res["padj"].notna()].sort_values("padj").head(6)
    tg_rows = []
    for _, row in top6.iterrows():
        gid, gsym = row["gene_id"], row["display_label"]
        for samp in normed.index:
            tg_rows.append(
                {
                    "gene_symbol": gsym,
                    "sample": samp,
                    "normalized_count": normed.loc[samp, gid],
                    "condition": metadata.loc[samp, "condition"],
                    "type": metadata.loc[samp, "type"],
                }
            )
    top_counts_df = pd.DataFrame(tg_rows)
    top_counts_df.to_csv(f"{OUT_DIR}/top_gene_counts.csv", index=False)

    print(f"de_results: {len(res)} genes tested")
    print(f"PC1 {pc1_pct}% / PC2 {pc2_pct}% variance explained (top-500-variable-gene VST PCA)")
    print(f"heatmap genes: {len(top40)}")
    print(f"top6 DE genes: {list(top6['display_label'])}")


if __name__ == "__main__":
    main()
