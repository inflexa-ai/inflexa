#!/usr/bin/env Rscript
# tpl-wgcna-modules — WGCNA signed co-expression modules on the
# variance-stabilized matrix.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: the low count genes leave, the DESeq2 variance stabilizing
# transformation (blind to the design) gives the expression matrix, and the top
# variable genes enter the network. The signed adjacency is the correlation
# raised to a soft-threshold power, the lowest power whose scale-free fit index
# reaches the target (Zhang and Horvath 2005). The topological overlap
# dissimilarity, hierarchical clustering, and the dynamic tree cut give the
# modules, the first principal component of a module is its eigengene, the
# eigengenes are correlated with the sample traits, and the correlation of a
# gene with its module eigengene (module membership, kME) ranks the hub genes
# (Langfelder and Horvath 2008).

suppressPackageStartupMessages({
  library(DESeq2)
  library(WGCNA)
  library(ggplot2)
  library(jsonlite)
})
options(stringsAsFactors = FALSE)
disableWGCNAThreads()

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN     <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL      <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL           <- {{test_level}}  # [adaptable: test_level]
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES          <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES          <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below
{{/unless}}
N_TOP_GENES          <- {{n_top_genes}}  # [adaptable: n_top_genes]
SCALE_FREE_R_SQUARED <- {{scale_free_r_squared}}  # [adaptable: scale_free_r_squared]
NETWORK_TYPE         <- {{network_type}}
MIN_MODULE_SIZE      <- {{min_module_size}}  # [adaptable: min_module_size]
MERGE_CUT_HEIGHT     <- {{merge_cut_height}}  # [adaptable: merge_cut_height]
N_HUB_GENES          <- {{n_hub_genes}}  # [adaptable: n_hub_genes]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]

# The candidate powers of the scale-free fit, and the fallback power by sample
# count when no candidate reaches the target (the WGCNA FAQ table for a signed
# network).
POWER_CANDIDATES <- c(1:10, seq(12, 30, by = 2))
N_THREADS <- 1
UNASSIGNED_MODULE <- "grey"
SMALL_COHORT <- 15

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. The script takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)
if (any(duplicated(gene_ids))) stop("The count matrix holds a duplicated gene identifier; the network needs one row per gene.")

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
n_samples <- ncol(counts)
message("Samples: ", n_samples, "; genes: ", nrow(counts))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ", test ", TEST_LEVEL, ")")
if (n_samples < SMALL_COHORT) {
  message("WARNING: ", n_samples, " samples is below ", SMALL_COHORT, "; the correlations behind the modules are unstable on such a cohort")
}

# ── Traits ────────────────────────────────────────────────────────────────────
# The condition as a 0/1 contrast (test level 1, reference level 0, NA for any
# other level), plus every numeric column of the sample table that is not the
# sample identifier or the condition.
condition_trait <- ifelse(metadata$condition == TEST_LEVEL, 1, ifelse(metadata$condition == REFERENCE_LEVEL, 0, NA_real_))
traits <- data.frame(condition = condition_trait, row.names = rownames(metadata))
numeric_columns <- setdiff(colnames(metadata)[vapply(metadata, is.numeric, logical(1))], c(SAMPLE_ID_COLUMN, CONDITION_COLUMN, "condition"))
for (column in numeric_columns) {
  values <- as.numeric(metadata[[column]])
  if (length(unique(values[!is.na(values)])) < 2) {
    message("The numeric column ", column, " is constant; it leaves the traits")
    next
  }
  traits[[column]] <- values
}
message("Traits: ", paste(colnames(traits), collapse = ", "))

# ── Filter and transform ──────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]
if (nrow(counts) < MIN_MODULE_SIZE) stop("Only ", nrow(counts), " genes pass the count filter; the network needs more genes than the minimum module size")

dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ 1)
dds <- estimateSizeFactors(dds)
vsd <- vst(dds, blind = TRUE)
vst_matrix <- assay(vsd)

