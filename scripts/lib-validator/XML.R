#!/usr/bin/env Rscript
# Smoke test for the R `XML` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# XML itself. Parses an inline XML string and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript XML.R

if (!requireNamespace("XML", quietly = TRUE)) {
  cat("FAIL: package 'XML' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(XML))
cat(sprintf("XML version: %s\n", as.character(packageVersion("XML"))))

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

SAMPLE <- "<root><item id='1'>a</item><item id='2'>b</item></root>"

run_test("parse inline XML and inspect the root", function() {
  doc <- xmlParse(SAMPLE, asText = TRUE)
  root <- xmlRoot(doc)
  stopifnot(identical(xmlName(root), "root"))
  stopifnot(xmlSize(root) == 2L)
})

run_test("xpathSApply extracts values and attributes", function() {
  doc <- xmlParse(SAMPLE, asText = TRUE)
  stopifnot(identical(xpathSApply(doc, "//item", xmlValue), c("a", "b")))
  stopifnot(identical(xpathSApply(doc, "//item", xmlGetAttr, "id"), c("1", "2")))
})

run_test("getNodeSet selects by predicate", function() {
  doc <- xmlParse(SAMPLE, asText = TRUE)
  ns <- getNodeSet(doc, "//item[@id='2']")
  stopifnot(length(ns) == 1L)
  stopifnot(identical(xmlValue(ns[[1]]), "b"))
})

run_test("child access via [[ and xmlChildren", function() {
  doc <- xmlParse(SAMPLE, asText = TRUE)
  root <- xmlRoot(doc)
  first <- root[[1]]
  stopifnot(identical(xmlName(first), "item"))
  stopifnot(identical(xmlValue(first), "a"))
  stopifnot(length(xmlChildren(root)) == 2L)
})

run_test("build a node tree and serialize with saveXML", function() {
  top <- newXMLNode("top")
  newXMLNode("kid", "hello", parent = top)
  out <- saveXML(top)
  stopifnot(grepl("<kid>hello</kid>", out, fixed = TRUE))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all XML smoke tests passed\n")
