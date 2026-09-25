# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas>=2.0", "numpy>=1.24", "requests"]
# [tool.uv]
# exclude-newer = "2026-09-25T00:00:00Z"
# ///
"""Build the E4 LocusZoom tables for the FTO locus of the Locke et al. 2015
BMI GWAS (GCST002783), the same GRCh38-harmonised study gwas_bmi.py reads.

Usage: uv run locuszoom_gwas.py <gallery-data work dir>

Reads raw/gwas/25673413-GCST002783-EFO_0004340.h.tsv.gz (already staged for
gwas_bmi.py; GRCh38 per hm_pos) and filters to every variant within +/-400kb
of the window's lead variant on chromosome 16 (unthinned: 813 rows). The
lead variant is picked as the row of smallest p-value in that window, which
this run confirms is rs1421085 at position 53767042 -- the FTO first-intron
SNP the task names.

Design-doc source for r2 and the gene track is the Ensembl REST API
(rest.ensembl.org, GRCh38): /ld/human/... and /overlap/region/human/....
That host returned HTTP 500 on every endpoint tried (info/ping included, no
query parameters) across several retries spread over ~5 minutes during this
run, including a plain unauthenticated ping -- the same kind of live
Ensembl/EBI-side outage bulk_rnaseq_pasilla.py's docstring records for its
own Ensembl BioMart/REST calls, not a bug in this script. grch37.rest.ensembl.org
(the wrong build) answered fine, confirming the outage is host-specific, not
a general network failure. Two real, build-matched substitutes stand in:

- r2: computed directly from the 1000 Genomes high-coverage GRCh38 callset
  (raw/gwas/genetic_map/plink.GRCh38.map.zip's sibling data source: the New
  York Genome Center's 30x remapping of the original phase-3 samples),
  streamed for this window only over HTTP with a remote tabix range query
  (bcftools), restricted to the phase-3 EUR super-population
  (raw/gwas/integrated_call_samples_v3.20130502.ALL.panel, 503 samples --
  the same "1000GENOMES:phase_3:EUR" panel Ensembl's own LD endpoint uses).
  r2 = D^2 / (pA(1-pA) * pB(1-pB)) on phased haplotypes (2 per sample),
  computed against the lead variant's haplotype vector. A GWAS variant with
  no matching biallelic-SNP position in this window's 1000G callset, or
  monomorphic in EUR, gets an empty r2 (this run: see the printed summary
  for the exact count).
- gene track: UCSC's REST API (api.genome.ucsc.edu, a separate service from
  EBI/Ensembl), track ncbiRefSeqCurated, hg38 (GRCh38). Rows are collapsed
  from transcript- to gene-level (min txStart, max txEnd per name2) and
  restricted to the NM_ (protein-coding, curated) prefix, dropping NR_
  (non-coding) and predicted XM_/XR_ entries -- RefSeq's protein-coding
  gene set, not Ensembl's, so a gene boundary can differ slightly from what
  Ensembl's overlap/region would have given.

recomb_rate is not part of that substitution: the task's own example source
(a HapMap-based genetic map that Beagle publishes) is used as specified.
raw/gwas/genetic_map/plink.GRCh38.map.zip holds
no_chr_in_chrom_field/plink.chr16.GRCh38.map (chrom, marker, cM, bp). The
rate (cM/Mb) at a query position is the local slope between the two
bracketing map markers: (cM[i+1]-cM[i]) / (bp[i+1]-bp[i]) * 1e6.

Deterministic given the two live data sources: no random sampling in this
script. The bcftools query and the UCSC REST call can return different
bytes only if the upstream 1000G callset or hg38 ncbiRefSeqCurated track is
revised.
"""

import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

WORK_DIR = Path(sys.argv[1]).resolve()
RAW_GWAS = WORK_DIR / "raw" / "gwas"
GWAS_FILE = RAW_GWAS / "25673413-GCST002783-EFO_0004340.h.tsv.gz"
EUR_PANEL_FILE = RAW_GWAS / "integrated_call_samples_v3.20130502.ALL.panel"
GENETIC_MAP_ZIP = RAW_GWAS / "genetic_map" / "plink.GRCh38.map.zip"
GENETIC_MAP_MEMBER = "no_chr_in_chrom_field/plink.chr16.GRCh38.map"
OUT_DIR = WORK_DIR / "derived" / "gwas"
OUT_DIR.mkdir(parents=True, exist_ok=True)

CHROM = "16"
WINDOW_HALF_WIDTH = 400_000
VCF_URL = (
    "http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000G_2504_high_coverage/"
    "working/20220422_3202_phased_SNV_INDEL_SV/"
    "1kGP_high_coverage_Illumina.chr16.filtered.SNV_INDEL_SV_phased_panel.vcf.gz"
)
UCSC_API = "https://api.genome.ucsc.edu/getData/track"


