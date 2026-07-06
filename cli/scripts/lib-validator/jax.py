#!/usr/bin/env python3
"""Smoke test for the Python `jax` package.

Fully self-contained: no input files, no network, no packages beyond jax
(and its implied deps: jaxlib, numpy). Exercises the core API surface and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 jax.py

Install: pip install "jax<0.10"   (import name: jax)

Pin note: JAX 0.10.0 removed xla_pmap_p from jax.extend.core.primitives, but
numpyro (a transitive dependency of pertpy) still imports it — so pin jax below
0.10 until that import is fixed upstream.

This is the Python counterpart of data.table.R — same contract: a hard
not-installed guard (exit 1), a per-test harness that isolates failures, and a
PASS/exit-0 vs FAIL/exit-1 summary.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import jax
except ImportError:
    print("FAIL: package 'jax' is not installed")
    sys.exit(1)


def _version(mod, dist):
    """Best-effort version string: module.__version__, else installed metadata."""
    v = getattr(mod, "__version__", None)
    if v:
        return v
    try:
        import importlib.metadata as m

        return m.version(dist)
    except Exception:
        return "unknown"


print(f"jax version: {_version(jax, 'jax')}")

failures = 0


def run_test(name, fn):
    """Run one check; a raised exception is a failure, not a crash."""
    global failures
    try:
        fn()
    except Exception as e:  # noqa: BLE001 - any failure is a test failure
        failures += 1
        print(f"  FAIL {name}: {e}")
    else:
        print(f"  ok   {name}")


def test_jnp_array_ops():
    import jax.numpy as jnp

    a = jnp.array([1.0, 2.0, 3.0])
    assert a.shape == (3,)
    assert float(jnp.sum(a)) == 6.0
    assert jnp.allclose(a * 2.0, jnp.array([2.0, 4.0, 6.0]))


def test_grad():
    # d/dx x**2 at x=3 == 6.
    g = jax.grad(lambda x: x**2)
    assert abs(float(g(3.0)) - 6.0) < 1e-5


def test_jit():
    import jax.numpy as jnp

    f = jax.jit(lambda x: jnp.sum(x**2))
    x = jnp.array([1.0, 2.0, 3.0])
    assert abs(float(f(x)) - 14.0) < 1e-5


def test_vmap():
    import jax.numpy as jnp

    batched = jax.vmap(lambda x: x * 2.0)
    out = batched(jnp.array([1.0, 2.0, 3.0]))
    assert jnp.allclose(out, jnp.array([2.0, 4.0, 6.0]))


run_test("jnp array ops", test_jnp_array_ops)
run_test("grad of x**2 at 3 == 6", test_grad)
run_test("jit", test_jit)
run_test("vmap", test_vmap)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all jax smoke tests passed")
