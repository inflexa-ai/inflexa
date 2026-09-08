#!/usr/bin/env Rscript
# ============================================================================
# fgsea preranked GSEA: Hallmark and Reactome pathway enrichment
#
# Ranks all DESeq2-tested genes (treated vs control, primary contrast) by the
# Wald statistic ('stat' column, no padj/LFC pre-thresholding) and runs
# fgseaMultilevel against (1) MSigDB Hallmark human gene sets (50 sets) and
# (2) Reactome human pathway gene sets, both restricted to gene-set sizes
# 15-500 among the tested genes. Redundant significant gene sets are
# collapsed with fgsea::collapsePathways(). Hallmark and Reactome results are
# kept as two separate tables (never merged into one ranked list).
# ============================================================================

suppressPackageStartupMessages({
  library(data.table)
  library(fgsea)
  library(AnnotationDbi)
  library(org.Hs.eg.db)
  library(ggplot2)
  library(ggridges)
})

set.seed(42)

# ---- Parameters ------------------------------------------------------------
DE_RESULTS_PATH <- "/eval-u25-live-with-two-group-n6-enrich-s1-1/runs/6b692565-63c3-4c64-8953-bea66a07c077/T1S2/output/de_results_treated_vs_control_primary.csv"
HALLMARK_GMT_PATH <- "/mnt/refs/managed/msigdb-hallmark-human/2026.1/h.all.v2026.1.Hs.symbols.gmt"
REACTOME_GMT_ZIP_PATH <- "/mnt/refs/managed/reactome-pathways/current/ReactomePathways.gmt"
REACTOME_INDEX_PATH <- "/mnt/refs/managed/reactome-pathways/current/ReactomePathways.txt"
HALLMARK_RELEASE <- "MSigDB Hallmark human, release 2026.1 (h.all.v2026.1.Hs.symbols.gmt)"
REACTOME_RELEASE <- "Reactome pathways, 'current' release as staged in the reference store (quarterly rolling snapshot; no immutable version tag embedded in the download; restricted to Homo sapiens via ReactomePathways.txt)"

MIN_SIZE <- 15L
MAX_SIZE <- 500L
PADJ_THRESHOLD <- 0.05
NPROC <- 2L

OUTPUT_DIR <- "output"
FIG_DIR <- "figures"
LOG_DIR <- "logs"
SCRATCH_DIR <- file.path(tempdir(), "reactome_extracted")  # extraction cache only, not a deliverable
dir.create(OUTPUT_DIR, showWarnings = FALSE, recursive = TRUE)
dir.create(FIG_DIR, showWarnings = FALSE, recursive = TRUE)
dir.create(LOG_DIR, showWarnings = FALSE, recursive = TRUE)
dir.create(SCRATCH_DIR, showWarnings = FALSE, recursive = TRUE)

log_msg <- function(...) message(sprintf("[%s] %s", format(Sys.time(), "%H:%M:%S"), sprintf(...)))

# ---- 1. Load DESeq2 results --------------------------------------------------

#' Read the primary DESeq2 results table and keep gene + Wald statistic only.
#' No padj/LFC filtering is applied here -- every tested gene is kept.
load_de_results <- function(path) {
  dt <- fread(path)
  stopifnot(all(c("gene", "stat") %in% names(dt)))
  n_total <- nrow(dt)
  n_na_stat <- sum(is.na(dt$stat))
  n_dup_gene <- sum(duplicated(dt$gene))
  log_msg("Loaded DE results: %d rows, %d with NA stat, %d duplicated raw gene ids",
          n_total, n_na_stat, n_dup_gene)
  dt <- dt[!is.na(stat)]
  dt[, .(gene, stat)]
}

# ---- 2. Gene symbol identifier mapping (org.Hs.eg.db) -----------------------

