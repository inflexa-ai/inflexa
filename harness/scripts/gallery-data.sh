#!/usr/bin/env bash
#
# Rebuild the tables of the figure gallery from their public sources.
#
# The gallery tables are not in the repository. This script downloads each raw
# input, checks it against the SHA-256 that the script pins, runs each
# derivation script of src/report-render/gallery/derive/, thins the derived
# tables, and checks each table against the SHA-256 of its entry in
# src/report-render/gallery/manifest.json. The gallery tests pin the same
# bytes, thus a table that does not match fails the run.
#
#   bun run gallery:data
#
# Environment:
#   GALLERY_DATA_WORK_DIR  the raw downloads and the derived tables
#                          (default: harness/.gallery-data)
#   GALLERY_DATA_OUT_DIR   the gallery tables
#                          (default: harness/src/report-render/gallery/data)
#
# A second run downloads only a raw file that is missing or whose checksum does
# not match. The run writes the output directory only after each table matches
# the manifest, thus a failed run leaves the old tables in place.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GALLERY_DIR="$HARNESS_DIR/src/report-render/gallery"
DERIVE_DIR="$GALLERY_DIR/derive"
MANIFEST="$GALLERY_DIR/manifest.json"
WORK_DIR="${GALLERY_DATA_WORK_DIR:-$HARNESS_DIR/.gallery-data}"
OUT_DIR="${GALLERY_DATA_OUT_DIR:-$GALLERY_DIR/data}"
MAX_DOWNLOAD_BYTES=$((500 * 1024 * 1024))

# <path under WORK_DIR/raw> <sha256> <url>. Each URL names a fixed version of
# its source, thus its bytes do not change.
DOWNLOADS=(
    "bulk_rnaseq/pasilla_1.40.0.tar.gz 75122d45eb2c415d3e94d1b9bc9e4f6978c4504ef7e70f6bfeccb20547cb3db5 https://bioconductor.org/packages/3.23/data/experiment/src/contrib/pasilla_1.40.0.tar.gz"
    "bulk_rnaseq/fbgn_annotation_ID_fb_2026_03.tsv.gz 368327a0c41eadf3606cdc3f9ac75918f4c99dff7cf33c07d1d50904fb757aaf https://s3ftp.flybase.org/releases/FB2026_03/precomputed_files/genes/fbgn_annotation_ID_fb_2026_03.tsv.gz"
    "enrichment/GO_Biological_Process_2018_Fly.txt d6f89f518d0f04d792535f6e6f7cbc3ba422cc1cecb0b4f7ff6563c99e80101a https://maayanlab.cloud/FlyEnrichr/geneSetLibrary?mode=text&libraryName=GO_Biological_Process_2018"
    "singlecell/pbmc3k_processed.h5ad 0db367b991dd95809732b218539ede489bea99113807f62ebd7ccc970025fe38 https://raw.githubusercontent.com/chanzuckerberg/cellxgene/68dfbcc2eb675e96c6a5e2a6b7a0d3465ccf46bc/example-dataset/pbmc3k.h5ad"
    "singlecell/kang_2018.h5ad e6a5adac64dcdeb36eaba27db49b63e0c64bb0ed4a64c6705971506b41c39830 https://scverse-exampledata.s3.eu-west-1.amazonaws.com/pertpy/kang_2018.h5ad"
    "gwas/25673413-GCST002783-EFO_0004340.h.tsv.gz 8454077c4aac4174f9792027fe1aa0bbe20f74c564e900881f71197afd00848d https://ftp.ebi.ac.uk/pub/databases/gwas/summary_statistics/GCST002001-GCST003000/GCST002783/harmonised/25673413-GCST002783-EFO_0004340.h.tsv.gz"
    "cancer_mut/tcga_laml.maf.gz d102b071a052265b6f8ad7947bad1d58d3e3036fd17d6b274f7ea09a376cd6a0 https://raw.githubusercontent.com/PoisonAlien/maftools/0d61807f9a9863adb9335cb45f4c771b1f4c69e3/inst/extdata/tcga_laml.maf.gz"
    "cancer_mut/uniprot_Q9Y6K1_v213.txt 349a417e948db4893fd1593ec41f7fc3361fd2519147f5e77891c57bc4fe27ec https://rest.uniprot.org/unisave/Q9Y6K1?format=txt&versions=213"
    "cancer_mut/uniprot_P36888_v226.txt e35ca4ff20352705ed40f7549752b460b2ca39d830904135b9bae70be7eb0a28 https://rest.uniprot.org/unisave/P36888?format=txt&versions=226"
)

