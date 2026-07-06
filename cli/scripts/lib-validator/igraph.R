#!/usr/bin/env Rscript
# Smoke test for the R `igraph` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# igraph itself. Graphs are tiny hand-built structures (a triangle, a ring)
# or fixed-seed random graphs. Exercises the core graph-construction, metric,
# and path API, and exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript igraph.R
#
# Structural quantities (vertex/edge counts, degrees, hop distances, component
# sizes) are integers, checked EXACTLY; centralities are floating-point,
# checked for finiteness and sign only.

if (!requireNamespace("igraph", quietly = TRUE)) {
  cat("FAIL: package 'igraph' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(igraph))
cat(sprintf("igraph version: %s\n", as.character(packageVersion("igraph"))))

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

run_test("graph_from_literal builds a connected triangle", function() {
  g <- igraph::graph_from_literal(A - B, B - C, C - A)
  stopifnot(igraph::vcount(g) == 3L)
  stopifnot(igraph::ecount(g) == 3L)
  # every vertex of a triangle has degree 2
  stopifnot(all(igraph::degree(g) == 2L))
  stopifnot(isTRUE(igraph::is_connected(g)))
})

run_test("distances on a triangle are all one hop", function() {
  g <- igraph::graph_from_literal(A - B, B - C, C - A)
  d <- igraph::distances(g)
  stopifnot(is.matrix(d), identical(dim(d), c(3L, 3L)))
  stopifnot(all(diag(d) == 0))
  # off-diagonal geodesics are exactly 1 in a complete triangle
  stopifnot(all(d[upper.tri(d)] == 1))
})

run_test("make_ring gives predictable hop distances", function() {
  ring <- igraph::make_ring(5)
  stopifnot(igraph::vcount(ring) == 5L, igraph::ecount(ring) == 5L)
  d <- igraph::distances(ring)
  stopifnot(d[1, 2] == 1) # adjacent
  stopifnot(d[1, 3] == 2) # two hops around the ring
  stopifnot(max(d) == 2) # diameter of a 5-ring is floor(5 / 2) = 2
})

run_test("shortest_paths returns a path of the expected length", function() {
  ring <- igraph::make_ring(5)
  sp <- igraph::shortest_paths(ring, from = 1, to = 3)
  vpath <- sp$vpath[[1]]
  # a shortest 1 -> 3 path on the ring visits 3 vertices (2 hops)
  stopifnot(length(vpath) == 3L)
})

run_test("sample_gnp with a seed has stable structure", function() {
  set.seed(7)
  g <- igraph::sample_gnp(n = 50, p = 0.1)
  stopifnot(igraph::vcount(g) == 50L)
  stopifnot(igraph::ecount(g) >= 0L, is.finite(igraph::ecount(g)))
  comp <- igraph::components(g)
  stopifnot(comp$no >= 1L)
  # every vertex belongs to exactly one component
  stopifnot(sum(comp$csize) == 50L)
  stopifnot(length(comp$membership) == 50L)
})

run_test("betweenness and closeness are finite on a connected graph", function() {
  ring <- igraph::make_ring(5)
  bt <- igraph::betweenness(ring)
  stopifnot(length(bt) == 5L, all(is.finite(bt)), all(bt >= 0))
  cl <- igraph::closeness(ring)
  stopifnot(length(cl) == 5L, all(is.finite(cl)), all(cl > 0))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all igraph smoke tests passed\n")