#' Map raw gene symbols onto the HGNC symbol space used by the MSigDB/Reactome
#' GMTs. A symbol that is already an official org.Hs.eg.db SYMBOL is kept
#' as-is; a symbol that only matches as an alias is resolved to its official
#' symbol IF the alias is unambiguous (one target symbol); everything else
#' (including the synthetic 'GENE#####' placeholders in this dataset) is
#' reported unmapped. Unmapped genes are RETAINED in the ranked vector under
#' their original name so the full tested-gene background and rank order used
#' by fgsea's running-sum statistic is preserved (they simply never intersect
#' a pathway).
map_gene_symbols <- function(de_dt) {
  genes_raw <- de_dt$gene
  official_symbols <- AnnotationDbi::keys(org.Hs.eg.db, keytype = "SYMBOL")

  is_direct <- genes_raw %in% official_symbols
  status <- ifelse(is_direct, "direct_symbol", "unmapped")
  mapped_symbol <- ifelse(is_direct, genes_raw, NA_character_)

  to_try <- genes_raw[!is_direct]
  alias_status <- rep("unmapped_no_alias", length(to_try))
  alias_target <- rep(NA_character_, length(to_try))

  if (length(to_try) > 0) {
    alias_hits <- suppressMessages(
      AnnotationDbi::select(org.Hs.eg.db, keys = unique(to_try),
                             keytype = "ALIAS", columns = "SYMBOL")
    )
    alias_hits <- as.data.table(alias_hits)
    # drop the NA-SYMBOL rows select() returns for keys with NO alias hit at
    # all (e.g. this dataset's synthetic 'GENE#####' placeholders) -- those
    # rows must NOT count as a resolved (let alone unambiguous) match.
    alias_hits_valid <- alias_hits[!is.na(SYMBOL)]
    # keep only aliases that resolve to exactly one distinct official symbol
    n_targets <- alias_hits_valid[, .(n_symbols = uniqueN(SYMBOL)), by = ALIAS]
    unambiguous <- n_targets[n_symbols == 1, ALIAS]
    ambiguous <- n_targets[n_symbols > 1, ALIAS]
    lookup <- unique(alias_hits_valid[ALIAS %in% unambiguous, .(ALIAS, SYMBOL)])
    setkey(lookup, ALIAS)

    match_idx <- match(to_try, lookup$ALIAS)
    resolved <- !is.na(match_idx)
    alias_target[resolved] <- lookup$SYMBOL[match_idx[resolved]]
    alias_status[resolved] <- "alias_resolved"
    alias_status[to_try %in% ambiguous] <- "unmapped_ambiguous_alias"
  }

  status[!is_direct] <- alias_status
  mapped_symbol[!is_direct] <- alias_target

  out <- data.table(
    gene_raw = genes_raw,
    stat = de_dt$stat,
    mapping_status = status,
    mapped_symbol = mapped_symbol
  )
  # genes that never mapped keep their raw name as a placeholder identifier
  # in the ranked vector (unique, never collides with a real HGNC symbol,
  # and never intersects a pathway gene set).
  out[is.na(mapped_symbol), mapped_symbol := gene_raw]
  out
}

#' Collapse rows that share a mapped_symbol (two raw ids alias to the same
#' official symbol) by keeping the entry with the largest |stat|. Returns the
#' deduplicated table plus a count of dropped duplicate rows.
dedup_by_mapped_symbol <- function(mapped_dt) {
  dt <- copy(mapped_dt)  # never mutate the caller's table (data.table `:=` is by-reference)
  dt[, abs_stat := abs(stat)]
  setorder(dt, mapped_symbol, -abs_stat)
  n_before <- nrow(dt)
  deduped <- dt[!duplicated(mapped_symbol)]
  n_dropped <- n_before - nrow(deduped)
  deduped[, abs_stat := NULL]
  log_msg("Deduplication by mapped symbol: %d rows -> %d rows (%d duplicate collapses)",
          n_before, nrow(deduped), n_dropped)
  list(deduped = deduped, n_dropped = n_dropped)
}

