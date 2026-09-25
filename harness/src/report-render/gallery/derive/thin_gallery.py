# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.24"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""
Copy the derived tables that the report gallery binds into a gallery data
directory, thin the dense ones by the rule of their field, and check each
table against the gallery manifest.

Usage:
    uv run thin_gallery.py <work dir> <data dir> <manifest> [--write-manifest]

<work dir> holds derived/<field>/<table>.csv, the output of the other scripts
in this directory. The script writes <data dir>/<field>/<table>.csv. Then it
compares the rows, the bytes, the SHA-256, and the thinning rule of each table
with its entry in <manifest>, prints each difference, and exits 1 if one
exists. With --write-manifest, it writes these values into <manifest> instead,
and keeps the dataset, the license, the sources, and the derivation of each
entry.

Each kept cell keeps the exact text of its source cell, so a thinned table
holds no re-serialized number. Each random choice uses a fixed seed, so a
second run writes the same bytes.

scripts/gallery-data.sh runs the other scripts of this directory and then this
one. Each other script takes the work dir as its one argument, reads
raw/<field>/, and writes derived/<field>/ under it.
"""
import csv
import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np

SEED = 20260925
KANG_CELLS_PER_CONDITION = 3000
MANHATTAN_P_THRESHOLD = 1e-3
MANHATTAN_BULK_KEEP = 4000
QQ_STRONGEST = 2000
QQ_EVEN_TARGETS = 1500
GSEA_EVERY_KTH_RANK = 25


def read_lines(path: Path) -> tuple[str, list[str]]:
    """The header line and the data lines of one CSV, each with its line end."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    return lines[0], lines[1:]


def parse(line: str) -> list[str]:
    return next(csv.reader(io.StringIO(line)))


def whole(lines: list[str], header: list[str]) -> tuple[list[str], str | None]:
    return lines, None


def project(header_line: str, lines: list[str], keep: list[str]) -> tuple[str, list[str]]:
    """Keep the named columns of each line. Each kept cell keeps its source text."""
    header = parse(header_line)
    at = [header.index(name) for name in keep]

    def line_of(cells: list[str]) -> str:
        out = io.StringIO()
        csv.writer(out, lineterminator="\n").writerow(cells)
        return out.getvalue()

    return line_of(keep), [line_of([row[i] for i in at]) for row in (parse(line) for line in lines)]


def thin_kang(lines: list[str], header: list[str]) -> tuple[list[str], str]:
    condition = header.index("condition")
    rng = np.random.default_rng(SEED)
    keep: list[int] = []
    for value in sorted({parse(line)[condition] for line in lines}):
        members = [i for i, line in enumerate(lines) if parse(line)[condition] == value]
        chosen = rng.choice(len(members), size=min(KANG_CELLS_PER_CONDITION, len(members)), replace=False)
        keep.extend(members[j] for j in chosen)
    keep.sort()
    rule = (
        f"Seeded subsample balanced by condition: numpy default_rng(seed={SEED}) chooses "
        f"{KANG_CELLS_PER_CONDITION} cells of each condition without replacement from the "
        f"{len(lines)} cells of the source table, and the kept rows keep the source order."
    )
    return [lines[i] for i in keep], rule


def thin_manhattan(lines: list[str], header: list[str]) -> tuple[list[str], str]:
    p = header.index("pvalue")
    strong = [i for i, line in enumerate(lines) if float(parse(line)[p]) < MANHATTAN_P_THRESHOLD]
    strong_set = set(strong)
    rest = [i for i in range(len(lines)) if i not in strong_set]
    rng = np.random.default_rng(SEED)
    sampled = sorted(rest[j] for j in rng.choice(len(rest), size=min(MANHATTAN_BULK_KEEP, len(rest)), replace=False))
    keep = sorted(strong + sampled)
    rule = (
        f"Keep every variant with p < {MANHATTAN_P_THRESHOLD:g} ({len(strong)} rows), plus a seeded sample "
        f"(numpy default_rng(seed={SEED})) of {len(sampled)} of the other {len(rest)} rows of the source table, "
        "which is itself a seeded sample of the full summary statistics. The kept rows keep the source order."
    )
    return [lines[i] for i in keep], rule


