# /// script
# dependencies = ["pandas", "numpy"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""
Build derived/cancer_mut/*.csv from the maftools tcga_laml example MAF
(TCGA LAML, Ley et al. NEJM 2013) and from UniProtKB (protein domain/region
boundaries for the two picked genes).

Usage: uv run tcga_laml.py <gallery-data work dir>

The UniProtKB input of each gene is one pinned version of its entry, in the
flat-file text form that the UniSave REST API serves
(https://rest.uniprot.org/unisave/<accession>?format=txt&versions=<version>).
scripts/gallery-data.sh downloads it to raw/cancer_mut/. A pinned version
never changes, whereas the live entry changes with each UniProt release.

Deterministic: no random sampling is performed. Tie-breaks in the gene and
sample ranking below are explicit (alphabetical gene symbol, then sample
barcode) so re-running gives the same output.
"""

import gzip
import json
import pathlib
import re
import sys

import pandas as pd

BASE = pathlib.Path(sys.argv[1])
RAW = BASE / "raw" / "cancer_mut"
DERIVED = BASE / "derived" / "cancer_mut"
DERIVED.mkdir(parents=True, exist_ok=True)

MAF_PATH = RAW / "tcga_laml.maf.gz"
TOP_N_GENES = 20
SECOND_GENE = "FLT3"  # more frequent than NPM1 in this cohort (52 vs 33 mutated samples); see report

AA_POS_RE = re.compile(r"p\.\D*?(\d+)")

# gene -> (reviewed human UniProtKB accession, pinned entry version). The
# versions are the current entries of UniProt release 2026_03.
UNIPROT_ENTRIES = {"DNMT3A": ("Q9Y6K1", 213), SECOND_GENE: ("P36888", 226)}
# The flat-file keys of the Domain and the Region features of the JSON form.
FEATURE_KEYS = {"DOMAIN", "REGION"}
LOCATION_RE = re.compile(r"(\d+)(?:\.\.(\d+))?")


def load_maf() -> pd.DataFrame:
    with gzip.open(MAF_PATH, "rt") as fh:
        return pd.read_csv(fh, sep="\t", dtype=str)


def build_oncoprint(maf: pd.DataFrame) -> tuple[pd.DataFrame, int, int]:
    gene_sample_sets = maf.groupby("Hugo_Symbol")["Tumor_Sample_Barcode"].agg(set)
    ranked_genes = sorted(
        gene_sample_sets.items(), key=lambda kv: (-len(kv[1]), kv[0])
    )
    top_genes = [g for g, _ in ranked_genes[:TOP_N_GENES]]
    gene_rank = {g: i + 1 for i, g in enumerate(top_genes)}

    top_maf = maf[maf["Hugo_Symbol"].isin(top_genes)]

    # A sample with more than one distinct Variant_Classification in the same
    # gene is coded "Multi_Hit", the standard oncoprint convention (also used
    # by maftools' own oncoplot) for a gene double-hit in one sample.
    pair_classes = top_maf.groupby(["Hugo_Symbol", "Tumor_Sample_Barcode"])[
        "Variant_Classification"
    ].agg(lambda s: "Multi_Hit" if s.nunique() > 1 else s.iloc[0])
    pairs = pair_classes.reset_index()
    pairs.columns = ["gene", "sample", "variant_classification"]

    all_samples = sorted(maf["Tumor_Sample_Barcode"].unique())
    mutated_pairs = set(zip(pairs["gene"], pairs["sample"]))
    burden_top = top_maf.groupby("Tumor_Sample_Barcode").size()

    def binary_vector(sample: str) -> tuple:
        return tuple(1 if (g, sample) in mutated_pairs else 0 for g in top_genes)

    ranked_samples = sorted(
        all_samples,
        key=lambda s: (
            tuple(-b for b in binary_vector(s)),
            -burden_top.get(s, 0),
            s,
        ),
    )
    sample_rank = {s: i + 1 for i, s in enumerate(ranked_samples)}

    pairs["gene_rank"] = pairs["gene"].map(gene_rank)
    pairs["sample_rank"] = pairs["sample"].map(sample_rank)

    # Every sample in the cohort gets at least one row so a chart can render
    # an empty/present column per sample. A sample with none of the top-20
    # genes mutated gets a placeholder row on the rank-1 gene with an empty
    # variant_classification; that gene value is not an actual mutation.
    mutated_samples = set(pairs["sample"])
    unmutated_samples = [s for s in all_samples if s not in mutated_samples]
    placeholder_rows = pd.DataFrame(
        {
            "gene": top_genes[0],
            "sample": unmutated_samples,
            "variant_classification": "",
            "gene_rank": 1,
            "sample_rank": [sample_rank[s] for s in unmutated_samples],
        }
    )
    pairs = pd.concat([pairs, placeholder_rows], ignore_index=True)

    pairs = pairs.sort_values(["gene_rank", "sample_rank"]).reset_index(drop=True)
    pairs = pairs[["gene", "sample", "variant_classification", "gene_rank", "sample_rank"]]
    return pairs, len(all_samples), len(unmutated_samples)


def build_mutation_burden(maf: pd.DataFrame) -> pd.DataFrame:
    burden = (
        maf.groupby("Tumor_Sample_Barcode")
        .size()
        .reset_index(name="n_mutations")
        .rename(columns={"Tumor_Sample_Barcode": "sample"})
        .sort_values("sample")
        .reset_index(drop=True)
    )
    return burden


def build_lollipop(maf: pd.DataFrame, gene: str) -> tuple[pd.DataFrame, int]:
    gene_maf = maf[maf["Hugo_Symbol"] == gene].copy()
    gene_maf["aa_position"] = gene_maf["Protein_Change"].apply(
        lambda v: (int(m.group(1)) if (m := AA_POS_RE.search(str(v))) else None)
    )
    dropped = int(gene_maf["aa_position"].isna().sum())
    parsed = gene_maf.dropna(subset=["aa_position"]).copy()
    parsed["aa_position"] = parsed["aa_position"].astype(int)

    grouped = (
        parsed.groupby(["aa_position", "Protein_Change", "Variant_Classification"])
        .size()
        .reset_index(name="count")
        .rename(
            columns={
                "Protein_Change": "protein_change",
                "Variant_Classification": "variant_classification",
            }
        )
        .sort_values(["aa_position", "protein_change"])
        .reset_index(drop=True)
    )
    return grouped, dropped


def uniprot_entry_path(gene: str) -> pathlib.Path:
    accession, version = UNIPROT_ENTRIES[gene]
    return RAW / f"uniprot_{accession}_v{version}.txt"


def read_uniprot_domains(path: pathlib.Path) -> tuple[pd.DataFrame, int]:
    """The Domain and Region features and the sequence length of one UniProtKB
    flat-file entry. A qualifier that wraps continues on the next FT line, and
    the lines join with one space, as the JSON form of the entry gives it."""
    features: list[dict] = []
    length = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("SQ   SEQUENCE"):
            length = int(line.split()[2])
        if not line.startswith("FT   "):
            continue
        key, body = line[5:21].strip(), line[21:].strip()
        if key:
            features.append({"key": key, "location": body, "qualifiers": []})
        elif body.startswith("/"):
            features[-1]["qualifiers"].append(body)
        else:
            features[-1]["qualifiers"][-1] += " " + body
    if length is None:
        raise RuntimeError(f"{path} holds no SQ line")
    rows = []
    for feat in features:
        if feat["key"] not in FEATURE_KEYS:
            continue
        match = LOCATION_RE.fullmatch(feat["location"])
        if match is None:
            raise RuntimeError(f"{path}: the location {feat['location']!r} is not an exact range")
        notes = [q[len('/note="') : -1] for q in feat["qualifiers"] if q.startswith('/note="')]
        rows.append(
            {
                "start": int(match.group(1)),
                "end": int(match.group(2) or match.group(1)),
                "name": notes[0] if notes else "",
            }
        )
    domains = pd.DataFrame(rows, columns=["start", "end", "name"]).sort_values(
        "start"
    ).reset_index(drop=True)
    domains["protein_length"] = length
    return domains, length


def write_csv(df: pd.DataFrame, name: str) -> pathlib.Path:
    path = DERIVED / name
    df.to_csv(path, index=False)
    return path


def main() -> None:
    maf = load_maf()

    oncoprint, cohort_size, n_placeholder = build_oncoprint(maf)
    write_csv(oncoprint, "oncoprint.csv")

    burden = build_mutation_burden(maf)
    write_csv(burden, "mutation_burden.csv")

    stats = {"cohort_size": cohort_size, "oncoprint_placeholder_rows": n_placeholder}

    for gene in ["DNMT3A", SECOND_GENE]:
        lollipop, dropped = build_lollipop(maf, gene)
        write_csv(lollipop, f"lollipop_{gene}.csv")
        stats[f"{gene}_dropped_unparseable"] = dropped

        accession, _version = UNIPROT_ENTRIES[gene]
        domains, length = read_uniprot_domains(uniprot_entry_path(gene))
        write_csv(domains, f"domains_{gene}.csv")
        stats[f"{gene}_uniprot_accession"] = accession
        stats[f"{gene}_protein_length"] = length
        stats[f"{gene}_n_domain_region_features"] = len(domains)

    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
