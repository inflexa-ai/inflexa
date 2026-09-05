#!/usr/bin/env python3
# tpl-gseapy-preranked — gseapy preranked gene set enrichment analysis.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: preranked GSEA (Subramanian et al. 2005) on the full ranked list of
# tested genes, computed with gseapy.prerank, a gene set size window, gene set
# permutations for the p-value, and the GSEA FDR q-value as the adjusted
# p-value. The Python mirror of tpl-fgsea-preranked: the same slots, the same
# output names, and the same result columns.

import json
import math
import os
import platform
import sys

import gseapy
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# ── Parameters ────────────────────────────────────────────────────────────────
RESULTS_PATH = {{results_path}}  # [adaptable: results_path]
RANK_METRIC = {{rank_metric}}  # [adaptable: rank_metric]
GMT_PATH = {{gmt_path}}  # [adaptable: gmt_path]
MIN_SIZE = {{min_size}}  # [adaptable: min_size]
MAX_SIZE = {{max_size}}  # [adaptable: max_size]
PERMUTATION_NUM = {{permutation_num}}
SEED = {{seed}}  # [adaptable: seed]
OUTPUT_PREFIX = {{output_prefix}}  # [adaptable: output_prefix]
PADJ_CUTOFF = 0.05
N_TOP_SETS = 20
THREADS = 1


def message(*parts):
    print("".join(str(part) for part in parts), file=sys.stderr, flush=True)


def fail(*parts):
    message("Error: ", *parts)
    sys.exit(1)


os.makedirs("output", exist_ok=True)
os.makedirs("figures", exist_ok=True)


def out(name):
    return os.path.join("output", f"{OUTPUT_PREFIX}_{name}")


def fig(name):
    return os.path.join("figures", f"{OUTPUT_PREFIX}_{name}")


def save_figure(figure, name):
    figure.savefig(fig(f"{name}.png"), dpi=300, bbox_inches="tight")
    figure.savefig(fig(f"{name}.pdf"), bbox_inches="tight")
    plt.close(figure)


if MIN_SIZE > MAX_SIZE:
    fail(f"min_size ({MIN_SIZE}) is larger than max_size ({MAX_SIZE})")

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading the results table from ", RESULTS_PATH)
if not os.path.exists(RESULTS_PATH):
    fail("The results table does not exist: ", RESULTS_PATH)
results = pd.read_csv(RESULTS_PATH)
NEEDED = {
    "stat": ["gene", "stat"],
    "signed_log10_p": ["gene", "log2_fold_change", "pvalue"],
    "log2_fold_change": ["gene", "log2_fold_change"],
}
if RANK_METRIC not in NEEDED:
    fail("Unknown rank metric ", RANK_METRIC)
needed = NEEDED[RANK_METRIC]
absent = [column for column in needed if column not in results.columns]
if absent:
    fail(f"The rank metric {RANK_METRIC} needs the columns {', '.join(needed)} but the results table has no column {', '.join(absent)}")
results["gene"] = results["gene"].astype("string")
message("Results table: ", len(results), " genes, columns: ", ", ".join(results.columns))

message("Reading the gene sets from ", GMT_PATH)
if not os.path.exists(GMT_PATH):
    fail("The gene set file does not exist: ", GMT_PATH)
pathways = gseapy.parser.read_gmt(GMT_PATH)
if len(pathways) == 0:
    fail("The gene set file holds no gene set: ", GMT_PATH)
DATABASE = os.path.basename(GMT_PATH)
message("Gene sets: ", len(pathways), " in ", DATABASE)

# ── Ranking ───────────────────────────────────────────────────────────────────
if RANK_METRIC == "stat":
    score = pd.to_numeric(results["stat"], errors="coerce").to_numpy(dtype=float)