#' Write the identifier-mapping report (unmapped share) required by the task.
write_mapping_report <- function(mapped_dt, n_dropped_dup, out_path) {
  n_total <- nrow(mapped_dt)
  summary_dt <- mapped_dt[, .N, by = mapping_status][order(-N)]
  summary_dt[, share := N / n_total]
  n_unmapped <- sum(mapped_dt$mapping_status %in%
                       c("unmapped", "unmapped_no_alias", "unmapped_ambiguous_alias"))
  report <- rbind(
    summary_dt,
    data.table(mapping_status = "TOTAL_TESTED_GENES", N = n_total, share = 1.0),
    data.table(mapping_status = "TOTAL_UNMAPPED", N = n_unmapped, share = n_unmapped / n_total),
    data.table(mapping_status = "DUPLICATE_SYMBOL_ROWS_DROPPED", N = n_dropped_dup,
               share = n_dropped_dup / n_total)
  )
  fwrite(report, out_path)
  log_msg("Unmapped share: %d / %d = %.1f%% of tested genes did not resolve to an HGNC symbol",
          n_unmapped, n_total, 100 * n_unmapped / n_total)
  fwrite(mapped_dt, file.path(OUTPUT_DIR, "gene_id_mapping_table.csv"))
  report
}

# ---- 3. Build the named ranked stats vector ---------------------------------

build_stats_vector <- function(deduped_dt) {
  setorder(deduped_dt, -stat)
  stats_vec <- deduped_dt$stat
  names(stats_vec) <- deduped_dt$mapped_symbol
  stopifnot(!any(duplicated(names(stats_vec))))
  fwrite(deduped_dt[, .(gene = mapped_symbol, stat)], file.path(OUTPUT_DIR, "ranked_gene_list_stat.csv"))
  stats_vec
}

# ---- 4. Gene set loading -----------------------------------------------------

load_hallmark_pathways <- function(gmt_path) {
  pw <- gmtPathways(gmt_path)
  log_msg("Loaded %d Hallmark gene sets from %s", length(pw), gmt_path)
  stopifnot(length(pw) == 50)
  pw
}

#' Unzip the (misleadingly-named .gmt but actually zip-archived) Reactome GMT
#' and restrict it to Homo sapiens pathways using ReactomePathways.txt.
load_reactome_human_pathways <- function(zip_path, index_path, scratch_dir) {
  unzip(zip_path, exdir = scratch_dir, overwrite = TRUE)
  extracted <- list.files(scratch_dir, pattern = "\\.gmt$", full.names = TRUE)
  stopifnot(length(extracted) == 1)
  gmt_text_path <- extracted[1]

  pw_all <- gmtPathways(gmt_text_path)
  log_msg("Reactome GMT (all species as shipped): %d pathways", length(pw_all))

  index_dt <- fread(index_path, header = FALSE,
                     col.names = c("stable_id", "pathway_name", "species"))
  human_ids <- index_dt[species == "Homo sapiens", stable_id]
  log_msg("Reactome species index: %d Homo sapiens pathway IDs", length(human_ids))

  # The GMT's 2nd column (source URL/description field for gmtPathways parsing)
  # is dropped by gmtPathways(); re-parse the raw lines to recover the
  # Reactome stable ID for each pathway name so we can join to the species index.
  raw_lines <- readLines(gmt_text_path)
  split_lines <- strsplit(raw_lines, "\t")
  pw_names <- vapply(split_lines, `[`, character(1), 1)
  pw_ids <- vapply(split_lines, `[`, character(1), 2)
  name_to_id <- setNames(pw_ids, pw_names)

  keep_names <- names(pw_all)[name_to_id[names(pw_all)] %in% human_ids]
  pw_human <- pw_all[keep_names]
  log_msg("Reactome pathways after Homo sapiens filter: %d (of %d shipped, %d human IDs in index)",
          length(pw_human), length(pw_all), length(human_ids))
  list(pathways = pw_human, name_to_id = name_to_id, n_shipped_all_species = length(pw_all))
}

# ---- 5. fgsea run -------------------------------------------------------------

