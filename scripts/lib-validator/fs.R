#!/usr/bin/env Rscript
# Smoke test for the R `fs` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# fs itself. Filesystem access is confined to a unique temp directory that
# the script creates and always deletes. Exercises the core API surface and
# exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript fs.R

if (!requireNamespace("fs", quietly = TRUE)) {
  cat("FAIL: package 'fs' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(fs))
cat(sprintf("fs version: %s\n", as.character(packageVersion("fs"))))

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

run_test("path composition", function() {
  p <- fs::path("a", "b", "c")
  stopifnot(inherits(p, "fs_path"))
  stopifnot(identical(as.character(p), "a/b/c"))
  stopifnot(identical(as.character(fs::path("a", "b", ext = "txt")), "a/b.txt"))
})

run_test("path_ext / path_ext_set", function() {
  stopifnot(identical(as.character(fs::path_ext("archive.tar.gz")), "gz"))
  stopifnot(identical(as.character(fs::path_ext_set("notes.txt", "md")), "notes.md"))
  stopifnot(identical(as.character(fs::path_ext("no_extension")), ""))
})

run_test("path_file / path_dir / path_norm", function() {
  stopifnot(identical(as.character(fs::path_file("/x/y/z.csv")), "z.csv"))
  stopifnot(identical(as.character(fs::path_dir("/x/y/z.csv")), "/x/y"))
  stopifnot(identical(as.character(fs::path_norm("a/../b/./c")), "b/c"))
})

run_test("path_rel / path_abs", function() {
  stopifnot(identical(as.character(fs::path_rel("/a/b/c", "/a")), "b/c"))
  stopifnot(identical(as.character(fs::path_abs("b", "/a")), "/a/b"))
})

run_test("path_split / path_join roundtrip", function() {
  parts <- fs::path_split("/a/b/c")[[1]]
  stopifnot(identical(as.character(parts), c("/", "a", "b", "c")))
  stopifnot(identical(as.character(fs::path_join(parts)), "/a/b/c"))
})

run_test("create/exists/list/delete cycle in tempdir", function() {
  # tempfile() mints a unique, not-yet-existing path under the session tempdir.
  d <- fs::path(tempfile("fs-smoke-"))
  on.exit(if (fs::dir_exists(d)) fs::dir_delete(d), add = TRUE)

  fs::dir_create(d)
  stopifnot(fs::dir_exists(d), fs::is_dir(d))

  f <- fs::path(d, "a.txt")
  fs::file_create(f)
  stopifnot(fs::file_exists(f), fs::is_file(f), !fs::is_dir(f))

  listed <- fs::dir_ls(d)
  stopifnot(length(listed) == 1L)
  stopifnot(identical(as.character(fs::path_file(listed)), "a.txt"))

  fs::dir_delete(d)
  stopifnot(!fs::dir_exists(d), !fs::file_exists(f))
})

run_test("is_dir / is_file on known paths", function() {
  stopifnot(identical(unname(as.logical(fs::is_dir(tempdir()))), TRUE))
  stopifnot(identical(unname(as.logical(fs::is_file(tempdir()))), FALSE))
  ghost <- fs::path(tempfile("fs-smoke-ghost-"))
  stopifnot(identical(unname(as.logical(fs::file_exists(ghost))), FALSE))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all fs smoke tests passed\n")