gene_variance <- apply(vst_matrix, 1, var)
n_network <- min(N_TOP_GENES, nrow(vst_matrix))
top_genes <- names(sort(gene_variance, decreasing = TRUE))[seq_len(n_network)]
expression <- t(vst_matrix[top_genes, , drop = FALSE])
message("Network genes: the top ", n_network, " by VST variance")

quality <- goodSamplesGenes(expression, verbose = 0)
if (!quality$allOK) {
  message("goodSamplesGenes removes ", sum(!quality$goodGenes), " genes and ", sum(!quality$goodSamples), " samples with too many missing values or zero variance")
  expression <- expression[quality$goodSamples, quality$goodGenes, drop = FALSE]
  traits <- traits[rownames(expression), , drop = FALSE]
  n_samples <- nrow(expression)
}

# ── Soft threshold ────────────────────────────────────────────────────────────
message("Scale-free fit of the ", NETWORK_TYPE, " network over the powers ", paste(POWER_CANDIDATES, collapse = ", "))
sft <- pickSoftThreshold(expression, powerVector = POWER_CANDIDATES, networkType = NETWORK_TYPE, RsquaredCut = SCALE_FREE_R_SQUARED, verbose = 0)
fit <- sft$fitIndices
soft_threshold_table <- data.frame(
  power = fit$Power,
  scale_free_r_squared = fit$SFT.R.sq,
  slope = fit$slope,
  mean_connectivity = fit$mean.k.,
  median_connectivity = fit$median.k.,
  max_connectivity = fit$max.k.
)
write.csv(soft_threshold_table, out("soft_threshold.csv"), row.names = FALSE)

reaches <- which(fit$SFT.R.sq >= SCALE_FREE_R_SQUARED & fit$slope < 0)
if (length(reaches) > 0) {
  SOFT_POWER <- fit$Power[reaches[1]]
  soft_power_source <- "scale_free_fit"
} else {
  SOFT_POWER <- if (n_samples < 20) 18 else if (n_samples < 30) 16 else if (n_samples < 40) 14 else 12
  soft_power_source <- "fallback_by_sample_count"
  message("WARNING: no power reaches a scale-free fit of ", SCALE_FREE_R_SQUARED, "; the fallback power for ", n_samples, " samples is ", SOFT_POWER)
}
soft_power_fit <- fit$SFT.R.sq[fit$Power == SOFT_POWER]
message("Soft power: ", SOFT_POWER, " (scale-free fit ", signif(soft_power_fit, 3), ", source ", soft_power_source, ")")

# ── Modules ───────────────────────────────────────────────────────────────────
net <- blockwiseModules(
  expression,
  power = SOFT_POWER,
  networkType = NETWORK_TYPE,
  TOMType = "signed",
  minModuleSize = MIN_MODULE_SIZE,
  mergeCutHeight = MERGE_CUT_HEIGHT,
  maxBlockSize = ncol(expression),
  numericLabels = FALSE,
  pamRespectsDendro = FALSE,
  nThreads = N_THREADS,
  verbose = 0
)
module_of_gene <- net$colors
names(module_of_gene) <- colnames(expression)
module_sizes <- table(module_of_gene)
module_names <- setdiff(names(module_sizes), UNASSIGNED_MODULE)
n_modules <- length(module_names)
n_unassigned <- if (UNASSIGNED_MODULE %in% names(module_sizes)) as.integer(module_sizes[[UNASSIGNED_MODULE]]) else 0L
message("Modules: ", n_modules, " (", paste(sprintf("%s=%d", module_names, as.integer(module_sizes[module_names])), collapse = ", "), "); unassigned (", UNASSIGNED_MODULE, "): ", n_unassigned)
if (n_modules == 0) stop("The dynamic tree cut finds no module; every gene is unassigned")