def thin_qq(lines: list[str], header: list[str]) -> tuple[list[str], str]:
    expected_col = header.index("expected_neg_log10_p")
    observed_col = header.index("observed_neg_log10_p")
    expected = np.array([float(parse(line)[expected_col]) for line in lines])
    observed = np.array([float(parse(line)[observed_col]) for line in lines])
    # A stable sort on the negated value keeps the source order inside a tie.
    by_strength = np.argsort(-observed, kind="stable")
    strongest = set(int(i) for i in by_strength[:QQ_STRONGEST])
    rest = np.array([i for i in range(len(lines)) if i not in strongest])
    rest_expected = expected[rest]
    order = np.argsort(rest_expected, kind="stable")
    sorted_expected = rest_expected[order]
    targets = np.linspace(sorted_expected[0], sorted_expected[-1], QQ_EVEN_TARGETS)
    picked: set[int] = set()
    for target in targets:
        at = int(np.searchsorted(sorted_expected, target))
        candidates = [c for c in (at - 1, at) if 0 <= c < len(sorted_expected)]
        nearest = min(candidates, key=lambda c: (abs(sorted_expected[c] - target), c))
        picked.add(int(rest[order[nearest]]))
    keep = sorted(strongest | picked)
    rule = (
        f"Keep the {QQ_STRONGEST} rows with the largest observed -log10 p, plus the row nearest to each of "
        f"{QQ_EVEN_TARGETS} evenly spaced values of the expected -log10 p over the other rows "
        f"({len(picked)} distinct rows). Each kept row keeps its band columns ci_lower and ci_upper, and the "
        "kept rows keep the source order."
    )
    return [lines[i] for i in keep], rule


def thin_gsea(lines: list[str], header: list[str]) -> tuple[list[str], str]:
    term_col, rank_col, es_col, hit_col = (header.index(name) for name in ("term", "rank", "running_es", "hit"))
    by_term: dict[str, list[int]] = {}
    for i, line in enumerate(lines):
        by_term.setdefault(parse(line)[term_col], []).append(i)
    keep: set[int] = set()
    for members in by_term.values():
        members.sort(key=lambda i: int(parse(lines[i])[rank_col]))
        es = [float(parse(lines[i])[es_col]) for i in members]
        for position, i in enumerate(members):
            row = parse(lines[i])
            first_or_last = position == 0 or position == len(members) - 1
            hit = row[hit_col] == "1"
            kth = (int(row[rank_col]) - 1) % GSEA_EVERY_KTH_RANK == 0
            extremum = False
            if 0 < position < len(members) - 1:
                before, here, after = es[position - 1], es[position], es[position + 1]
                extremum = (here >= before and here >= after) or (here <= before and here <= after)
            if first_or_last or hit or kth or extremum:
                keep.add(i)
    rule = (
        "For each term, keep the first and the last rank, every hit rank, each local extremum of the "
        f"running score (a rank whose score is at or above both neighbors, or at or below both), and every "
        f"{GSEA_EVERY_KTH_RANK}th rank from rank 1. The kept rows keep the source order."
    )
    return [lines[i] for i in sorted(keep)], rule


# The columns that a table keeps where the gallery binds a subset of them. A column that no chart reads and
# that holds a long gene list or an unused statistic leaves the copy, and the manifest names the cut.
COLUMN_CUTS = {
    ("enrichment", "ora_results"): ["term", "overlap", "set_size", "gene_ratio", "background_ratio", "pvalue", "padj"],
    ("enrichment", "gsea_results"): ["term", "NES", "ES", "pvalue", "fdr", "leading_edge_size"],
    ("gwas", "manhattan"): ["chrom", "pos", "snp", "pvalue", "cum_pos"],
}

