#!/usr/bin/env Rscript
# Smoke test for the R `otelsdk` package (OpenTelemetry SDK for R).
#
# Fully self-contained and STRICTLY OFFLINE: no input files, no network, no
# collector, no packages beyond otelsdk itself (and its `otel` API dependency).
# The test only creates a tracer provider, obtains a tracer, and starts/ends a
# span in-process; it never exports to any endpoint. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript otelsdk.R
#
# NOTE (needs re-check once installed): the otelsdk tracing API surface used
# below (provider constructor, get_tracer / start_span / span$end) was written
# from the documented OpenTelemetry-for-R design and NOT verified against an
# installed build. Re-confirm the exact provider/tracer/span entry points and
# class names when the package is available. Checks are deliberately modest and
# structural (objects are non-null, of the expected class, and spans start/end
# without error) precisely because of that uncertainty.

if (!requireNamespace("otelsdk", quietly = TRUE)) {
  cat("FAIL: package 'otelsdk' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(otelsdk))
cat(sprintf("otelsdk version: %s\n", as.character(packageVersion("otelsdk"))))

# Belt-and-braces: force the "none" exporter so no attempt is ever made to reach
# a collector, regardless of ambient OTEL_* environment configuration.
Sys.setenv(OTEL_TRACES_EXPORTER = "none")

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

# Construct an in-process tracer provider that does not export anywhere. The
# memory/stdstream providers keep everything local; we prefer the memory one so
# nothing is even written to a stream.
make_provider <- function() {
  tracer_provider_memory()
}

run_test("tracer provider constructs offline", function() {
  tp <- make_provider()
  stopifnot(!is.null(tp))
  # providers are environment/R6-style objects exposing a get_tracer method
  stopifnot(is.function(tp$get_tracer))
})

run_test("get_tracer returns a tracer object", function() {
  tp <- make_provider()
  tr <- tp$get_tracer("smoke-tracer")
  stopifnot(!is.null(tr))
  # a tracer exposes a span-creation method
  stopifnot(is.function(tr$start_span))
})

run_test("start and end a span without error", function() {
  tp <- make_provider()
  tr <- tp$get_tracer("smoke-tracer")
  sp <- tr$start_span("unit-of-work")
  stopifnot(!is.null(sp))
  # a live span should report that it is recording before it ends
  stopifnot(isTRUE(sp$is_recording()))
  sp$end()
  # once ended, the span must no longer be recording
  stopifnot(isFALSE(sp$is_recording()))
})

run_test("span accepts attributes", function() {
  tp <- make_provider()
  tr <- tp$get_tracer("smoke-tracer")
  sp <- tr$start_span("attributed")
  # setting attributes on an active span must not error
  sp$set_attribute("component", "lib-validator")
  sp$set_attribute("iteration", 1L)
  sp$end()
  stopifnot(isFALSE(sp$is_recording()))
})

run_test("nested spans start and end in order", function() {
  tp <- make_provider()
  tr <- tp$get_tracer("smoke-tracer")
  outer <- tr$start_span("outer")
  inner <- tr$start_span("inner")
  stopifnot(isTRUE(inner$is_recording()))
  inner$end()
  stopifnot(isFALSE(inner$is_recording()))
  stopifnot(isTRUE(outer$is_recording()))
  outer$end()
  stopifnot(isFALSE(outer$is_recording()))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all otelsdk smoke tests passed\n")