def load_window_variants() -> tuple[pd.DataFrame, int, int, str]:
    """Every GWAS row on chr16 within +/-400kb of the region's own lead SNP.

    Two-pass: first pass over the whole file finds the min-p row on chr16 to
    seed the window center (the lead is not known a priori), second pass
    (a cheap re-scan, the same streamed-chunk pattern gwas_bmi.py uses)
    collects every row in the resolved window.
    """
    chunks = []
    for chunk in pd.read_csv(
        GWAS_FILE,
        sep="\t",
        usecols=["hm_rsid", "hm_chrom", "hm_pos", "p_value"],
        chunksize=250_000,
        dtype={"hm_chrom": str},
        na_values="NA",
        compression="gzip",
    ):
        chunks.append(chunk[chunk["hm_chrom"] == CHROM])
    chr_df = pd.concat(chunks, ignore_index=True)
    total_chr16_rows = len(chr_df)

    lead_row = chr_df.loc[chr_df["p_value"].idxmin()]
    lead_pos = int(lead_row["hm_pos"])
    lead_rsid = str(lead_row["hm_rsid"])

    window = chr_df[
        (chr_df["hm_pos"] >= lead_pos - WINDOW_HALF_WIDTH)
        & (chr_df["hm_pos"] <= lead_pos + WINDOW_HALF_WIDTH)
    ].copy()
    window = window.rename(columns={"hm_rsid": "variant", "hm_pos": "position", "p_value": "pvalue"})
    window = window[["variant", "position", "pvalue"]].sort_values("position").reset_index(drop=True)
    # hm_pos is float64 in the source file (some rows elsewhere lack a
    # harmonised position), but every row in this window has one; cast back
    # to int64 so position writes as a plain integer, not %.6g-truncated
    # scientific notation.
    window["position"] = window["position"].astype("int64")
    return window, lead_pos, total_chr16_rows, lead_rsid


def compute_r2(window: pd.DataFrame, lead_pos: int) -> tuple[pd.Series, int, int, int]:
    """r2 of every window variant against the lead variant, from 1000G EUR haplotypes."""
    eur_panel = pd.read_csv(EUR_PANEL_FILE, sep="\t")
    eur_samples = eur_panel.loc[eur_panel["super_pop"] == "EUR", "sample"].tolist()
    eur_samples_path = RAW_GWAS / "_eur_samples.txt"
    eur_samples_path.write_text("\n".join(eur_samples) + "\n")

    region = f"chr{CHROM}:{lead_pos - WINDOW_HALF_WIDTH}-{lead_pos + WINDOW_HALF_WIDTH}"
    view_argv = [
        "bcftools", "view", "-Ou", "-r", region, "-S", str(eur_samples_path),
        "-m2", "-M2", "-v", "snps", VCF_URL,
    ]
    query_argv = ["bcftools", "query", "-f", "%POS\t%ID[\t%GT]\n", "-"]
    # cwd=RAW_GWAS: htslib caches the remote VCF's .tbi index as a local file
    # named after the URL, in the process's cwd.
    view_proc = subprocess.Popen(view_argv, stdout=subprocess.PIPE, cwd=str(RAW_GWAS))
    query_proc = subprocess.Popen(
        query_argv, stdin=view_proc.stdout, stdout=subprocess.PIPE, text=True, cwd=str(RAW_GWAS)
    )
    view_proc.stdout.close()  # let view_proc receive SIGPIPE if query_proc exits early
    stdout, _ = query_proc.communicate()
    view_proc.wait()
    eur_samples_path.unlink()
    if view_proc.returncode != 0:
        raise RuntimeError(f"bcftools view exited {view_proc.returncode}")
    if query_proc.returncode != 0:
        raise RuntimeError(f"bcftools query exited {query_proc.returncode}")

    positions: list[int] = []
    haplotypes: list[np.ndarray] = []
    for line in stdout.splitlines():
        parts = line.split("\t")
        pos = int(parts[0])
        gts = parts[2:]
        alleles = np.empty(len(gts) * 2, dtype=np.int8)
        ok = True
        for i, gt in enumerate(gts):
            a, sep, b = gt.partition("|")
            if not sep or a not in ("0", "1") or b not in ("0", "1"):
                ok = False
                break
            alleles[2 * i] = int(a)
            alleles[2 * i + 1] = int(b)
        if not ok:
            continue  # unphased or missing call at this site; excluded from the LD panel
        positions.append(pos)
        haplotypes.append(alleles)

    pos_to_hap = {}
    for pos, hap in zip(positions, haplotypes):
        pos_to_hap.setdefault(pos, []).append(hap)  # collect duplicates (split multiallelics)
    n_dup_positions = sum(1 for v in pos_to_hap.values() if len(v) > 1)

    if lead_pos not in pos_to_hap or len(pos_to_hap[lead_pos]) != 1:
        raise RuntimeError(
            f"lead position {lead_pos} not found as exactly one biallelic EUR SNP record in the 1000G window"
        )
    lead_hap = pos_to_hap[lead_pos][0].astype(np.float64)
    p_lead = lead_hap.mean()

    r2_by_pos: dict[int, float] = {}
    n_monomorphic = 0
    for pos, haps in pos_to_hap.items():
        if len(haps) != 1:
            continue  # ambiguous: more than one biallelic SNP record at this position
        h = haps[0].astype(np.float64)
        p = h.mean()
        if p == 0.0 or p == 1.0 or p_lead == 0.0 or p_lead == 1.0:
            n_monomorphic += 1
            continue
        pab = (h * lead_hap).mean()
        d = pab - p * p_lead
        denom = p * (1 - p) * p_lead * (1 - p_lead)
        r2_by_pos[pos] = float(d * d / denom)

    matched = window["position"].map(r2_by_pos)
    n_matched = matched.notna().sum()
    n_vcf_variants = len(pos_to_hap)
    return matched, n_matched, n_vcf_variants, n_dup_positions


