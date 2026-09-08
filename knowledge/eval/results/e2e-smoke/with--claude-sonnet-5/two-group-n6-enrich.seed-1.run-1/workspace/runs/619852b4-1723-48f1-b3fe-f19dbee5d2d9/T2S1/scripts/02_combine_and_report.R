#!/usr/bin/env Rscript
# 02_combine_and_report.R
#
# Combines the Hallmark and Reactome preranked fgsea outputs into one
# cross-collection table + figure set for the report, WITHOUT merging the two
# collections' statistics (each keeps its own row, tagged by `collection` and
# `release`). Also builds a leading-edge table restricted to padj < 0.05
# pathways, and an enrichment network / UpSet figure over the union of
# significant Hallmark + Reactome leading-edge genes.

suppressPackageStartupMessages({
  library(ggplot2)
  library(igraph)
  library(ggraph)
  library(ComplexUpset)
})

# ── Parameters ────────────────────────────────────────────────────────────────
PADJ_CUTOFF <- 0.05
N_TOP_COMBINED <- 20
N_TOP_NETWORK_PER_COLLECTION <- 6
HALLMARK_RELEASE <- "MSigDB Hallmark human, release 2026.1 (/mnt/refs/managed/msigdb-hallmark-human/2026.1/h.all.v2026.1.Hs.symbols.gmt), 50 gene sets"
REACTOME_RELEASE <- "Reactome pathways, release 'current' (host-provisioned snapshot; filtered to Homo sapiens via ReactomePathways.txt), 2868 human gene sets"

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)

read_collection <- function(results_path, collapsed_path, collection, release) {
  res <- read.csv(results_path, stringsAsFactors = FALSE)
  res$collection <- collection
  res$release <- release
  collapsed <- read.csv(collapsed_path, stringsAsFactors = FALSE)
  res$is_representative <- res$pathway %in% collapsed$pathway
  res
}

hallmark <- read_collection("output/hallmark_results.csv", "output/hallmark_collapsed.csv", "Hallmark", HALLMARK_RELEASE)
reactome <- read_collection("output/reactome_results.csv", "output/reactome_collapsed.csv", "Reactome", REACTOME_RELEASE)

# ── Combined (not merged) tested-set table ────────────────────────────────────
combined <- rbind(
  hallmark[, c("collection", "release", "pathway", "pvalue", "padj", "ES", "NES", "size", "leading_edge", "is_representative")],
  reactome[, c("collection", "release", "pathway", "pvalue", "padj", "ES", "NES", "size", "leading_edge", "is_representative")]
)
combined <- combined[order(combined$collection, combined$padj, combined$pvalue), ]
write.csv(combined, "output/enrichment_results.csv", row.names = FALSE)
message("Wrote output/enrichment_results.csv: ", nrow(combined), " rows (", sum(combined$collection == "Hallmark"), " Hallmark, ", sum(combined$collection == "Reactome"), " Reactome), reported separately by `collection`")

# ── Significant leading-edge table (padj < 0.05, both collections) ───────────
sig <- combined[!is.na(combined$padj) & combined$padj < PADJ_CUTOFF, ]
sig <- sig[order(sig$collection, sig$padj), ]
leading_edge_table <- sig[, c("collection", "pathway", "padj", "NES", "size", "is_representative", "leading_edge")]
write.csv(leading_edge_table, "output/significant_leading_edge.csv", row.names = FALSE)
message("Wrote output/significant_leading_edge.csv: ", nrow(leading_edge_table), " significant pathway rows (padj < ", PADJ_CUTOFF, ")")

# ── Combined dot plot (top N by padj across both collections, collection order ignored) ─
by_significance <- combined[!is.na(combined$padj), ]
by_significance <- by_significance[order(by_significance$padj, by_significance$pvalue), ]
top_combined <- head(by_significance, N_TOP_COMBINED)
top_combined$label <- paste0("[", top_combined$collection, "] ", top_combined$pathway)
top_combined$label <- factor(top_combined$label, levels = top_combined$label[order(top_combined$NES)])
dot_plot <- ggplot(top_combined, aes(x = NES, y = label, size = size, color = padj, shape = collection)) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "grey60") +
  geom_point() +
  scale_color_viridis_c(direction = -1, name = "padj") +
  scale_size_continuous(name = "Set size", range = c(1.5, 6)) +
  xlab("Normalized enrichment score (NES)") + ylab(NULL) +
  ggtitle(paste0("Top ", nrow(top_combined), " gene sets by adjusted p-value, Hallmark + Reactome (rank metric: DESeq2 Wald stat)")) +
  theme_classic() +
  theme(axis.text.y = element_text(size = 7))
ggsave("figures/enrichment_dotplot.png", dot_plot, width = 10, height = max(5, 0.3 * nrow(top_combined) + 1.5), dpi = 300)
ggsave("figures/enrichment_dotplot.pdf", dot_plot, width = 10, height = max(5, 0.3 * nrow(top_combined) + 1.5))