# ── Eigengenes and module membership ──────────────────────────────────────────
# moduleEigengenes names a column ME<module>, and signedKME drops that prefix
# when outputColumnName is empty. The script strips the prefix after both calls.
eigengenes <- moduleEigengenes(expression, colors = module_of_gene, excludeGrey = FALSE, grey = UNASSIGNED_MODULE)$eigengenes
eigengenes <- orderMEs(eigengenes)
membership <- signedKME(expression, eigengenes, outputColumnName = "")
colnames(eigengenes) <- sub("^ME", "", colnames(eigengenes))
own_membership <- vapply(seq_along(module_of_gene), function(index) membership[index, module_of_gene[[index]]], numeric(1))

modules_table <- data.frame(
  gene = names(module_of_gene),
  module = unname(module_of_gene),
  module_membership = own_membership,
  stringsAsFactors = FALSE
)
modules_table$is_unassigned <- modules_table$module == UNASSIGNED_MODULE
modules_table <- modules_table[order(modules_table$is_unassigned, modules_table$module, -modules_table$module_membership), ]
modules_table$is_unassigned <- NULL
write.csv(modules_table, out("modules.csv"), row.names = FALSE)

assigned_eigengenes <- eigengenes[, module_names, drop = FALSE]
write.csv(data.frame(module = colnames(assigned_eigengenes), t(as.matrix(assigned_eigengenes)), check.names = FALSE), out("eigengenes.csv"), row.names = FALSE)

hub_rows <- lapply(module_names, function(module) {
  members <- modules_table[modules_table$module == module, , drop = FALSE]
  members <- head(members[order(-members$module_membership), ], N_HUB_GENES)
  data.frame(module = module, rank = seq_len(nrow(members)), gene = members$gene, module_membership = members$module_membership, stringsAsFactors = FALSE)
})
hub_table <- do.call(rbind, hub_rows)
write.csv(hub_table, out("hub_genes.csv"), row.names = FALSE)
for (module in module_names) {
  hubs <- hub_table[hub_table$module == module, ]
  message("Hubs of ", module, " (", as.integer(module_sizes[[module]]), " genes): ", paste(sprintf("%s (kME %.2f)", hubs$gene, hubs$module_membership), collapse = ", "))
}

# ── Module-trait correlations ─────────────────────────────────────────────────
trait_matrix <- as.matrix(traits[rownames(expression), , drop = FALSE])
module_trait_cor <- WGCNA::cor(as.matrix(assigned_eigengenes), trait_matrix, use = "p")
module_trait_p <- corPvalueStudent(module_trait_cor, n_samples)
module_trait_table <- data.frame(
  module = rep(rownames(module_trait_cor), times = ncol(module_trait_cor)),
  trait = rep(colnames(module_trait_cor), each = nrow(module_trait_cor)),
  correlation = as.vector(module_trait_cor),
  pvalue = as.vector(module_trait_p),
  stringsAsFactors = FALSE
)
module_trait_table$n_genes <- as.integer(module_sizes[module_trait_table$module])
module_trait_table$n_samples <- n_samples
module_trait_table <- module_trait_table[order(module_trait_table$trait, module_trait_table$pvalue), ]
write.csv(module_trait_table, out("module_traits.csv"), row.names = FALSE)
for (trait in colnames(trait_matrix)) {
  rows <- module_trait_table[module_trait_table$trait == trait, ]
  message("Trait ", trait, ": ", paste(sprintf("%s r=%.2f p=%.2g", rows$module, rows$correlation, rows$pvalue), collapse = "; "))
}

# ── Figures ───────────────────────────────────────────────────────────────────
block_genes <- net$blockGenes[[1]]
draw_dendrogram <- function() {
  plotDendroAndColors(
    net$dendrograms[[1]], module_of_gene[block_genes], "Module",
    dendroLabels = FALSE, hang = 0.03, addGuide = TRUE, guideHang = 0.05,
    main = paste0("Gene dendrogram and modules (", NETWORK_TYPE, ", power ", SOFT_POWER, ", ", n_samples, " samples)")
  )
}
png(fig("dendrogram.png"), width = 8, height = 6, units = "in", res = 300)
draw_dendrogram()
dev.off()
pdf(fig("dendrogram.pdf"), width = 8, height = 6)
draw_dendrogram()
dev.off()

