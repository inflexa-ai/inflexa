#!/usr/bin/env Rscript
# Smoke test for the R `spacexr` package (RCTD spatial-transcriptomics cell-type
# deconvolution + CSIDE).
#
# Install: remotes::install_github("dmcable/spacexr")
#
# Fully self-contained: no input files, no network. Builds -- with a fixed seed
# -- a synthetic single-cell REFERENCE (genes x cells, three cell types with
# clear per-type marker blocks so differential-expression gene selection has
# real markers to find) and a synthetic SpatialRNA puck (genes x pixels, each a
# two-type mixture) over the SAME gene universe, then constructs the RCTD object.
# Only the OBJECT-CONSTRUCTION surface is exercised: Reference(), SpatialRNA(),
# and create.RCTD(). The heavy fit, run.RCTD(), is deliberately NOT called.
# Checks are structural (S4 class, populated slots) -- never numeric. Exits 0
# only if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript spacexr.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once spacexr
# is available:
#   - CONSTRUCTOR ARG NAMES / ORDER. Assumed signatures:
#       Reference(counts, cell_types, nUMI)   -- counts = genes x cells matrix
#         (rownames = genes, colnames = cell barcodes); cell_types = a factor
#         NAMED by cell barcode; nUMI = named numeric of per-cell totals.
#       SpatialRNA(coords, counts, nUMI)      -- coords = data.frame with
#         columns x/y and rownames = pixel ids; counts = genes x pixels; nUMI =
#         named numeric of per-pixel totals.
#       create.RCTD(spatialRNA, reference, max_cores = 1)
#     Re-confirm the positional/argument spelling against the installed help.
#   - S4 CLASS NAMES. Assumed "Reference", "SpatialRNA", and "RCTD"; and slot
#     names @counts / @cell_types / @coords / @nUMI. Re-confirm if the inherits()
#     / slotNames() checks below fail.
#   - create.RCTD DEFAULT THRESHOLDS. The synthetic data is built to satisfy the
#     documented defaults -- >= CELL_MIN_INSTANCE (25) cells per reference cell
#     type (here 30), per-cell/per-pixel UMI comfortably above UMI_min (100) and
#     UMI_min_sigma (300), and clear marker genes so DE selection is non-empty.
#     These thresholds are version-dependent; if create.RCTD errors on an
#     installed build, revisit the synthetic design (more cells / stronger
#     markers / higher UMI) rather than assuming a package fault.
#   - run.RCTD IS NOT TESTED (deliberately -- it is the expensive optimisation).
#     The end-to-end fit must be re-verified separately once installed.
# ============================================================================