elif RANK_METRIC == "signed_log10_p":
    pvalue = pd.to_numeric(results["pvalue"], errors="coerce").to_numpy(dtype=float)
    positive = pvalue[np.isfinite(pvalue) & (pvalue > 0)]
    smallest = positive.min() if positive.size > 0 else sys.float_info.min
    pvalue = np.where(np.isfinite(pvalue) & (pvalue == 0), smallest, pvalue)
    lfc = pd.to_numeric(results["log2_fold_change"], errors="coerce").to_numpy(dtype=float)
    score = np.sign(lfc) * -np.log10(pvalue)
else:
    score = pd.to_numeric(results["log2_fold_change"], errors="coerce").to_numpy(dtype=float)

gene = results["gene"]
keep = gene.notna().to_numpy() & (gene.fillna("").str.len() > 0).to_numpy() & np.isfinite(score)
message("Ranking by ", RANK_METRIC, ": ", int(keep.sum()), " of ", len(results), " genes have a finite value; ", int((~keep).sum()), " dropped")
ranked = pd.DataFrame({"gene": gene[keep].astype(str).to_numpy(), "score": score[keep]})
if len(ranked) == 0:
    fail("No gene has a finite ", RANK_METRIC, " value")

n_duplicate = int(ranked["gene"].duplicated().sum())
if n_duplicate > 0:
    message("Duplicate gene identifiers: ", n_duplicate, "; the entry with the largest absolute score is kept")
    ranked = ranked.iloc[np.argsort(-np.abs(ranked["score"].to_numpy()), kind="stable")]
    ranked = ranked[~ranked["gene"].duplicated()]

rng = np.random.default_rng(SEED)
tied = ranked["score"].duplicated(keep=False).to_numpy()
if tied.any():
    jitter_scale = 1e-6 * (np.abs(ranked["score"].to_numpy()).max() + 1)
    ranked.loc[tied, "score"] = ranked.loc[tied, "score"].to_numpy() + rng.uniform(-jitter_scale, jitter_scale, int(tied.sum()))
    message("Tied scores: ", int(tied.sum()), " genes; the ties are broken with a jitter of at most ", f"{jitter_scale:.3g}")
ranks = pd.Series(ranked["score"].to_numpy(), index=ranked["gene"].to_numpy()).sort_values(ascending=False)

set_genes = set()
for members in pathways.values():
    set_genes.update(members)
n_in_sets = int(sum(1 for name in ranks.index if name in set_genes))
if n_in_sets == 0:
    fail("No ranked gene is a member of a gene set. The gene identifiers of the results table and of the GMT file do not match.")
message("Ranked genes: ", len(ranks), "; in at least one gene set: ", n_in_sets)

# ── Enrichment ────────────────────────────────────────────────────────────────
prerank = gseapy.prerank(
    rnk=ranks,
    gene_sets=GMT_PATH,
    min_size=MIN_SIZE,
    max_size=MAX_SIZE,
    permutation_num=PERMUTATION_NUM,
    seed=SEED,
    threads=THREADS,
    outdir=None,
    no_plot=True,
    verbose=False,
)
raw = prerank.res2d.copy()
size = raw["Tag %"].astype(str).str.split("/").str[1].astype(int)
results_table = pd.DataFrame(
    {
        "pathway": raw["Term"].astype(str).to_numpy(),
        "pvalue": pd.to_numeric(raw["NOM p-val"], errors="coerce").to_numpy(dtype=float),
        "padj": pd.to_numeric(raw["FDR q-val"], errors="coerce").to_numpy(dtype=float),
        "ES": pd.to_numeric(raw["ES"], errors="coerce").to_numpy(dtype=float),
        "NES": pd.to_numeric(raw["NES"], errors="coerce").to_numpy(dtype=float),
        "size": size.to_numpy(),
        "leading_edge": raw["Lead_genes"].fillna("").astype(str).to_numpy(),
    }
)
results_table = results_table.sort_values(["padj", "pvalue"], kind="stable").reset_index(drop=True)
n_tested = len(results_table)
significant_mask = results_table["padj"].notna() & (results_table["padj"] < PADJ_CUTOFF)
n_significant = int(significant_mask.sum())
n_up = int((significant_mask & (results_table["NES"] > 0)).sum())
n_down = n_significant - n_up
message("Tested ", n_tested, " of ", len(pathways), " sets with ", MIN_SIZE, " to ", MAX_SIZE, " ranked members; ",
        n_significant, " at padj < ", PADJ_CUTOFF, " (", n_up, " positive, ", n_down, " negative NES)")