run_fgsea <- function(pathways, stats_vec, min_size, max_size, nproc) {
  set.seed(42)
  res <- fgseaMultilevel(
    pathways = pathways,
    stats = stats_vec,
    minSize = min_size,
    maxSize = max_size,
    eps = 0,
    nproc = nproc
  )
  res <- as.data.table(res)
  res <- res[order(padj, -abs(NES))]
  res
}

leading_edge_to_string <- function(le_list) {
  vapply(le_list, function(x) paste(x, collapse = ";"), character(1))
}

#' Long-format leading-edge gene table for every pathway at padj < threshold.
build_leading_edge_table <- function(fgsea_res, padj_threshold) {
  sig <- fgsea_res[padj < padj_threshold]
  if (nrow(sig) == 0) return(data.table(pathway = character(), gene = character()))
  rbindlist(lapply(seq_len(nrow(sig)), function(i) {
    genes <- sig$leadingEdge[[i]]
    if (length(genes) == 0) return(NULL)
    data.table(pathway = sig$pathway[i], gene = genes)
  }))
}

# ---- 6. Redundancy collapsing -------------------------------------------------

#' Collapse redundant/overlapping significant gene sets via
#' fgsea::collapsePathways(), keeping a representative ("main") pathway per
#' redundant cluster. Returns the collapsed summary AND the full member table.
collapse_significant_pathways <- function(fgsea_res, pathways, stats_vec, padj_threshold, collection_label) {
  sig_res <- fgsea_res[padj < padj_threshold]
  if (nrow(sig_res) < 2) {
    log_msg("[%s] Fewer than 2 significant pathways (%d) -- skipping collapsePathways", collection_label, nrow(sig_res))
    main_pw <- sig_res$pathway
    members <- data.table(representative_pathway = main_pw, member_pathway = main_pw, is_representative = TRUE)
    summary_dt <- copy(sig_res)
    summary_dt[, is_representative := TRUE]
    summary_dt[, representative_pathway := pathway]
    return(list(summary = summary_dt, members = members))
  }
  set.seed(42)
  collapsed <- collapsePathways(sig_res, pathways = pathways, stats = stats_vec,
                                 pval.threshold = padj_threshold)
  main_pw <- collapsed$mainPathways
  parent_map <- collapsed$parentPathways  # named vector: child -> parent ("" if itself main)

  # Build representative assignment for every significant pathway
  rep_for <- function(p) {
    if (p %in% main_pw) return(p)
    parent <- parent_map[[p]]
    if (is.null(parent) || is.na(parent) || parent == "") return(p)
    parent
  }
  sig_res[, representative_pathway := vapply(pathway, rep_for, character(1))]
  sig_res[, is_representative := pathway %in% main_pw]

  members <- sig_res[, .(representative_pathway, member_pathway = pathway, is_representative)]
  summary_dt <- sig_res[order(representative_pathway, -is_representative, padj)]
  log_msg("[%s] collapsePathways: %d significant pathways collapsed to %d representative sets",
          collection_label, nrow(sig_res), length(main_pw))
  list(summary = summary_dt, members = members)
}

# ---- 7. Figures ----------------------------------------------------------------

make_dotplot <- function(fgsea_res, title, out_base, top_n = 20) {
  plot_dt <- copy(fgsea_res)[order(padj)][seq_len(min(top_n, .N))]
  if (nrow(plot_dt) == 0) return(invisible(NULL))
  plot_dt[, pathway_label := factor(pathway, levels = rev(pathway))]
  p <- ggplot(plot_dt, aes(x = NES, y = pathway_label, size = size, color = padj)) +
    geom_point() +
    scale_color_viridis_c(name = "BH padj", direction = -1) +
    scale_size_continuous(name = "Gene set\nsize") +
    labs(title = title, x = "Normalized Enrichment Score (NES)", y = NULL,
         subtitle = sprintf("Top %d pathways by BH-adjusted p-value", nrow(plot_dt))) +
    theme_minimal(base_size = 11) +
    theme(panel.grid.minor = element_blank())
  ggsave(paste0(out_base, ".png"), p, width = 9, height = max(4, 0.32 * nrow(plot_dt) + 1.5), dpi = 300)
  ggsave(paste0(out_base, ".pdf"), p, width = 9, height = max(4, 0.32 * nrow(plot_dt) + 1.5))
}

