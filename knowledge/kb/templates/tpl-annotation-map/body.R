#!/usr/bin/env Rscript
# tpl-annotation-map — gene identifier annotation with AnnotationDbi, offline.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: detect the identifier space of the gene column from its pattern,
# then map each identifier to the two other spaces with AnnotationDbi::mapIds
# on the organism package (org.Hs.eg.db or org.Mm.eg.db). One identifier
# space per column, the stable identifier as the key and the symbol as the
# label, the unmapped share and the one-to-many cases reported (Durinck et
# al. 2009; Wu et al. 2021).

suppressPackageStartupMessages({
  library(AnnotationDbi)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
MATRIX_PATH            <- {{matrix_path}}  # [adaptable: matrix_path]
GENE_COLUMN            <- {{gene_column}}  # [adaptable: gene_column]
ORGANISM               <- {{organism}}  # [adaptable: organism]
INPUT_SPACE            <- {{input_space}}  # [adaptable: input_space]
STRIP_ENSEMBL_VERSION  <- {{strip_ensembl_version}}  # [adaptable: strip_ensembl_version]
ALIAS_FALLBACK         <- {{alias_fallback}}  # [adaptable: alias_fallback]
MULTI_MAP_RULE         <- {{multi_map_rule}}  # [adaptable: multi_map_rule]
OUTPUT_PREFIX          <- {{output_prefix}}  # [adaptable: output_prefix]
ENSEMBL_PATTERN        <- "^ENS[A-Z]*G[0-9]{11}(\\.[0-9]+)?$"  # an Ensembl gene id, with or without a version
ENTREZ_PATTERN         <- "^[0-9]+$"  # a plain integer

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 4.5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

if (!ORGANISM %in% c("human", "mouse")) stop("organism must be human or mouse, not ", ORGANISM)
if (!INPUT_SPACE %in% c("auto", "symbol", "entrez", "ensembl")) stop("input_space must be auto, symbol, entrez, or ensembl, not ", INPUT_SPACE)
if (!MULTI_MAP_RULE %in% c("first", "asNA")) stop("multi_map_rule must be first or asNA, not ", MULTI_MAP_RULE)

# ── Organism package ──────────────────────────────────────────────────────────
ORG_PACKAGE <- if (ORGANISM == "human") "org.Hs.eg.db" else "org.Mm.eg.db"
suppressPackageStartupMessages(library(ORG_PACKAGE, character.only = TRUE))
org_db <- get(ORG_PACKAGE)
org_meta <- metadata(org_db)
org_field <- function(name) {
  value <- org_meta$value[org_meta$name == name]
  if (length(value) == 0) NA_character_ else as.character(value[1])
}
message("Organism package ", ORG_PACKAGE, " ", as.character(packageVersion(ORG_PACKAGE)),
        "; Entrez Gene source ", org_field("EGSOURCEDATE"), "; Ensembl source ", org_field("ENSOURCEDATE"))

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading the table from ", MATRIX_PATH)
header <- names(read.csv(MATRIX_PATH, nrows = 1, check.names = FALSE))
if (!GENE_COLUMN %in% header) stop("The table has no column ", GENE_COLUMN, "; the columns are ", paste(head(header, 10), collapse = ", "))
classes <- rep(NA_character_, length(header))
classes[header == GENE_COLUMN] <- "character"
table_df <- read.csv(MATRIX_PATH, check.names = FALSE, stringsAsFactors = FALSE, colClasses = classes)
input_ids <- trimws(as.character(table_df[[GENE_COLUMN]]))
if (length(input_ids) == 0) stop("The table has no rows")
if (any(is.na(input_ids) | input_ids == "")) stop("The column ", GENE_COLUMN, " holds an empty identifier in ", sum(is.na(input_ids) | input_ids == ""), " rows")
n_input <- length(input_ids)
unique_ids <- unique(input_ids)
n_duplicate <- n_input - length(unique_ids)
message("Rows: ", n_input, "; unique identifiers: ", length(unique_ids), "; duplicate rows: ", n_duplicate)

# ── Detect the identifier space ───────────────────────────────────────────────
pattern_share <- c(
  ensembl = mean(grepl(ENSEMBL_PATTERN, unique_ids)),
  entrez = mean(grepl(ENTREZ_PATTERN, unique_ids))
)
pattern_share <- c(pattern_share, symbol = max(0, 1 - sum(pattern_share)))
message("Pattern shares: ", paste(sprintf("%s=%.3f", names(pattern_share), pattern_share), collapse = ", "))
if (INPUT_SPACE == "auto") {
  input_space <- names(pattern_share)[which.max(pattern_share)]
  message("Detected input space: ", input_space)
} else {
  input_space <- INPUT_SPACE
  message("Input space set by the caller: ", input_space)
}
keytype_of <- c(symbol = "SYMBOL", entrez = "ENTREZID", ensembl = "ENSEMBL")
column_of <- c(symbol = "symbol", entrez = "entrez_id", ensembl = "ensembl_id")

lookup_keys <- unique_ids
if (input_space == "ensembl" && STRIP_ENSEMBL_VERSION) {
  n_versioned <- sum(grepl("\\.[0-9]+$", lookup_keys))
  lookup_keys <- sub("\\.[0-9]+$", "", lookup_keys)
  message("Removed the version suffix of ", n_versioned, " Ensembl identifiers")
}

# ── Map with mapIds ───────────────────────────────────────────────────────────
# One call per target space with multiVals = "list", so that a one-to-many
# case is counted before the multi-map rule reduces it to one cell.
map_list <- function(keys, keytype, column) {
  keys <- as.character(keys)
  if (length(keys) == 0) return(list())
  result <- suppressMessages(mapIds(org_db, keys = keys, column = column, keytype = keytype, multiVals = "list"))
  lapply(result, function(x) as.character(x[!is.na(x)]))
}
reduce_targets <- function(targets) {
  vapply(targets, function(x) {
    if (length(x) == 0) NA_character_
    else if (length(x) == 1) x[1]
    else if (MULTI_MAP_RULE == "first") x[1]
    else NA_character_
  }, character(1))
}

target_spaces <- setdiff(c("symbol", "entrez", "ensembl"), input_space)
maps <- list()
for (space in target_spaces) {
  message("Mapping ", keytype_of[[input_space]], " -> ", keytype_of[[space]])
  maps[[space]] <- map_list(lookup_keys, keytype_of[[input_space]], keytype_of[[space]])
}

n_alias_mapped <- 0L
alias_symbol <- rep(NA_character_, length(lookup_keys))
if (input_space == "symbol" && ALIAS_FALLBACK) {
  known <- lengths(maps[["entrez"]]) > 0
  candidates <- lookup_keys[!known]
  if (length(candidates) > 0) {
    message("Alias fallback on ", length(candidates), " symbols that are not a current symbol")
    alias_entrez <- map_list(candidates, "ALIAS", "ENTREZID")
    hit <- lengths(alias_entrez) > 0
    n_alias_mapped <- sum(hit)
    if (n_alias_mapped > 0) {
      for (id in candidates[hit]) {
        entrez <- alias_entrez[[id]]
        maps[["entrez"]][[id]] <- entrez
        ensembl <- map_list(entrez, "ENTREZID", "ENSEMBL")
        maps[["ensembl"]][[id]] <- unique(unlist(ensembl, use.names = FALSE))
      }
      kept_entrez <- reduce_targets(alias_entrez[hit])
      has_key <- !is.na(kept_entrez)
      current <- map_list(unique(kept_entrez[has_key]), "ENTREZID", "SYMBOL")
      alias_symbol[match(candidates[hit][has_key], lookup_keys)] <- reduce_targets(current[kept_entrez[has_key]])
    }
    message("Alias fallback mapped ", n_alias_mapped, " of ", length(candidates))
  }
}

# ── Mapping table ─────────────────────────────────────────────────────────────
unique_table <- data.frame(input_id = unique_ids, stringsAsFactors = FALSE)
unique_table$symbol <- NA_character_
unique_table$entrez_id <- NA_character_
unique_table$ensembl_id <- NA_character_
unique_table[[column_of[[input_space]]]] <- lookup_keys
for (space in target_spaces) unique_table[[column_of[[space]]]] <- reduce_targets(maps[[space]][lookup_keys])
if (input_space == "symbol") {
  unique_table$symbol <- ifelse(is.na(alias_symbol), unique_table$symbol, alias_symbol)
}
# The Entrez id is the central key of the package, thus an identifier is
# mapped when the package gives its Entrez id; an Entrez input is mapped
# when the package knows the id under a symbol.
mapped_unique <- if (input_space == "entrez") lengths(maps[["symbol"]][lookup_keys]) > 0 else lengths(maps[["entrez"]][lookup_keys]) > 0
unique_table$mapped <- mapped_unique

row_index <- match(input_ids, unique_ids)
mapping <- unique_table[row_index, , drop = FALSE]
mapping$input_id <- input_ids
rownames(mapping) <- NULL
write.csv(mapping, out("mapping.csv"), row.names = FALSE, na = "")

# ── One-to-many cases and unmapped identifiers ────────────────────────────────
multi_rows <- list()
for (space in target_spaces) {
  targets <- maps[[space]][lookup_keys]
  many <- lengths(targets) > 1
  if (any(many)) {
    multi_rows[[space]] <- data.frame(
      input_id = unique_ids[many],
      target_space = column_of[[space]],
      n_targets = lengths(targets[many]),
      targets = vapply(targets[many], paste, character(1), collapse = ";"),
      kept = reduce_targets(targets[many]),
      stringsAsFactors = FALSE
    )
  }
}
multi <- if (length(multi_rows) > 0) do.call(rbind, multi_rows) else data.frame(input_id = character(0), target_space = character(0), n_targets = integer(0), targets = character(0), kept = character(0))
rownames(multi) <- NULL
write.csv(multi, out("multi.csv"), row.names = FALSE, na = "")
n_multi_by_space <- vapply(target_spaces, function(space) sum(lengths(maps[[space]][lookup_keys]) > 1), integer(1))
names(n_multi_by_space) <- column_of[target_spaces]
n_multi <- length(unique(multi$input_id))

unmapped <- data.frame(input_id = unique_ids[!mapped_unique], stringsAsFactors = FALSE)
write.csv(unmapped, out("unmapped.csv"), row.names = FALSE)
n_mapped <- sum(mapped_unique)
mapped_share <- n_mapped / length(unique_ids)
message("Mapped ", n_mapped, " of ", length(unique_ids), " unique identifiers (share ", sprintf("%.3f", mapped_share), "); ",
        nrow(unmapped), " unmapped; ", n_multi, " one-to-many (rule ", MULTI_MAP_RULE, ")")

# ── Figures ───────────────────────────────────────────────────────────────────
status_rows <- lapply(target_spaces, function(space) {
  n_targets <- lengths(maps[[space]][lookup_keys])
  data.frame(
    target_space = column_of[[space]],
    status = c("one-to-one", "one-to-many", "unmapped"),
    n = c(sum(n_targets == 1), sum(n_targets > 1), sum(n_targets == 0)),
    stringsAsFactors = FALSE
  )
})
status_df <- do.call(rbind, status_rows)
status_df$status <- factor(status_df$status, levels = c("one-to-one", "one-to-many", "unmapped"))
status_plot <- ggplot(status_df, aes(x = target_space, y = n, fill = status)) +
  geom_col() +
  scale_fill_manual(values = c(`one-to-one` = "#21908C", `one-to-many` = "#FDE725", unmapped = "grey70"), name = "Map outcome") +
  xlab("Target identifier space") + ylab("Unique input identifiers") +
  ggtitle(paste0("Map outcome from ", column_of[[input_space]], " with ", ORG_PACKAGE)) +
  theme_classic()
save_figure(status_plot, "mapping_status")

pattern_df <- data.frame(pattern = names(pattern_share), share = as.numeric(pattern_share), stringsAsFactors = FALSE)
pattern_df$detected <- pattern_df$pattern == input_space
pattern_plot <- ggplot(pattern_df, aes(x = pattern, y = share, fill = detected)) +
  geom_col() +
  scale_fill_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = "Input space") +
  scale_y_continuous(limits = c(0, 1)) +
  xlab("Identifier pattern") + ylab("Share of unique input identifiers") +
  ggtitle("Identifier patterns of the input") +
  theme_classic()
save_figure(pattern_plot, "input_patterns")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-annotation-map@1.0.0",
  method = "AnnotationDbi mapIds on the organism package",
  input = MATRIX_PATH,
  gene_column = GENE_COLUMN,
  organism = ORGANISM,
  organism_package = ORG_PACKAGE,
  organism_package_version = as.character(packageVersion(ORG_PACKAGE)),
  entrez_source_date = org_field("EGSOURCEDATE"),
  ensembl_source_date = org_field("ENSOURCEDATE"),
  input_space = input_space,
  input_space_setting = INPUT_SPACE,
  pattern_share = as.list(round(pattern_share, 4)),
  n_rows = n_input,
  n_input = length(unique_ids),
  n_duplicate_rows = n_duplicate,
  n_mapped = n_mapped,
  mapped_share = round(mapped_share, 4),
  n_unmapped = nrow(unmapped),
  unmapped_share = round(1 - mapped_share, 4),
  n_multi = n_multi,
  n_multi_by_space = as.list(n_multi_by_space),
  multi_map_rule = MULTI_MAP_RULE,
  alias_fallback = ALIAS_FALLBACK,
  n_alias_mapped = n_alias_mapped,
  strip_ensembl_version = STRIP_ENSEMBL_VERSION,
  key_space = "entrez_id",
  versions = list(
    R = R.version.string,
    AnnotationDbi = as.character(packageVersion("AnnotationDbi")),
    org_package = as.character(packageVersion(ORG_PACKAGE)),
    ggplot2 = as.character(packageVersion("ggplot2")),
    jsonlite = as.character(packageVersion("jsonlite"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("mapping.csv"))