# (field, table, script of the source table, thinning function)
TABLES = [
    ("bulk_rnaseq", "de_results", "bulk_rnaseq_pasilla.py", whole),
    ("bulk_rnaseq", "pca_samples", "bulk_rnaseq_pasilla.py", whole),
    ("bulk_rnaseq", "sample_distances", "bulk_rnaseq_pasilla.py", whole),
    ("bulk_rnaseq", "heatmap_top_genes", "bulk_rnaseq_pasilla.py", whole),
    ("bulk_rnaseq", "top_gene_counts", "bulk_rnaseq_pasilla.py", whole),
    ("enrichment", "ora_results", "enrichment_pasilla.py", whole),
    ("enrichment", "gsea_results", "enrichment_pasilla.py", whole),
    ("enrichment", "gsea_running_score", "enrichment_pasilla.py", thin_gsea),
    ("singlecell", "cells", "pbmc3k.py", whole),
    ("singlecell", "marker_dotplot", "pbmc3k.py", whole),
    ("singlecell", "composition", "kang_composition.py", whole),
    ("singlecell", "cells_by_condition_umap", "kang_composition.py", thin_kang),
    ("survival", "km_curve", "survival_lung.R", whole),
    ("survival", "km_risk_table", "survival_lung.R", whole),
    ("survival", "km_summary", "survival_lung.R", whole),
    ("survival", "logrank", "survival_lung.R", whole),
    ("survival", "cox_forest", "survival_lung.R", whole),
    ("survival", "roc", "survival_roc.R", whole),
    ("survival", "roc_auc", "survival_roc.R", whole),
    ("gwas", "manhattan", "gwas_bmi.py", thin_manhattan),
    ("gwas", "qq", "gwas_bmi.py", thin_qq),
    ("gwas", "qq_summary", "gwas_bmi.py", whole),
    ("cancer_mut", "oncoprint", "tcga_laml.py", whole),
    ("cancer_mut", "mutation_burden", "tcga_laml.py", whole),
    ("cancer_mut", "lollipop_DNMT3A", "tcga_laml.py", whole),
    ("cancer_mut", "domains_DNMT3A", "tcga_laml.py", whole),
    ("cancer_mut", "lollipop_FLT3", "tcga_laml.py", whole),
    ("cancer_mut", "domains_FLT3", "tcga_laml.py", whole),
]


CHECKED_KEYS = ("rows", "bytes", "sha256", "thinning")


def main() -> None:
    args = [arg for arg in sys.argv[1:] if arg != "--write-manifest"]
    write_manifest = len(args) != len(sys.argv) - 1
    if len(args) != 3:
        sys.exit(__doc__)
    work_dir, data_dir, manifest_path = (Path(arg).resolve() for arg in args)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    by_key = {(e["field"], e["table"]): e for e in manifest}

    entries = []
    total = 0
    for field, table, script, thin in TABLES:
        source = by_key[(field, table)]
        header_line, lines = read_lines(work_dir / "derived" / field / f"{table}.csv")
        columns = source["columns"]
        cut = COLUMN_CUTS.get((field, table))
        if cut is not None:
            dropped = [name for name in parse(header_line) if name not in cut]
            header_line, lines = project(header_line, lines, cut)
            columns = {name: meaning for name, meaning in columns.items() if name in cut}
        kept, rule = thin(lines, parse(header_line))
        if cut is not None:
            names = ", ".join(dropped)
            column_rule = f"The copy drops the column{'s' if len(dropped) > 1 else ''} {names}, which no gallery chart reads."
            rule = column_rule if rule is None else f"{rule} {column_rule}"
        out_path = data_dir / field / f"{table}.csv"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(header_line + "".join(kept), encoding="utf-8")
        content = out_path.read_bytes()
        total += len(content)
        entries.append(
            {
                "field": field,
                "table": table,
                "path": f"data/{field}/{table}.csv",
                "rows": len(kept),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "columns": columns,
                "dataset": source["dataset"],
                "license": source["license"],
                "source_urls": source["source_urls"],
                "script": f"derive/{script}",
                "derivation": source["derivation"],
                "thinning": rule
                if rule is not None
                else "None. The copy is the whole derived table.",
            }
        )

    if write_manifest:
        manifest_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"tables": len(entries), "total_bytes": total, "manifest": "written"}, indent=2))
        return

    produced = {(e["field"], e["table"]) for e in entries}
    mismatches = [f"{field}/{table}: the manifest names it, and no script makes it" for field, table in by_key if (field, table) not in produced]
    for entry in entries:
        expected = by_key[(entry["field"], entry["table"])]
        for key in CHECKED_KEYS:
            if entry[key] != expected.get(key):
                mismatches.append(f"{entry['path']}: {key} is {entry[key]!r}, the manifest states {expected.get(key)!r}")
    for mismatch in mismatches:
        print(f"MISMATCH {mismatch}", file=sys.stderr)
    print(json.dumps({"tables": len(entries), "total_bytes": total, "mismatches": len(mismatches)}, indent=2))
    if mismatches:
        sys.exit(1)


if __name__ == "__main__":
    main()