make_barplot <- function(fgsea_res, title, out_base, top_n = 20) {
  plot_dt <- copy(fgsea_res)[order(padj)][seq_len(min(top_n, .N))]
  if (nrow(plot_dt) == 0) return(invisible(NULL))
  plot_dt[, pathway_label := factor(pathway, levels = rev(pathway))]
  plot_dt[, direction := ifelse(NES > 0, "Up in treated", "Down in treated")]
  p <- ggplot(plot_dt, aes(x = NES, y = pathway_label, fill = direction)) +
    geom_col() +
    scale_fill_manual(values = c("Up in treated" = "#d55e00", "Down in treated" = "#0072b2"), name = NULL) +
    labs(title = title, x = "Normalized Enrichment Score (NES)", y = NULL,
         subtitle = sprintf("Top %d pathways by BH-adjusted p-value", nrow(plot_dt))) +
    theme_minimal(base_size = 11) +
    theme(panel.grid.minor = element_blank())
  ggsave(paste0(out_base, ".png"), p, width = 9, height = max(4, 0.32 * nrow(plot_dt) + 1.5), dpi = 300)
  ggsave(paste0(out_base, ".pdf"), p, width = 9, height = max(4, 0.32 * nrow(plot_dt) + 1.5))
}

make_ridgeplot <- function(fgsea_res, stats_vec, title, out_base, padj_threshold, top_n = 15) {
  sig <- fgsea_res[padj < padj_threshold][order(padj)][seq_len(min(top_n, .N))]
  if (nrow(sig) == 0) {
    log_msg("Ridgeplot skipped for '%s': no pathways at padj < %.2f", title, padj_threshold)
    return(invisible(NULL))
  }
  rows <- rbindlist(lapply(seq_len(nrow(sig)), function(i) {
    genes <- sig$leadingEdge[[i]]
    data.table(pathway = sig$pathway[i], stat = stats_vec[genes])
  }))
  rows[, pathway := factor(pathway, levels = rev(sig$pathway))]
  p <- ggplot(rows, aes(x = stat, y = pathway, fill = after_stat(x))) +
    geom_density_ridges_gradient(scale = 1.5, rel_min_height = 0.01) +
    scale_fill_viridis_c(name = "Wald\nstatistic") +
    labs(title = title, x = "Wald statistic (leading-edge genes)", y = NULL,
         subtitle = sprintf("Leading-edge Wald-statistic distribution, pathways at padj < %.2f", padj_threshold)) +
    theme_minimal(base_size = 11) +
    theme(panel.grid.minor = element_blank())
  ggsave(paste0(out_base, ".png"), p, width = 9, height = max(4, 0.4 * nrow(sig) + 1.5), dpi = 300)
  ggsave(paste0(out_base, ".pdf"), p, width = 9, height = max(4, 0.4 * nrow(sig) + 1.5))
}

make_upset <- function(fgsea_res, padj_threshold, title, out_base, top_n = 15) {
  sig <- fgsea_res[padj < padj_threshold][order(padj)][seq_len(min(top_n, .N))]
  if (nrow(sig) < 2) {
    log_msg("UpSet plot skipped for '%s': fewer than 2 pathways at padj < %.2f", title, padj_threshold)
    return(invisible(NULL))
  }
  all_genes <- unique(unlist(sig$leadingEdge))
  mem <- data.table(gene = all_genes)
  for (i in seq_len(nrow(sig))) {
    mem[, (sig$pathway[i]) := gene %in% sig$leadingEdge[[i]]]
  }
  set_cols <- sig$pathway
  p <- ComplexUpset::upset(mem, set_cols, name = "Leading-edge gene overlap",
                            min_size = 1, width_ratio = 0.25,
                            set_sizes = ComplexUpset::upset_set_size())
  ggsave(paste0(out_base, ".png"), p, width = 12, height = 7, dpi = 300)
  ggsave(paste0(out_base, ".pdf"), p, width = 12, height = 7)
}