results_table.to_csv(out("results.csv"), index=False)

# ── Figures ───────────────────────────────────────────────────────────────────
top_sets = results_table[results_table["padj"].notna()].head(N_TOP_SETS)
top_sets = top_sets.sort_values("NES", kind="stable")
height = max(4.0, 0.25 * len(top_sets) + 1.5)
figure, axis = plt.subplots(figsize=(8, height))
axis.axvline(0, linestyle="--", color="grey")
point_size = 10 + 60 * (top_sets["size"] - top_sets["size"].min()) / max(1, top_sets["size"].max() - top_sets["size"].min())
scatter = axis.scatter(top_sets["NES"], np.arange(len(top_sets)), s=point_size, c=top_sets["padj"], cmap="viridis_r")
axis.set_yticks(np.arange(len(top_sets)))
axis.set_yticklabels(top_sets["pathway"], fontsize=7)
axis.set_xlabel("Normalized enrichment score")
axis.set_title(f"Top {len(top_sets)} gene sets by adjusted p-value ({RANK_METRIC})")
figure.colorbar(scatter, ax=axis, label="padj")
save_figure(figure, "dot_plot")

significant_table = results_table[significant_mask].sort_values("NES", kind="stable")
if len(significant_table) > 0:
    height = max(4.0, 0.25 * len(significant_table) + 1.5)
    figure, axis = plt.subplots(figsize=(8, height))
    colors = ["#F98E09" if nes > 0 else "#3B528B" for nes in significant_table["NES"]]
    axis.barh(np.arange(len(significant_table)), significant_table["NES"], color=colors)
    axis.set_yticks(np.arange(len(significant_table)))
    axis.set_yticklabels(significant_table["pathway"], fontsize=7)
    axis.set_xlabel("Normalized enrichment score")
    axis.set_title(f"Gene sets at padj < {PADJ_CUTOFF} ({len(significant_table)})")
else:
    figure, axis = plt.subplots(figsize=(8, 4))
    axis.text(0.5, 0.5, f"No gene set at padj < {PADJ_CUTOFF}", ha="center", va="center")
    axis.set_axis_off()
    axis.set_title(f"Gene sets at padj < {PADJ_CUTOFF}")
save_figure(figure, "nes_bar_plot")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record = {
    "template": "tpl-gseapy-preranked@1.0.0",
    "method": "gseapy preranked GSEA",
    "inputs": {"results_path": RESULTS_PATH, "gmt_path": GMT_PATH},
    "database": DATABASE,
    "rank_metric": RANK_METRIC,
    "n_genes_input": int(len(results)),
    "n_genes_ranked": int(len(ranks)),
    "n_genes_in_sets": n_in_sets,
    "n_sets_input": len(pathways),
    "n_sets_tested": n_tested,
    "n_significant": n_significant,
    "n_up": n_up,
    "n_down": n_down,
    "padj_cutoff": PADJ_CUTOFF,
    "min_size": MIN_SIZE,
    "max_size": MAX_SIZE,
    "permutation_num": PERMUTATION_NUM,
    "seed": SEED,
    "versions": {
        "python": platform.python_version(),
        "gseapy": gseapy.__version__,
        "pandas": pd.__version__,
        "numpy": np.__version__,
        "matplotlib": matplotlib.__version__,
    },
}
with open(out("summary.json"), "w", encoding="utf-8") as handle:
    json.dump(summary_record, handle, indent=2)
with open(os.path.join("output", "session_info.txt"), "w", encoding="utf-8") as handle:
    handle.write(f"Python {sys.version}\n")
    for name, version in summary_record["versions"].items():
        if name != "python":
            handle.write(f"{name} {version}\n")
message("Done: ", out("results.csv"))