# ── Combined bar plot (all significant, both collections) ────────────────────
sig_bar <- sig
sig_bar$label <- paste0("[", sig_bar$collection, "] ", sig_bar$pathway)
sig_bar$direction <- ifelse(sig_bar$NES > 0, "positive", "negative")
# Keep the figure readable: representative (collapsed) sets only when there are many
bar_source <- if (sum(sig_bar$is_representative) >= 5) sig_bar[sig_bar$is_representative, ] else sig_bar
bar_source$label <- factor(bar_source$label, levels = bar_source$label[order(bar_source$NES)])
bar_plot <- ggplot(bar_source, aes(x = NES, y = label, fill = direction)) +
  geom_col() +
  facet_grid(collection ~ ., scales = "free_y", space = "free_y") +
  scale_fill_manual(values = c(negative = "#3B528B", positive = "#F98E09"), name = "NES sign") +
  xlab("Normalized enrichment score (NES)") + ylab(NULL) +
  ggtitle(paste0("Representative significant gene sets at padj < ", PADJ_CUTOFF, " (redundant sets collapsed)")) +
  theme_classic() +
  theme(axis.text.y = element_text(size = 7), strip.text.y = element_text(angle = 0))
ggsave("figures/enrichment_barplot.png", bar_plot, width = 10, height = max(5, 0.3 * nrow(bar_source) + 2), dpi = 300)
ggsave("figures/enrichment_barplot.pdf", bar_plot, width = 10, height = max(5, 0.3 * nrow(bar_source) + 2))

# ── Enrichment network (cnetplot-style): top representative pathways <-> their leading-edge genes ──
top_net <- do.call(rbind, lapply(split(sig[sig$is_representative, ], sig$collection[sig$is_representative]), function(d) {
  head(d[order(d$padj), ], N_TOP_NETWORK_PER_COLLECTION)
}))
if (nrow(top_net) > 0) {
  edges <- do.call(rbind, lapply(seq_len(nrow(top_net)), function(i) {
    genes <- strsplit(top_net$leading_edge[i], ";")[[1]]
    # cap genes per pathway for a readable network: keep the first 8 leading-edge genes
    genes <- head(genes, 8)
    if (length(genes) == 0) return(NULL)
    data.frame(from = paste0("[", top_net$collection[i], "] ", top_net$pathway[i]), to = genes, stringsAsFactors = FALSE)
  }))
  g <- graph_from_data_frame(edges, directed = FALSE)
  V(g)$node_type <- ifelse(V(g)$name %in% edges$from, "pathway", "gene")
  V(g)$node_size <- ifelse(V(g)$node_type == "pathway", 6, 2)
  set.seed(42)
  net_plot <- ggraph(g, layout = "fr") +
    geom_edge_link(color = "grey75", alpha = 0.6) +
    geom_node_point(aes(color = node_type, size = node_size)) +
    geom_node_text(aes(label = ifelse(node_type == "pathway", name, name)),
                    size = ifelse(V(g)$node_type == "pathway", 2.6, 2.0),
                    repel = TRUE, max.overlaps = 40) +
    scale_color_manual(values = c(pathway = "#D55E00", gene = "#3B528B"), name = NULL) +
    scale_size_continuous(range = c(2, 7), guide = "none") +
    ggtitle(paste0("Enrichment network: top ", N_TOP_NETWORK_PER_COLLECTION, " representative significant pathways per collection\nand their leading-edge genes (capped at 8 genes/pathway for readability)")) +
    theme_void() +
    theme(plot.title = element_text(size = 10))
  ggsave("figures/enrichment_network.png", net_plot, width = 11, height = 9, dpi = 300)
  ggsave("figures/enrichment_network.pdf", net_plot, width = 11, height = 9)
  message("Wrote figures/enrichment_network.{png,pdf} over ", nrow(top_net), " pathways")
} else {
  message("No significant representative pathway available for the network figure")
}

# ── UpSet plot: leading-edge gene overlap across the top significant pathways ─
if (nrow(top_net) >= 2) {
  gene_sets_for_upset <- setNames(
    lapply(seq_len(nrow(top_net)), function(i) head(strsplit(top_net$leading_edge[i], ";")[[1]], 30)),
    paste0("[", substr(top_net$collection, 1, 4), "] ", substr(top_net$pathway, 1, 30))
  )
  all_genes <- unique(unlist(gene_sets_for_upset))
  membership <- as.data.frame(sapply(gene_sets_for_upset, function(s) all_genes %in% s))
  membership$gene <- all_genes
  set_names_upset <- names(gene_sets_for_upset)
  upset_plot <- ComplexUpset::upset(
    membership, set_names_upset,
    name = "Pathway leading-edge gene overlap",
    min_size = 1,
    width_ratio = 0.25
  )
  ggsave("figures/enrichment_upset.png", upset_plot, width = 12, height = 7, dpi = 300)
  ggsave("figures/enrichment_upset.pdf", upset_plot, width = 12, height = 7)
  message("Wrote figures/enrichment_upset.{png,pdf}")
}

message("Combined significant-pathway counts: Hallmark ", sum(sig$collection == "Hallmark"),
        " (", sum(sig$collection == "Hallmark" & sig$is_representative), " representative), Reactome ",
        sum(sig$collection == "Reactome"), " (", sum(sig$collection == "Reactome" & sig$is_representative), " representative)")
message("Done.")