make_cnetplot <- function(fgsea_res, padj_threshold, title, out_base, top_n = 10) {
  sig <- fgsea_res[padj < padj_threshold][order(padj)][seq_len(min(top_n, .N))]
  if (nrow(sig) == 0) {
    log_msg("cnetplot skipped for '%s': no pathways at padj < %.2f", title, padj_threshold)
    return(invisible(NULL))
  }
  edges <- rbindlist(lapply(seq_len(nrow(sig)), function(i) {
    genes <- sig$leadingEdge[[i]]
    data.table(from = sig$pathway[i], to = genes)
  }))
  g <- igraph::graph_from_data_frame(edges, directed = FALSE)
  node_type <- ifelse(igraph::V(g)$name %in% sig$pathway, "pathway", "gene")
  igraph::V(g)$type <- node_type
  nes_lookup <- setNames(sig$NES, sig$pathway)
  igraph::V(g)$NES <- ifelse(node_type == "pathway", nes_lookup[igraph::V(g)$name], NA_real_)
  p <- ggraph::ggraph(g, layout = "fr") +
    ggraph::geom_edge_link(alpha = 0.25, colour = "grey60") +
    ggraph::geom_node_point(aes(size = ifelse(node_type == "pathway", 8, 2),
                                 color = ifelse(node_type == "pathway", NES, NA)),
                             show.legend = c(size = FALSE, color = TRUE)) +
    ggraph::geom_node_text(aes(label = ifelse(node_type == "pathway", name, "")),
                            repel = TRUE, size = 3, fontface = "bold") +
    scale_color_viridis_c(name = "NES", na.value = "grey40") +
    labs(title = title, subtitle = sprintf("Top %d pathways at padj < %.2f, leading-edge genes", nrow(sig), padj_threshold)) +
    theme_void(base_size = 11)
  ggsave(paste0(out_base, ".png"), p, width = 11, height = 9, dpi = 300)
  ggsave(paste0(out_base, ".pdf"), p, width = 11, height = 9)
}

# ---- Main --------------------------------------------------------------------

