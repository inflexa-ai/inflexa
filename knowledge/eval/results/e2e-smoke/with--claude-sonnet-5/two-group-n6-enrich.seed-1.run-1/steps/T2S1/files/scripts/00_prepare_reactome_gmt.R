#!/usr/bin/env Rscript
# 00_prepare_reactome_gmt.R
#
# Filters the Reactome GMT (which the reference store ships as a zip-compressed
# .gmt file, and whose description warns it "covers every Reactome species in
# one file") down to Homo sapiens, by joining pathway stable IDs against
# ReactomePathways.txt (stable ID, display name, species). Writes a plain-text
# GMT of human-only pathways for fgsea to consume.

suppressPackageStartupMessages({
  library(data.table)
})

# ── Parameters ───────────────────────────────────────────────────────────────
REACTOME_GMT_RAW   <- "/mnt/refs/managed/reactome-pathways/current/ReactomePathways.gmt"
REACTOME_INDEX_TXT <- "/mnt/refs/managed/reactome-pathways/current/ReactomePathways.txt"
REACTOME_RELEASE   <- "Reactome pathways, release 'current' (host-provisioned snapshot; Reactome overwrites this quarterly)"
TARGET_SPECIES     <- "Homo sapiens"
WORK_DIR           <- "output/_reactome_extract"
OUTPUT_GMT         <- "output/reactome_pathways_human.gmt"
OUTPUT_SUMMARY     <- "output/reactome_gmt_prep_summary.json"

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create(WORK_DIR, showWarnings = FALSE, recursive = TRUE)

# ── Extract (the .gmt on disk is a zip archive around a plain-text .gmt) ─────
message("Inspecting ", REACTOME_GMT_RAW)
file_type <- system2("file", c("-b", REACTOME_GMT_RAW), stdout = TRUE)
message("File type: ", file_type)

if (grepl("Zip archive", file_type, ignore.case = TRUE)) {
  message("Unzipping into ", WORK_DIR)
  unzip(REACTOME_GMT_RAW, exdir = WORK_DIR, overwrite = TRUE)
  extracted <- list.files(WORK_DIR, pattern = "\\.gmt$", full.names = TRUE)
  if (length(extracted) == 0) stop("No .gmt member found after unzipping ", REACTOME_GMT_RAW)
  gmt_text_path <- extracted[[1]]
} else {
  gmt_text_path <- REACTOME_GMT_RAW
}
message("Reading plain-text GMT from ", gmt_text_path)

# ── Read the raw GMT (ragged rows: name, id, gene1..geneN) ───────────────────
raw_lines <- readLines(gmt_text_path, warn = FALSE)
raw_lines <- raw_lines[nzchar(raw_lines)]
n_raw <- length(raw_lines)
message("Raw GMT: ", n_raw, " pathway lines")

split_fields <- strsplit(raw_lines, "\t")
pathway_ids <- vapply(split_fields, function(f) f[2], character(1))

# ── Human species index ───────────────────────────────────────────────────────
message("Reading species index from ", REACTOME_INDEX_TXT)
idx <- fread(REACTOME_INDEX_TXT, header = FALSE, sep = "\t",
             col.names = c("stable_id", "display_name", "species"), quote = "")
human_ids <- unique(idx$stable_id[idx$species == TARGET_SPECIES])
message("Species index: ", nrow(idx), " rows total, ", length(human_ids), " ", TARGET_SPECIES, " pathway IDs")

# ── Filter and write ──────────────────────────────────────────────────────────
keep <- pathway_ids %in% human_ids
n_kept <- sum(keep)
n_dropped <- n_raw - n_kept
message("Filtering to ", TARGET_SPECIES, ": ", n_kept, " of ", n_raw, " pathway lines kept; ", n_dropped, " dropped (other species or unindexed)")

writeLines(raw_lines[keep], OUTPUT_GMT)
message("Wrote human-only Reactome GMT to ", OUTPUT_GMT)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  source_gmt = REACTOME_GMT_RAW,
  source_index = REACTOME_INDEX_TXT,
  release = REACTOME_RELEASE,
  target_species = TARGET_SPECIES,
  n_pathways_raw_gmt = n_raw,
  n_pathways_human_index = length(human_ids),
  n_pathways_kept = n_kept,
  n_pathways_dropped = n_dropped,
  output_gmt = OUTPUT_GMT
)
jsonlite::write_json(summary_record, OUTPUT_SUMMARY, auto_unbox = TRUE, pretty = TRUE, digits = NA)
message("Done.")
