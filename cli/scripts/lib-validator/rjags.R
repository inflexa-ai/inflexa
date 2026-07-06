#!/usr/bin/env Rscript
# Smoke test for the R `rjags` package.
#
# Fully self-contained: no input files, no network, no packages beyond rjags
# itself. Data is simulated with a fixed seed. Exercises the core JAGS
# interface -- compile a model, burn in, draw posterior samples -- and exits 0
# only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript rjags.R
#
# rjags links the external JAGS library at load time; it will not even load
# without a working libjags on the system, which is why an install-only miss
# fires the guard below. MCMC output is stochastic, so checks assert
# structural/robust properties (classes, dimensions, finiteness) and recover a
# known posterior mean only within a generous tolerance -- never exact equality.

if (!requireNamespace("rjags", quietly = TRUE)) {
  cat("FAIL: package 'rjags' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(rjags))
cat(sprintf("rjags version: %s\n", as.character(packageVersion("rjags"))))

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

# A tiny conjugate mean-estimation model shared by the tests: y_i ~ N(mu, 1/tau)
# with vague priors on mu and tau. With enough data the posterior mean of mu
# recovers the true data-generating mean.
model_string <- "
model {
  for (i in 1:N) {
    y[i] ~ dnorm(mu, tau)
  }
  mu ~ dnorm(0, 1.0E-4)
  tau ~ dgamma(0.01, 0.01)
}
"

run_test("jags.model compiles a model", function() {
  set.seed(1)
  y <- rnorm(200L, mean = 5, sd = 2)
  jm <- jags.model(
    textConnection(model_string),
    data = list(y = y, N = length(y)),
    n.chains = 2L,
    quiet = TRUE
  )
  stopifnot(inherits(jm, "jags"))
})

run_test("update burns in without error", function() {
  set.seed(2)
  y <- rnorm(200L, mean = 5, sd = 2)
  jm <- jags.model(
    textConnection(model_string),
    data = list(y = y, N = length(y)),
    n.chains = 2L,
    quiet = TRUE
  )
  update(jm, 500L, progress.bar = "none")
  # update mutates the model in place; it should still be a live jags object
  stopifnot(inherits(jm, "jags"))
})

run_test("coda.samples returns an mcmc.list with the monitored node", function() {
  set.seed(3)
  y <- rnorm(300L, mean = 5, sd = 2)
  jm <- jags.model(
    textConnection(model_string),
    data = list(y = y, N = length(y)),
    n.chains = 2L,
    quiet = TRUE
  )
  update(jm, 500L, progress.bar = "none")
  samp <- coda.samples(jm, variable.names = c("mu", "tau"),
                       n.iter = 2000L, progress.bar = "none")
  stopifnot(inherits(samp, "mcmc.list"))
  # one mcmc matrix per chain
  stopifnot(length(samp) == 2L)
  stopifnot(all(vapply(samp, function(ch) inherits(ch, "mcmc"), logical(1))))
  vn <- colnames(samp[[1]])
  stopifnot(all(c("mu", "tau") %in% vn))
  # each chain drew the requested number of iterations
  stopifnot(all(vapply(samp, nrow, integer(1)) == 2000L))
})

run_test("posterior mean of mu recovers the known truth", function() {
  set.seed(4)
  true_mu <- 5
  y <- rnorm(500L, mean = true_mu, sd = 2)
  jm <- jags.model(
    textConnection(model_string),
    data = list(y = y, N = length(y)),
    n.chains = 2L,
    quiet = TRUE
  )
  update(jm, 1000L, progress.bar = "none")
  samp <- coda.samples(jm, variable.names = "mu",
                       n.iter = 3000L, progress.bar = "none")
  # pool both chains' draws of mu
  mu_draws <- unlist(lapply(samp, function(ch) as.numeric(ch[, "mu"])))
  stopifnot(all(is.finite(mu_draws)))
  post_mean <- mean(mu_draws)
  stopifnot(is.finite(post_mean))
  # generous tolerance -- stochastic MCMC estimate of the posterior mean
  stopifnot(abs(post_mean - true_mu) < 0.4)
  # posterior precision tau should be positive
})

run_test("tau posterior is strictly positive", function() {
  set.seed(5)
  y <- rnorm(300L, mean = 0, sd = 3)
  jm <- jags.model(
    textConnection(model_string),
    data = list(y = y, N = length(y)),
    n.chains = 1L,
    quiet = TRUE
  )
  update(jm, 500L, progress.bar = "none")
  samp <- coda.samples(jm, variable.names = "tau",
                       n.iter = 2000L, progress.bar = "none")
  tau_draws <- as.numeric(samp[[1]][, "tau"])
  stopifnot(all(is.finite(tau_draws)), all(tau_draws > 0))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all rjags smoke tests passed\n")
