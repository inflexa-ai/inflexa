#!/usr/bin/env Rscript
# Smoke test for the R `httr2` package.
#
# Fully self-contained: no input files, NO network, no packages beyond
# httr2 itself and its implied dependencies. Requests are only BUILT and
# INSPECTED, never performed: the one serialization check goes through
# req_dry_run(), which renders the request without sending it to the
# target host. Exercises the core API surface and exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript httr2.R

if (!requireNamespace("httr2", quietly = TRUE)) {
  cat("FAIL: package 'httr2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(httr2))
cat(sprintf("httr2 version: %s\n", as.character(packageVersion("httr2"))))

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

run_test("request construction", function() {
  req <- request("https://example.com/api")
  stopifnot(inherits(req, "httr2_request"))
  stopifnot(identical(req$url, "https://example.com/api"))
})

run_test("req_url_path_append composes the URL path", function() {
  req <- request("https://example.com/api")
  users <- req_url_path_append(req, "users")
  stopifnot(identical(users$url, "https://example.com/api/users"))
  nested <- req_url_path_append(req, "users", "42")
  stopifnot(identical(nested$url, "https://example.com/api/users/42"))
})

run_test("req_url_query adds query parameters", function() {
  req <- req_url_query(request("https://example.com/api"), a = 1, b = "x")
  stopifnot(grepl("?a=1&b=x", req$url, fixed = TRUE))
  stopifnot(identical(req$url, "https://example.com/api?a=1&b=x"))
})

run_test("req_headers sets headers", function() {
  req <- req_headers(request("https://example.com/api"),
                     Authorization = "Bearer t", `X-Smoke` = "1")
  # httr2 >= 1.2 stores headers in an S7 `httr2_headers` object and OBFUSCATES
  # secret headers (Authorization) — reading `req$headers$Authorization`
  # directly yields a weakref. Read through the public accessor with
  # `redacted = "reveal"` to get the plain values.
  h <- as.list(req_get_headers(req, redacted = "reveal"))
  stopifnot(identical(h$Authorization, "Bearer t"))
  stopifnot(identical(h[["X-Smoke"]], "1"))
})

run_test("req_method overrides the method", function() {
  req <- req_method(request("https://example.com/api"), "POST")
  stopifnot(identical(req$method, "POST"))
})

run_test("req_body_json attaches a JSON body", function() {
  req <- req_body_json(request("https://example.com/api"), list(k = "v"))
  stopifnot(!is.null(req$body))
  stopifnot(identical(req$body$data, list(k = "v")))
})

run_test("requests are immutable values", function() {
  base <- request("https://example.com/api")
  derived <- req_url_query(base, a = 1)
  stopifnot(identical(base$url, "https://example.com/api"))
  stopifnot(!identical(derived$url, base$url))
})

run_test("req_dry_run serializes without sending", function() {
  stopifnot(is.function(req_dry_run))
  # Some httr2 versions fake the transport through the *suggested* `httpuv`
  # package; when it is absent, settle for the structural check above rather
  # than failing the validator over an optional dependency. Either way,
  # nothing ever leaves the machine: the dry run never contacts example.com.
  if (!requireNamespace("httpuv", quietly = TRUE)) return(invisible(NULL))
  get_req <- req_headers(request("https://example.com/api"), `X-Smoke` = "1")
  out <- capture.output(info <- req_dry_run(get_req))
  stopifnot(length(out) > 0)
  stopifnot(identical(toupper(info$method), "GET"))
  post_req <- req_body_json(request("https://example.com/api"), list(k = "v"))
  post_info <- req_dry_run(post_req, quiet = TRUE)
  # A JSON body flips the *effective* method to POST even though req$method
  # stays NULL until the request is rendered.
  stopifnot(identical(toupper(post_info$method), "POST"))
})

run_test("url_parse extracts components", function() {
  u <- url_parse("https://u:p@host:8080/a/b?x=1#frag")
  stopifnot(identical(u$scheme, "https"))
  stopifnot(identical(u$hostname, "host"))
  stopifnot(identical(u$username, "u"))
  stopifnot(identical(u$password, "p"))
  # Port is a string in some httr2 versions and an integer in others;
  # as.character() makes the assertion hold for both.
  stopifnot(identical(as.character(u$port), "8080"))
  stopifnot(identical(u$path, "/a/b"))
  stopifnot(identical(u$query, list(x = "1")))
  stopifnot(identical(u$fragment, "frag"))
})

run_test("url_build roundtrips url_parse", function() {
  for (raw in c("https://u:p@host:8080/a/b?x=1#frag",
                "https://example.com/api?a=1&b=x")) {
    stopifnot(identical(url_build(url_parse(raw)), raw))
  }
})

run_test("url_modify updates components (when available)", function() {
  # url_modify() arrived in httr2 1.1.0; treat its absence as a skip, not a
  # failure, so the validator also passes on older httr2 installs.
  if (!exists("url_modify", envir = asNamespace("httr2"), inherits = FALSE)) {
    return(invisible(NULL))
  }
  stopifnot(identical(url_modify("https://example.com/a", path = "/b"),
                      "https://example.com/b"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all httr2 smoke tests passed\n")