heatmap_df <- module_trait_table
heatmap_df$label <- sprintf("%.2f\n(%.1e)", heatmap_df$correlation, heatmap_df$pvalue)
heatmap_df$module <- factor(heatmap_df$module, levels = rev(module_names))
module_trait_plot <- ggplot(heatmap_df, aes(x = trait, y = module, fill = correlation)) +
  geom_tile(color = "white") +
  geom_text(aes(label = label), size = 2.8) +
  scale_fill_gradient2(low = "#2166AC", mid = "white", high = "#B2182B", limits = c(-1, 1), name = "Correlation") +
  xlab("Trait") + ylab("Module eigengene") +
  ggtitle(paste0("Module-trait relationships (", n_samples, " samples)")) +
  theme_classic() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1))
save_figure(module_trait_plot, "module_traits", width = 4.5 + 1.2 * ncol(trait_matrix), height = 2 + 0.45 * n_modules)

fit_df <- rbind(
  data.frame(power = fit$Power, value = -sign(fit$slope) * fit$SFT.R.sq, panel = "Signed scale-free fit index"),
  data.frame(power = fit$Power, value = fit$mean.k., panel = "Mean connectivity")
)
fit_df$chosen <- fit_df$power == SOFT_POWER
reference_lines <- data.frame(panel = "Signed scale-free fit index", yintercept = SCALE_FREE_R_SQUARED)
soft_threshold_plot <- ggplot(fit_df, aes(x = power, y = value)) +
  geom_line(color = "grey60") +
  geom_point(aes(color = chosen), size = 2) +
  geom_hline(data = reference_lines, aes(yintercept = yintercept), linetype = "dashed") +
  scale_color_manual(values = c(`FALSE` = "grey30", `TRUE` = "#B2182B"), labels = c(`FALSE` = "candidate", `TRUE` = "chosen"), name = "Power") +
  facet_wrap(~ panel, scales = "free_y", ncol = 2) +
  xlab("Soft-threshold power") + ylab(NULL) +
  ggtitle(paste0("Soft threshold: power ", SOFT_POWER, " (", soft_power_source, ")")) +
  theme_classic()
save_figure(soft_threshold_plot, "soft_threshold", width = 9, height = 4)

# ── Summary ───────────────────────────────────────────────────────────────────
hub_list <- lapply(module_names, function(module) {
  hubs <- hub_table[hub_table$module == module, ]
  list(n_genes = as.integer(module_sizes[[module]]), n_samples = n_samples, hub_genes = hubs$gene, hub_module_membership = round(hubs$module_membership, 4))
})
names(hub_list) <- module_names
summary_record <- list(
  template = "tpl-wgcna-modules@1.0.0",
  method = "WGCNA signed co-expression network",
  n_samples = n_samples,
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_in_network = ncol(expression),
  n_top_genes = N_TOP_GENES,
  transformation = "DESeq2 vst, blind",
  network_type = NETWORK_TYPE,
  soft_power = SOFT_POWER,
  soft_power_scale_free_fit = soft_power_fit,
  soft_power_source = soft_power_source,
  scale_free_r_squared_target = SCALE_FREE_R_SQUARED,
  min_module_size = MIN_MODULE_SIZE,
  merge_cut_height = MERGE_CUT_HEIGHT,
  n_modules = n_modules,
  unassigned_module = UNASSIGNED_MODULE,
  n_unassigned_genes = n_unassigned,
  modules = hub_list,
  traits = colnames(trait_matrix),
  condition_trait = list(column = CONDITION_COLUMN, test_level = TEST_LEVEL, coded = 1, reference_level = REFERENCE_LEVEL, coded_reference = 0),
  small_cohort_warning = n_samples < SMALL_COHORT,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  n_threads = N_THREADS,
  versions = list(
    R = R.version.string,
    WGCNA = as.character(packageVersion("WGCNA")),
    DESeq2 = as.character(packageVersion("DESeq2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("modules.csv"))