def compute_recomb_rate(window: pd.DataFrame) -> pd.Series:
    with zipfile.ZipFile(GENETIC_MAP_ZIP) as zf:
        with zf.open(GENETIC_MAP_MEMBER) as fh:
            gmap = pd.read_csv(
                fh, sep=r"\s+", header=None, names=["chrom", "marker", "cm", "bp"]
            )
    gmap = gmap.sort_values("bp").drop_duplicates("bp").reset_index(drop=True)
    bp = gmap["bp"].to_numpy()
    cm = gmap["cm"].to_numpy()

    query = window["position"].to_numpy()
    # idx: index of the first map marker with bp >= query; clip so both the
    # marker at idx and at idx-1 exist (flat extrapolation past either edge).
    idx = np.searchsorted(bp, query, side="left")
    idx = np.clip(idx, 1, len(bp) - 1)
    bp_lo, bp_hi = bp[idx - 1], bp[idx]
    cm_lo, cm_hi = cm[idx - 1], cm[idx]
    rate = (cm_hi - cm_lo) / (bp_hi - bp_lo) * 1_000_000
    return pd.Series(rate, index=window.index)


def fetch_protein_coding_genes(lead_pos: int) -> pd.DataFrame:
    start, end = lead_pos - WINDOW_HALF_WIDTH, lead_pos + WINDOW_HALF_WIDTH
    resp = requests.get(
        UCSC_API,
        params={"genome": "hg38", "track": "ncbiRefSeqCurated", "chrom": f"chr{CHROM}", "start": start, "end": end},
        timeout=30,
    )
    resp.raise_for_status()
    records = resp.json()["ncbiRefSeqCurated"]

    genes: dict[str, dict] = {}
    for rec in records:
        if not rec["name"].startswith("NM_"):
            continue
        name = rec["name2"]
        g = genes.setdefault(name, {"start": rec["txStart"], "end": rec["txEnd"], "strand": rec["strand"]})
        g["start"] = min(g["start"], rec["txStart"])
        g["end"] = max(g["end"], rec["txEnd"])

    rows = [{"start": v["start"], "end": v["end"], "gene": g, "strand": v["strand"]} for g, v in genes.items()]
    return pd.DataFrame(rows, columns=["start", "end", "gene", "strand"]).sort_values("start").reset_index(drop=True)


def main() -> None:
    window, lead_pos, total_chr16_rows, lead_rsid = load_window_variants()

    r2, n_matched, n_vcf_variants, n_dup_positions = compute_r2(window, lead_pos)
    recomb_rate = compute_recomb_rate(window)

    locus = window.copy()
    locus["r2"] = r2
    locus["recomb_rate"] = recomb_rate
    locus_path = OUT_DIR / "locus_fto.csv"
    locus.to_csv(locus_path, index=False, float_format="%.6g")

    genes = fetch_protein_coding_genes(lead_pos)
    genes_path = OUT_DIR / "locus_fto_genes.csv"
    genes.to_csv(genes_path, index=False)

    summary = pd.DataFrame(
        {
            "lead_variant": [lead_rsid],
            "chrom": [CHROM],
            "window_start": [lead_pos - WINDOW_HALF_WIDTH],
            "window_end": [lead_pos + WINDOW_HALF_WIDTH],
            "ld_panel": ["1000GENOMES:phase_3:EUR (n=503), NYGC 30x GRCh38 high-coverage callset"],
            "build": ["GRCh38"],
        }
    )
    summary_path = OUT_DIR / "locus_fto_summary.csv"
    summary.to_csv(summary_path, index=False)

    print(f"chr{CHROM} rows in the raw GWAS file: {total_chr16_rows}")
    print(f"lead variant: {lead_rsid} at {lead_pos} (min p in the resolved window)")
    print(f"locus_fto.csv: {len(locus)} rows (unthinned), {locus_path.stat().st_size} bytes")
    print(f"  r2 matched to a 1000G EUR biallelic SNP: {n_matched} / {len(locus)}")
    print(f"  1000G EUR biallelic SNP positions in this window: {n_vcf_variants}")
    print(f"  positions with >1 biallelic SNP record (ambiguous, r2 left empty): {n_dup_positions}")
    print(f"locus_fto_genes.csv: {len(genes)} protein-coding genes, {genes_path.stat().st_size} bytes")
    print(list(genes["gene"]))
    print(f"locus_fto_summary.csv: {summary_path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
