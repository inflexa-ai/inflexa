#!/usr/bin/env Rscript
# Smoke test for the R `remotes` package.
#
# Fully self-contained and OFFLINE: no input files, no network. Only the
# pure spec parsers are exercised -- `parse_repo_spec()` -- which do string
# parsing with no I/O. The networked surface (`install_*()`, `package_deps()`,
# `dev_package_deps()`) is deliberately NOT called. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript remotes.R

if (!requireNamespace("remotes", quietly = TRUE)) {
  cat("FAIL: package 'remotes' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(remotes))
cat(sprintf("remotes version: %s\n", as.character(packageVersion("remotes"))))

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

# A field is "empty" when the spec did not supply it; parse_repo_spec fills
# absent optional groups with either NA or an empty string across versions,
# so treat both as blank.
blank <- function(x) is.na(x) || !nzchar(as.character(x))

run_test("parse_repo_spec: user/repo@branch", function() {
  s <- remotes::parse_repo_spec("user/repo@branch")
  stopifnot(is.list(s))
  stopifnot(all(c("username", "repo", "ref") %in% names(s)))
  stopifnot(identical(as.character(s$username), "user"))
  stopifnot(identical(as.character(s$repo), "repo"))
  stopifnot(identical(as.character(s$ref), "branch"))
})

run_test("parse_repo_spec: user/repo/subdir", function() {
  s <- remotes::parse_repo_spec("user/repo/subdir")
  stopifnot(identical(as.character(s$username), "user"))
  stopifnot(identical(as.character(s$repo), "repo"))
  stopifnot(identical(as.character(s$subdir), "subdir"))
})

run_test("parse_repo_spec: bare user/repo has no ref", function() {
  s <- remotes::parse_repo_spec("user/repo")
  stopifnot(identical(as.character(s$username), "user"))
  stopifnot(identical(as.character(s$repo), "repo"))
  stopifnot(blank(s$ref))
})

run_test("parse_repo_spec: pkgname=user/repo captures package name", function() {
  s <- remotes::parse_repo_spec("mypkg=user/repo")
  stopifnot(identical(as.character(s$package), "mypkg"))
  stopifnot(identical(as.character(s$username), "user"))
  stopifnot(identical(as.character(s$repo), "repo"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all remotes smoke tests passed\n")
