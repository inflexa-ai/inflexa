#!/usr/bin/env Rscript
# Smoke test for the R `vegan` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# vegan and its implied deps (permute, lattice). Community data is a small
# sites x species count matrix, either fixed-seed random or a hand-built
# matrix with known structure. Exercises the core community-ecology API and
# exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript vegan.R
#
# Diversity/distance outputs are floating-point (checked with tolerance and
# range assertions); species counts are integers (checked exactly).

if (!requireNamespace("vegan", quietly = TRUE)) {
  cat("FAIL: package 'vegan' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(vegan))
cat(sprintf("vegan version: %s\n", as.character(packageVersion("vegan"))))

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

# Shared fixture: 6 sites x 5 species of Poisson counts. lambda 5 keeps every
# cell overwhelmingly likely to be > 0, so every row has positive total.
set.seed(42)
n_sites <- 6L
n_species <- 5L
comm <- matrix(rpois(n_sites * n_species, lambda = 5),
               nrow = n_sites, ncol = n_species)

run_test("shannon diversity is non-negative, one value per site", function() {
  h <- vegan::diversity(comm, index = "shannon")
  stopifnot(length(h) == n_sites)
  stopifnot(all(is.finite(h)), all(h >= 0))
})

run_test("simpson diversity stays within [0, 1]", function() {
  d <- vegan::diversity(comm, index = "simpson")
  stopifnot(length(d) == n_sites)
  stopifnot(all(d >= 0), all(d <= 1))
})

run_test("bray-curtis vegdist is a valid dissimilarity matrix", function() {
  bc <- vegan::vegdist(comm, method = "bray")
  stopifnot(inherits(bc, "dist"))
  # a dist over n objects holds choose(n, 2) pairwise values
  stopifnot(length(bc) == choose(n_sites, 2))
  stopifnot(attr(bc, "Size") == n_sites)
  v <- as.numeric(bc)
  stopifnot(all(is.finite(v)), all(v >= 0), all(v <= 1))
})

run_test("specnumber counts nonzero species exactly", function() {
  # hand-built matrix with a known number of nonzero species per row
  m <- matrix(c(1, 0, 2,
                0, 0, 3,
                4, 5, 6),
              nrow = 3, ncol = 3, byrow = TRUE)
  sn <- vegan::specnumber(m)
  stopifnot(length(sn) == 3L)
  stopifnot(identical(unname(as.numeric(sn)), c(2, 1, 3)))
})

run_test("rarefy expected richness never exceeds observed", function() {
  # rarefy to the smallest site total so every site can be subsampled
  sample_size <- min(rowSums(comm))
  er <- vegan::rarefy(comm, sample = sample_size)
  stopifnot(length(er) == n_sites)
  stopifnot(all(is.finite(er)), all(er >= 0))
  # expected rarefied richness <= observed richness (small tolerance)
  stopifnot(all(er <= vegan::specnumber(comm) + 1e-9))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all vegan smoke tests passed\n")
