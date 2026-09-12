#!/usr/bin/env Rscript
# tpl-immunedeconv — cell type deconvolution of bulk RNA-seq with immunedeconv.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: one of five immunedeconv methods on a linear-scale expression matrix.
# MCP-counter (Becht et al. 2016) and xCell (Aran et al. 2017) give a score per
# cell type that is comparable between samples for one cell type and not between
# cell types. EPIC (Racle et al. 2017) and quanTIseq (Finotello et al. 2019) give
# an absolute fraction per cell type with an uncharacterized remainder, comparable
# between samples and between cell types (Sturm et al. 2019). These four carry
# human markers and human reference profiles, thus they take human samples only.
# mMCP-counter (Petitprez et al. 2020) scores a mouse sample with markers
# selected on mouse data, with the mouse symbols as they are. A Wilcoxon
# rank-sum test per cell type compares the two condition levels, with a BH
# correction.

suppressPackageStartupMessages({
  library(immunedeconv)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
EXPRESSION_PATH  <- {{expression_path}}  # [adaptable: expression_path]
METADATA_PATH    <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       <- {{test_level}}  # [adaptable: test_level]
INPUT_SCALE      <- {{input_scale}}  # [adaptable: input_scale] tpm: linear TPM; counts: raw counts, scaled to CPM below
METHOD           <- {{method}}  # [adaptable: method] mcp_counter, xcell, epic, or quantiseq for human; mmcp_counter for mouse
SPECIES          <- {{species}}  # [adaptable: species] human or mouse; the symbols are used as they are
TUMOR            <- {{tumor}}  # [adaptable: tumor] EPIC: TRef instead of BRef; quanTIseq: is_tumordata
ALPHA            <- {{alpha}}  # [adaptable: alpha]
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]

# The MCP-counter marker genes of Becht et al. 2016 (Signatures/genes.txt of
# the MCPcounter repository, HUGO symbols). MCPcounter 1.2 downloads this table
# at each call, and the sandbox has no network, thus the table lives here. The
# upstream row for Entrez 8436 (ENSG00000168497) carries the mangled symbol "C";
# it is written here under its current symbol CAVIN2.
MCP_COUNTER_MARKERS <- list(
  "T cells" = c("CD28", "CD3D", "CD3G", "CD5", "CD6", "CHRM3-AS2", "CTLA4", "FLT3LG", "ICOS", "MAL", "MGC40069", "PBX4", "SIRPG", "THEMIS", "TNFRSF25", "TRAT1"),
  "CD8 T cells" = c("CD8B"),
  "Cytotoxic lymphocytes" = c("CD8A", "EOMES", "FGFBP2", "GNLY", "KLRC3", "KLRC4", "KLRD1"),
  "B lineage" = c("BANK1", "CD19", "CD22", "CD79A", "CR2", "FCRL2", "IGKC", "MS4A1", "PAX5"),
  "NK cells" = c("CD160", "KIR2DL1", "KIR2DL3", "KIR2DL4", "KIR3DL1", "KIR3DS1", "NCR1", "PTGDR", "SH2D1B"),
  "Monocytic lineage" = c("ADAP2", "CSF1R", "FPR3", "KYNU", "PLA2G7", "RASSF4", "TFEC"),
  "Myeloid dendritic cells" = c("CD1A", "CD1B", "CD1E", "CLEC10A", "CLIC2", "WFDC21P"),
  "Neutrophils" = c("CA4", "CEACAM3", "CXCR1", "CXCR2", "CYP4F3", "FCGR3B", "HAL", "KCNJ15", "MEGF9", "SLC25A37", "STEAP4", "TECPR2", "TLE3", "TNFRSF10C", "VNN3"),
  "Endothelial cells" = c("ACVRL1", "APLN", "BCL6B", "BMP6", "BMX", "CDH5", "CLEC14A", "DIPK2B", "EDN1", "ADGRL4", "EMCN", "ESAM", "ESM1", "FAM124B", "HECW2", "HHIP", "KDR", "MMRN1", "MMRN2", "MYCT1", "PALMD", "PEAR1", "PGF", "PLXNA2", "PTPRB", "ROBO4", "CAVIN2", "SHANK3", "SHE", "TEK", "TIE1", "VEPH1", "VWF"),
  "Fibroblasts" = c("COL1A1", "COL3A1", "COL6A1", "COL6A2", "DCN", "GREM1", "PAMR1", "TAGLN")
)
XCELL_MIN_GENES <- 5000  # xCell::xCellAnalysis refuses an input that shares fewer genes with its reference

METHOD_INFO <- list(
  mcp_counter = list(
    tool = "MCPcounter", label = "MCP-counter",
    value_type = "scores",
    comparison_scope = "between samples within one cell type; not between cell types",
    reference = "MCP-counter transcriptomic marker genes of eight immune and two stromal populations (Becht et al. 2016)",
    reference_doi = "10.1186/s13059-016-1070-5",
    input_transform = "log2(x + 1) of the linear matrix, done by immunedeconv"
  ),
  xcell = list(
    tool = "xCell", label = "xCell",
    value_type = "scores",
    comparison_scope = "between samples within one cell type; an enrichment score is not a proportion",
    reference = "xCell gene signatures of 64 cell types with spillover compensation (Aran et al. 2017)",
    reference_doi = "10.1186/s13059-017-1349-1",
    input_transform = "rank-based single sample enrichment on the linear matrix, done by xCell"
  ),
  epic = list(
    tool = "EPIC", label = "EPIC",
    value_type = "fractions",
    comparison_scope = "between samples and between cell types; the uncharacterized fraction holds the cells outside the reference",
    reference = "EPIC reference profiles of immune, stromal, and endothelial cells with mRNA content scaling (Racle et al. 2017)",
    reference_doi = "10.7554/eLife.26476",
    input_transform = "constrained least squares on the linear matrix"
  ),
  quantiseq = list(
    tool = "quantiseqr", label = "quanTIseq",
    value_type = "fractions",
    comparison_scope = "between samples and between cell types; the uncharacterized fraction holds the cells outside the TIL10 signature",
    reference = "quanTIseq TIL10 signature matrix of ten immune cell types with mRNA content scaling (Finotello et al. 2019)",
    reference_doi = "10.1186/s13073-019-0638-6",
    input_transform = "constrained least squares on the linear matrix"
  ),
  mmcp_counter = list(
    tool = "mMCPcounter", label = "mMCP-counter",
    value_type = "scores",
    comparison_scope = "between samples within one cell type; not between cell types",
    reference = "mMCP-counter transcriptomic marker genes of sixteen murine immune and stromal populations (Petitprez et al. 2020)",
    reference_doi = "10.1186/s13073-020-00783-w",
    input_transform = "log2(x + 1) of the linear matrix, done by immunedeconv"
  )
)
MOUSE_METHODS <- c("mmcp_counter")
if (!METHOD %in% names(METHOD_INFO)) stop("The method must be one of ", paste(names(METHOD_INFO), collapse = ", "), ", not ", METHOD)
if (!INPUT_SCALE %in% c("tpm", "counts")) stop("The input scale must be tpm or counts, not ", INPUT_SCALE)
if (!SPECIES %in% c("human", "mouse")) stop("The species must be human or mouse, not ", SPECIES)
if (SPECIES == "mouse" && !METHOD %in% MOUSE_METHODS) {
  stop("The method ", METHOD, " carries human markers or human reference profiles, and the samples are mouse. A mouse symbol that matches a human symbol by case is not an ortholog, and an ortholog map loses the marker specificity. Use mmcp_counter.")
}
if (SPECIES == "human" && METHOD %in% MOUSE_METHODS) stop("The method ", METHOD, " carries mouse markers, and the samples are human. Use mcp_counter, xcell, epic, or quantiseq.")
info <- METHOD_INFO[[METHOD]]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading the expression matrix from ", EXPRESSION_PATH, " (", INPUT_SCALE, ")")
expression_df <- read.csv(EXPRESSION_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(expression_df[[1]])
expression <- as.matrix(expression_df[, -1, drop = FALSE])
storage.mode(expression) <- "numeric"
if (any(is.na(expression))) stop("The expression matrix holds a missing value. Give a complete matrix.")
if (any(expression < 0)) stop("The expression matrix holds a negative value. Give linear TPM or raw counts, not a log matrix.")
if (max(expression) <= 50) {
  stop("The largest value is ", signif(max(expression), 3), ". This looks like a log matrix. Give linear TPM or raw counts.")
}
n_genes_input <- length(gene_ids)

duplicated_ids <- duplicated(gene_ids)
if (any(duplicated_ids)) {
  message("Duplicate gene symbols: ", sum(duplicated_ids), " rows; the row with the highest mean stays for each symbol")
  order_by_mean <- order(gene_ids, -rowMeans(expression))
  expression <- expression[order_by_mean, , drop = FALSE]
  gene_ids <- gene_ids[order_by_mean]
  keep <- !duplicated(gene_ids)
  expression <- expression[keep, , drop = FALSE]
  gene_ids <- gene_ids[keep]
}
rownames(expression) <- gene_ids

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(expression), rownames(metadata))
if (length(missing) > 0) stop("Samples in the expression matrix but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(expression), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
group_sizes <- table(metadata$condition)
message("Samples: ", ncol(expression), "; genes: ", nrow(expression), "; condition levels: ", paste(levels(metadata$condition), collapse = ", "))

# ── Scale ─────────────────────────────────────────────────────────────────────
column_sums <- colSums(expression)
rescaled <- FALSE
if (INPUT_SCALE == "counts") {
  message("Counts to CPM: each column scaled to one million. CPM has no gene length correction, thus the reference-based fractions carry a length bias.")
  expression <- immunedeconv::scale_to_million(expression)
  rescaled <- TRUE
} else if (any(abs(column_sums / 1e6 - 1) > 0.05)) {
  message("The TPM columns sum to ", paste(signif(range(column_sums), 4), collapse = " to "), ", not one million; each column is rescaled to one million")
  expression <- immunedeconv::scale_to_million(expression)
  rescaled <- TRUE
}

# ── Species ───────────────────────────────────────────────────────────────────
# The symbols are used as they are: HGNC symbols with a human method, MGI
# symbols with mMCP-counter. No ortholog map runs here, because a human
# reference on mapped mouse symbols loses the marker specificity.
if (SPECIES == "mouse") message("Mouse symbols as they are, with the mouse marker table of mMCP-counter")
n_genes_used <- nrow(expression)

# ── Deconvolution ─────────────────────────────────────────────────────────────
message("Running immunedeconv ", METHOD, " (", info$tool, "), tumor = ", TUMOR)
if (METHOD == "mcp_counter") {
  marker_table <- data.frame(
    "HUGO symbols" = unlist(MCP_COUNTER_MARKERS, use.names = FALSE),
    "Cell population" = rep(names(MCP_COUNTER_MARKERS), lengths(MCP_COUNTER_MARKERS)),
    check.names = FALSE, stringsAsFactors = FALSE
  )
  n_markers_found <- sum(marker_table[["HUGO symbols"]] %in% rownames(expression))
  message("MCP-counter markers in the matrix: ", n_markers_found, " of ", nrow(marker_table))
  if (n_markers_found == 0) stop("No MCP-counter marker gene is in the matrix. The first column must hold HGNC gene symbols.")
  result <- suppressWarnings(deconvolute(expression, "mcp_counter", log_transform = TRUE, genes = marker_table))
} else if (METHOD == "xcell") {
  n_shared <- length(intersect(rownames(expression), xCell::xCell.data$genes))
  message("Genes shared with the xCell reference: ", n_shared, " of ", length(xCell::xCell.data$genes))
  if (n_shared < XCELL_MIN_GENES) {
    stop("xCell needs at least ", XCELL_MIN_GENES, " genes shared with its reference, and the matrix shares ", n_shared, ". Give a full transcriptome, or select mcp_counter, epic, or quantiseq.")
  }
  result <- deconvolute(expression, "xcell", arrays = FALSE)
} else if (METHOD == "epic") {
  result <- deconvolute(expression, "epic", tumor = TUMOR, scale_mrna = TRUE)
} else if (METHOD == "quantiseq") {
  result <- deconvolute(expression, "quantiseq", tumor = TUMOR, arrays = FALSE, scale_mrna = TRUE)
} else {
  # immunedeconv takes the log2(x + 1) of the linear matrix before mMCP-counter.
  result <- suppressWarnings(deconvolute_mouse(expression, "mmcp_counter"))
  if (nrow(result) == 0) stop("mMCP-counter found no marker gene. The first column must hold MGI gene symbols.")
}
fractions <- as.data.frame(result, check.names = FALSE, stringsAsFactors = FALSE)
fractions <- fractions[, c("cell_type", colnames(expression)), drop = FALSE]
if (nrow(fractions) == 0) stop("The method returned no cell type")
# immunedeconv maps one method population to two harmonized names in some cases
# (MCP-counter "Monocytic lineage" gives Monocyte and Macrophage/Monocyte). The
# second row repeats the first, thus it leaves, so that one test counts once.
name_map <- as.data.frame(immunedeconv::cell_type_map)
name_map <- name_map[name_map$method_dataset == METHOD, , drop = FALSE]
second_names <- name_map$cell_type[duplicated(name_map$method_cell_type)]
duplicate_rows <- duplicated(fractions[, -1, drop = FALSE]) & fractions$cell_type %in% second_names
if (any(duplicate_rows)) {
  message("Duplicate cell type rows from the name harmonization dropped: ", paste(fractions$cell_type[duplicate_rows], collapse = ", "))
  fractions <- fractions[!duplicate_rows, , drop = FALSE]
}
message("Cell types: ", nrow(fractions), " (", info$value_type, ")")
write.csv(fractions, out("fractions.csv"), row.names = FALSE)

values <- as.matrix(fractions[, -1, drop = FALSE])
rownames(values) <- fractions$cell_type

# ── Comparison ────────────────────────────────────────────────────────────────
reference_samples <- rownames(metadata)[metadata$condition == REFERENCE_LEVEL]
test_samples <- rownames(metadata)[metadata$condition == TEST_LEVEL]
enough <- length(reference_samples) >= 2 && length(test_samples) >= 2
if (!enough) message("A condition level has fewer than 2 samples; the Wilcoxon p-values are NA")
comparison <- do.call(rbind, lapply(seq_len(nrow(values)), function(i) {
  x <- values[i, reference_samples]
  y <- values[i, test_samples]
  statistic <- NA_real_
  pvalue <- NA_real_
  if (enough && (sd(c(x, y)) > 0)) {
    test <- suppressWarnings(wilcox.test(y, x))
    statistic <- unname(test$statistic)
    pvalue <- test$p.value
  }
  data.frame(
    cell_type = rownames(values)[i],
    n_reference = length(x),
    n_test = length(y),
    median_reference = median(x),
    median_test = median(y),
    difference = median(y) - median(x),
    statistic = statistic,
    pvalue = pvalue,
    stringsAsFactors = FALSE
  )
}))
comparison$padj <- p.adjust(comparison$pvalue, method = "BH")
comparison <- comparison[order(comparison$pvalue, na.last = TRUE), ]
write.csv(comparison, out("comparison.csv"), row.names = FALSE)
n_significant <- sum(!is.na(comparison$padj) & comparison$padj < ALPHA)
message("Compared ", nrow(comparison), " cell types, ", TEST_LEVEL, " against ", REFERENCE_LEVEL, "; ", n_significant, " at BH padj < ", ALPHA)

# ── Figures ───────────────────────────────────────────────────────────────────
sample_order <- rownames(metadata)[order(metadata$condition)]
annotation <- data.frame(condition = metadata[sample_order, "condition"], row.names = sample_order)
heatmap_values <- values[, sample_order, drop = FALSE]
if (info$value_type == "scores") {
  row_sd <- apply(heatmap_values, 1, sd)
  heatmap_values <- (heatmap_values - rowMeans(heatmap_values)) / ifelse(row_sd > 0, row_sd, 1)
  heatmap_title <- paste0(info$label, " scores, scaled per cell type")
} else {
  heatmap_title <- paste0(info$label, " cell fractions")
}
draw_heatmap <- function() {
  pheatmap(heatmap_values, cluster_rows = nrow(heatmap_values) > 1, cluster_cols = FALSE, annotation_col = annotation, main = heatmap_title, fontsize_row = 8)
}
png(fig("heatmap.png"), width = 7, height = 5, units = "in", res = 300)
draw_heatmap()
dev.off()
pdf(fig("heatmap.pdf"), width = 7, height = 5)
draw_heatmap()
dev.off()

long <- data.frame(
  cell_type = rep(rownames(values), times = ncol(values)),
  sample = rep(colnames(values), each = nrow(values)),
  value = as.vector(values),
  stringsAsFactors = FALSE
)
long$condition <- metadata[long$sample, "condition"]
long$sample <- factor(long$sample, levels = sample_order)

if (info$value_type == "fractions") {
  composition_plot <- ggplot(long, aes(x = sample, y = value, fill = cell_type)) +
    geom_col() +
    facet_grid(. ~ condition, scales = "free_x", space = "free_x") +
    scale_fill_viridis_d() +
    ylab("Cell fraction") + xlab(NULL) +
    ggtitle(paste0(info$label, " cell fractions per sample")) +
    theme_classic() +
    theme(axis.text.x = element_text(angle = 90, vjust = 0.5, hjust = 1), legend.text = element_text(size = 7))
  save_figure(composition_plot, "composition", width = 8, height = 5)
}

comparison_plot <- ggplot(long, aes(x = condition, y = value, color = condition)) +
  geom_boxplot(outlier.shape = NA) +
  geom_jitter(width = 0.15, size = 1.2) +
  facet_wrap(~ cell_type, scales = "free_y") +
  scale_color_viridis_d(end = 0.8) +
  ylab(if (info$value_type == "fractions") "Cell fraction" else paste0(info$label, " score")) + xlab(NULL) +
  ggtitle(paste0(info$label, ": ", TEST_LEVEL, " vs ", REFERENCE_LEVEL, " per cell type (Wilcoxon, BH)")) +
  theme_classic() +
  theme(legend.position = "none", strip.text = element_text(size = 7), axis.text.x = element_text(angle = 45, hjust = 1))
save_figure(comparison_plot, "comparison", width = 9, height = 7)

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-immunedeconv@1.1.0",
  method = paste0("immunedeconv ", METHOD, " (", info$label, ")"),
  tool = info$tool,
  value_type = info$value_type,
  value_type_statement = if (info$value_type == "fractions") "The values are absolute cell fractions of each sample." else "The values are scores, not fractions.",
  comparison_scope = info$comparison_scope,
  reference = info$reference,
  reference_doi = info$reference_doi,
  input_scale = INPUT_SCALE,
  input_transform = info$input_transform,
  rescaled_to_million = rescaled,
  species = SPECIES,
  tumor = TUMOR,
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  comparison_test = "Wilcoxon rank-sum per cell type, Benjamini-Hochberg adjustment",
  n_samples = ncol(expression),
  group_sizes = as.list(group_sizes),
  n_genes_input = n_genes_input,
  n_genes_used = n_genes_used,
  n_cell_types = nrow(fractions),
  cell_types = fractions$cell_type,
  n_cell_types_compared = sum(!is.na(comparison$pvalue)),
  n_significant = n_significant,
  alpha = ALPHA,
  versions = list(
    R = R.version.string,
    immunedeconv = as.character(packageVersion("immunedeconv")),
    tool = as.character(packageVersion(info$tool))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("fractions.csv"))