if (!requireNamespace("spacexr", quietly = TRUE)) {
  cat("FAIL: package 'spacexr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(spacexr))
cat(sprintf("spacexr version: %s\n", as.character(packageVersion("spacexr"))))

failures <- 0L
run_test <- function(name, fn) {
  result <- tryCatch({
    fn()
    "ok"
  }, error = function(e) conditionMessage(e))
  if (identical(result, "ok")) {
    cat(sprintf("  ok   %s\n", name))
  } else {
    failures <<- failures + 1L
    cat(sprintf("  FAIL %s: %s\n", name, result))
  }
}

# ---- Synthetic design ------------------------------------------------------
# 150 genes: three 30-gene MARKER blocks (one per cell type) + 60 background
# genes. For a cell of type k, its own marker block is highly expressed
# (lambda 40), the other two blocks are near-silent (lambda 1), and background
# genes are moderate (lambda 5) for everyone. That gives clear between-type
# differential expression so create.RCTD's marker selection finds real markers.
set.seed(7)
cell_type_names <- c("typeA", "typeB", "typeC")
n_types <- length(cell_type_names)
n_markers_per_type <- 30L
n_marker_genes <- n_markers_per_type * n_types    # 90
n_bg_genes <- 60L
n_genes <- n_marker_genes + n_bg_genes            # 150
genes <- paste0("Gene", seq_len(n_genes))

# lambda vector for a cell of the given type index.
build_lambda <- function(type_idx) {
  lam <- numeric(n_genes)
  for (k in seq_len(n_types)) {
    block <- ((k - 1L) * n_markers_per_type + 1L):(k * n_markers_per_type)
    lam[block] <- if (k == type_idx) 40 else 1
  }
  lam[(n_marker_genes + 1L):n_genes] <- 5   # background genes
  lam
}

# Reference: 30 cells per type -> 90 cells (>= CELL_MIN_INSTANCE default of 25).
n_ref_per_type <- 30L
n_ref_cells <- n_ref_per_type * n_types           # 90
ref_type_vec <- rep(cell_type_names, each = n_ref_per_type)
ref_cell_ids <- paste0("refcell", seq_len(n_ref_cells))
ref_counts <- matrix(0, nrow = n_genes, ncol = n_ref_cells,
                     dimnames = list(genes, ref_cell_ids))
for (j in seq_len(n_ref_cells)) {
  ti <- match(ref_type_vec[j], cell_type_names)
  ref_counts[, j] <- rpois(n_genes, build_lambda(ti))
}
cell_types <- factor(ref_type_vec, levels = cell_type_names)
names(cell_types) <- ref_cell_ids
ref_nUMI <- colSums(ref_counts)

# SpatialRNA: 100 pixels, each a random two-type mixture over the same genes.
n_pixels <- 100L
pixel_ids <- paste0("pixel", seq_len(n_pixels))
spatial_counts <- matrix(0, nrow = n_genes, ncol = n_pixels,
                         dimnames = list(genes, pixel_ids))
for (j in seq_len(n_pixels)) {
  pair <- sample.int(n_types, 2L)
  lam <- (build_lambda(pair[1L]) + build_lambda(pair[2L])) / 2
  spatial_counts[, j] <- rpois(n_genes, lam)
}
coords <- data.frame(
  x = runif(n_pixels, 0, 100),
  y = runif(n_pixels, 0, 100),
  row.names = pixel_ids
)
spatial_nUMI <- colSums(spatial_counts)

# Constructors are built via helpers so a construction error is recorded as a
# test FAIL (not a top-level crash). create.RCTD is the heavy-ish step and is
# invoked exactly once, inside its own test.
make_reference <- function() {
  suppressWarnings(suppressMessages(
    Reference(ref_counts, cell_types, ref_nUMI)
  ))
}
make_spatial <- function() {
  suppressWarnings(suppressMessages(
    SpatialRNA(coords, spatial_counts, spatial_nUMI)
  ))
}

run_test("Reference() builds a Reference object", function() {
  ref <- make_reference()
  stopifnot(inherits(ref, "Reference"))
  stopifnot("counts" %in% slotNames(ref))
  stopifnot("cell_types" %in% slotNames(ref))
  # Same gene universe we supplied; every retained cell keeps a type label.
  stopifnot(nrow(ref@counts) > 0L, ncol(ref@counts) > 0L)
  stopifnot(length(ref@cell_types) == ncol(ref@counts))
})

run_test("SpatialRNA() builds a SpatialRNA object", function() {
  puck <- make_spatial()
  stopifnot(inherits(puck, "SpatialRNA"))
  stopifnot("coords" %in% slotNames(puck))
  stopifnot("counts" %in% slotNames(puck))
  # coords carries an x/y position per retained pixel.
  stopifnot(all(c("x", "y") %in% colnames(puck@coords)))
  stopifnot(nrow(puck@coords) == ncol(puck@counts))
})

run_test("create.RCTD is an exported function", function() {
  stopifnot(exists("create.RCTD"))
  stopifnot(is.function(create.RCTD))
})

run_test("create.RCTD() returns an RCTD object", function() {
  # The synthetic reference/puck are built to clear create.RCTD's default
  # thresholds (see ASSUMPTIONS). max_cores = 1 keeps it single-threaded.
  rctd <- suppressWarnings(suppressMessages(
    create.RCTD(make_spatial(), make_reference(), max_cores = 1)
  ))
  stopifnot(inherits(rctd, "RCTD"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all spacexr smoke tests passed\n")