# The derivation scripts, in order: the enrichment reads the output of the bulk
# RNA-seq script.
STEPS=(
    bulk_rnaseq_pasilla.py
    enrichment_pasilla.py
    pbmc3k.py
    kang_composition.py
    survival_lung.R
    survival_roc.R
    gwas_bmi.py
    tcga_laml.py
)

fail() {
    echo "gallery-data: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || fail "the tool $1 is missing. $2"
}

need curl "Install curl."
need tar "Install tar."
need uv "Install uv from https://docs.astral.sh/uv/."
need Rscript "Install R from https://www.r-project.org/."
if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    fail "the tool sha256sum or shasum is missing. Install coreutils or perl."
fi
Rscript -e 'suppressPackageStartupMessages(library(survival))' >/dev/null 2>&1 ||
    fail "the R package survival is missing. Install it with: Rscript -e 'install.packages(\"survival\")'"

mkdir -p "$WORK_DIR/raw"
WORK_DIR="$(cd "$WORK_DIR" && pwd)"
SUMMARY=()

echo "gallery-data: work dir $WORK_DIR"
for download in "${DOWNLOADS[@]}"; do
    read -r path expected url <<<"$download"
    dest="$WORK_DIR/raw/$path"
    mkdir -p "$(dirname "$dest")"
    if [[ -f $dest && "$(sha256 "$dest")" == "$expected" ]]; then
        SUMMARY+=("cached      $(wc -c <"$dest" | tr -d ' ') bytes  raw/$path")
        continue
    fi
    echo "gallery-data: download $url"
    curl --fail --silent --show-error --location --retry 3 --max-filesize "$MAX_DOWNLOAD_BYTES" \
        --output "$dest.part" "$url" ||
        fail "the download of $url failed (a file over $MAX_DOWNLOAD_BYTES bytes also fails)."
    actual="$(sha256 "$dest.part")"
    if [[ $actual != "$expected" ]]; then
        rm -f "$dest.part"
        fail "the SHA-256 of $url is $actual, and the script pins $expected. The source changed. Do a check of the source before you change the pin."
    fi
    mv "$dest.part" "$dest"
    SUMMARY+=("downloaded  $(wc -c <"$dest" | tr -d ' ') bytes  raw/$path")
done

# The pasilla package is a tarball. Its count tables sit under pasilla/inst/extdata/.
rm -rf "$WORK_DIR/raw/bulk_rnaseq/pasilla"
tar -xzf "$WORK_DIR/raw/bulk_rnaseq/pasilla_1.40.0.tar.gz" -C "$WORK_DIR/raw/bulk_rnaseq"

rm -rf "$WORK_DIR/derived"
for step in "${STEPS[@]}"; do
    echo "gallery-data: run derive/$step"
    case "$step" in
        *.py) uv run --quiet --script "$DERIVE_DIR/$step" "$WORK_DIR" >"$WORK_DIR/$step.log" 2>&1 ;;
        *.R) Rscript "$DERIVE_DIR/$step" "$WORK_DIR" >"$WORK_DIR/$step.log" 2>&1 ;;
    esac || fail "derive/$step failed. Read $WORK_DIR/$step.log."
done

STAGE_DIR="$WORK_DIR/gallery"
rm -rf "$STAGE_DIR"
echo "gallery-data: thin the tables and check them against the manifest"
uv run --quiet --script "$DERIVE_DIR/thin_gallery.py" "$WORK_DIR" "$STAGE_DIR" "$MANIFEST" ||
    fail "a table does not match the manifest. The tables are in $STAGE_DIR, and the output directory did not change."

[[ -n $OUT_DIR && $OUT_DIR != "/" ]] || fail "GALLERY_DATA_OUT_DIR is not a directory that the script can replace."
rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
cp -R "$STAGE_DIR" "$OUT_DIR"

echo
echo "gallery-data: raw inputs"
printf '  %s\n' "${SUMMARY[@]}"
echo "gallery-data: $(find "$OUT_DIR" -type f -name '*.csv' | wc -l | tr -d ' ') tables match the manifest, in $OUT_DIR"