main <- function() {
  log_msg("=== Loading DESeq2 primary results and ranking by Wald statistic ===")
  de_dt <- load_de_results(DE_RESULTS_PATH)

  log_msg("=== Mapping gene symbols to org.Hs.eg.db HGNC symbol space ===")
  mapped_dt <- map_gene_symbols(de_dt)
  dedup_out <- dedup_by_mapped_symbol(mapped_dt)
  deduped_dt <- dedup_out$deduped
  write_mapping_report(mapped_dt, dedup_out$n_dropped, file.path(OUTPUT_DIR, "id_mapping_report.csv"))

  stats_vec <- build_stats_vector(deduped_dt)
  log_msg("Ranked stats vector: %d genes, range [%.2f, %.2f]",
          length(stats_vec), min(stats_vec), max(stats_vec))

  # ---------------- Hallmark ----------------
  log_msg("=== Hallmark: loading gene sets ===")
  hallmark_pw <- load_hallmark_pathways(HALLMARK_GMT_PATH)
  overlap_h <- length(intersect(unlist(hallmark_pw), names(stats_vec)))
  log_msg("Hallmark: %d unique genes across 50 sets, %d intersect the ranked list", length(unique(unlist(hallmark_pw))), overlap_h)

  log_msg("=== Hallmark: running fgseaMultilevel ===")
  hallmark_res <- run_fgsea(hallmark_pw, stats_vec, MIN_SIZE, MAX_SIZE, NPROC)
  hallmark_res[, leadingEdge_str := leading_edge_to_string(leadingEdge)]
  hallmark_out <- copy(hallmark_res)
  hallmark_out[, leadingEdge := leadingEdge_str]
  hallmark_out[, leadingEdge_str := NULL]
  hallmark_out[, gene_set_collection := "msigdb_hallmark_human"]
  hallmark_out[, release := HALLMARK_RELEASE]
  fwrite(hallmark_out, file.path(OUTPUT_DIR, "fgsea_hallmark_results.csv"))

  hallmark_le <- build_leading_edge_table(hallmark_res, PADJ_THRESHOLD)
  fwrite(hallmark_le, file.path(OUTPUT_DIR, "fgsea_hallmark_leading_edge_padj0.05.csv"))

  hallmark_collapsed <- collapse_significant_pathways(hallmark_res, hallmark_pw, stats_vec, PADJ_THRESHOLD, "Hallmark")
  fwrite(hallmark_collapsed$summary, file.path(OUTPUT_DIR, "fgsea_hallmark_significant_collapsed_summary.csv"))
  fwrite(hallmark_collapsed$members, file.path(OUTPUT_DIR, "fgsea_hallmark_significant_collapsed_members_supplement.csv"))

  make_dotplot(hallmark_res, "Hallmark GSEA (preranked, Wald stat)", file.path(FIG_DIR, "enrichment_dotplot_hallmark"))
  make_barplot(hallmark_res, "Hallmark GSEA (preranked, Wald stat)", file.path(FIG_DIR, "enrichment_barplot_hallmark"))
  make_ridgeplot(hallmark_res, stats_vec, "Hallmark leading-edge Wald-statistic distribution", file.path(FIG_DIR, "enrichment_ridgeplot_hallmark"), PADJ_THRESHOLD)
  make_upset(hallmark_res, PADJ_THRESHOLD, "Hallmark leading-edge overlap", file.path(FIG_DIR, "enrichment_upset_hallmark"))
  make_cnetplot(hallmark_res, PADJ_THRESHOLD, "Hallmark pathway-gene network", file.path(FIG_DIR, "enrichment_network_hallmark"))

  # ---------------- Reactome ----------------
  log_msg("=== Reactome: extracting archive and filtering to Homo sapiens ===")
  reactome_out_list <- load_reactome_human_pathways(REACTOME_GMT_ZIP_PATH, REACTOME_INDEX_PATH, SCRATCH_DIR)
  reactome_pw <- reactome_out_list$pathways
  overlap_r <- length(intersect(unlist(reactome_pw), names(stats_vec)))
  log_msg("Reactome (human): %d unique genes across %d pathways, %d intersect the ranked list",
          length(unique(unlist(reactome_pw))), length(reactome_pw), overlap_r)

  log_msg("=== Reactome: running fgseaMultilevel ===")
  reactome_res <- run_fgsea(reactome_pw, stats_vec, MIN_SIZE, MAX_SIZE, NPROC)
  reactome_res[, leadingEdge_str := leading_edge_to_string(leadingEdge)]
  reactome_out <- copy(reactome_res)
  reactome_out[, leadingEdge := leadingEdge_str]
  reactome_out[, leadingEdge_str := NULL]
  reactome_out[, gene_set_collection := "reactome_pathways"]
  reactome_out[, release := REACTOME_RELEASE]
  fwrite(reactome_out, file.path(OUTPUT_DIR, "fgsea_reactome_results.csv"))

  reactome_le <- build_leading_edge_table(reactome_res, PADJ_THRESHOLD)
  fwrite(reactome_le, file.path(OUTPUT_DIR, "fgsea_reactome_leading_edge_padj0.05.csv"))

  reactome_collapsed <- collapse_significant_pathways(reactome_res, reactome_pw, stats_vec, PADJ_THRESHOLD, "Reactome")
  fwrite(reactome_collapsed$summary, file.path(OUTPUT_DIR, "fgsea_reactome_significant_collapsed_summary.csv"))
  fwrite(reactome_collapsed$members, file.path(OUTPUT_DIR, "fgsea_reactome_significant_collapsed_members_supplement.csv"))

  make_dotplot(reactome_res, "Reactome GSEA (preranked, Wald stat)", file.path(FIG_DIR, "enrichment_dotplot_reactome"))
  make_barplot(reactome_res, "Reactome GSEA (preranked, Wald stat)", file.path(FIG_DIR, "enrichment_barplot_reactome"))
  make_ridgeplot(reactome_res, stats_vec, "Reactome leading-edge Wald-statistic distribution", file.path(FIG_DIR, "enrichment_ridgeplot_reactome"), PADJ_THRESHOLD)
  make_upset(reactome_res, PADJ_THRESHOLD, "Reactome leading-edge overlap", file.path(FIG_DIR, "enrichment_upset_reactome"))
  make_cnetplot(reactome_res, PADJ_THRESHOLD, "Reactome pathway-gene network", file.path(FIG_DIR, "enrichment_network_reactome"))

  # ---------------- Hallmark vs Reactome overlap / disagreement ----------------
  log_msg("=== Comparing Hallmark and Reactome significant leading-edge gene overlap ===")
  h_sig_genes <- unique(unlist(hallmark_res[padj < PADJ_THRESHOLD]$leadingEdge))
  r_sig_genes <- unique(unlist(reactome_res[padj < PADJ_THRESHOLD]$leadingEdge))
  jaccard <- if (length(union(h_sig_genes, r_sig_genes)) > 0) {
    length(intersect(h_sig_genes, r_sig_genes)) / length(union(h_sig_genes, r_sig_genes))
  } else NA_real_
  overlap_summary <- data.table(
    metric = c("hallmark_n_significant_pathways", "reactome_n_significant_pathways",
               "hallmark_n_leading_edge_genes_union", "reactome_n_leading_edge_genes_union",
               "shared_leading_edge_genes", "jaccard_leading_edge_gene_overlap"),
    value = c(nrow(hallmark_res[padj < PADJ_THRESHOLD]), nrow(reactome_res[padj < PADJ_THRESHOLD]),
              length(h_sig_genes), length(r_sig_genes),
              length(intersect(h_sig_genes, r_sig_genes)), jaccard)
  )
  fwrite(overlap_summary, file.path(OUTPUT_DIR, "hallmark_vs_reactome_overlap_summary.csv"))

  # ---------------- Run-level summary JSON-ish CSV ----------------
  run_summary <- data.table(
    field = c("rank_metric", "n_tested_genes_ranked", "n_unmapped_genes", "unmapped_share",
              "n_duplicate_symbol_rows_dropped", "min_size", "max_size",
              "hallmark_n_sets_tested", "hallmark_n_sets_in_size_window", "hallmark_n_significant_padj0.05",
              "reactome_n_sets_shipped_all_species", "reactome_n_sets_human", "reactome_n_sets_in_size_window",
              "reactome_n_significant_padj0.05"),
    value = c("DESeq2 Wald statistic (stat column), primary contrast treated vs control",
              length(stats_vec),
              sum(mapped_dt$mapping_status %in% c("unmapped", "unmapped_no_alias", "unmapped_ambiguous_alias")),
              sprintf("%.4f", sum(mapped_dt$mapping_status %in% c("unmapped", "unmapped_no_alias", "unmapped_ambiguous_alias")) / nrow(mapped_dt)),
              dedup_out$n_dropped, MIN_SIZE, MAX_SIZE,
              length(hallmark_pw), nrow(hallmark_res), nrow(hallmark_res[padj < PADJ_THRESHOLD]),
              reactome_out_list$n_shipped_all_species, length(reactome_pw), nrow(reactome_res),
              nrow(reactome_res[padj < PADJ_THRESHOLD]))
  )
  fwrite(run_summary, file.path(OUTPUT_DIR, "run_parameters_summary.csv"))

  log_msg("=== Done ===")
}

main()
