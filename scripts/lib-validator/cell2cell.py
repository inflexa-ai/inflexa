#!/usr/bin/env python3
"""Smoke test for the Python `cell2cell` package (Tensor-cell2cell).

Fully self-contained: no input files, no network. Exercises the tensor
decomposition path and exits 0 only if every check passes, so it can be used as
a pass/fail library validator:

    python3 cell2cell.py

Install: pip install cell2cell   (import name: cell2cell)

Same contract as liana.py: a hard not-installed guard (exit 1), a per-test
harness that isolates failures, and a PASS/exit-0 vs FAIL/exit-1 summary.

REAL COMPUTATION, not just an import check. cell2cell is here for exactly one
capability — factorizing a multi-context communication tensor that liana builds
via `li.multi.to_tensor_c2c()` — so asserting the import alone would not tell us
that capability works. The tests below run a real decomposition on a synthetic
tensor with known low-rank structure and assert the factors come back with the
right shapes, and that elbow rank selection recovers the rank that was planted.

Both run offline: the decomposition backend is tensorly and the elbow is kneed,
neither of which fetches anything. A tensor of this size solves in well under a
second.
"""
import os
import sys

# This file is named after the package it tests, so it sits next to (and would
# shadow) the real top-level module. Drop this script's own directory from the
# import path before importing the package under test.
_here = os.path.dirname(os.path.abspath(__file__))
sys.path = [p for p in sys.path if p not in ("", ".") and os.path.abspath(p) != _here]

try:
    import numpy as np

    import cell2cell
except ImportError as e:
    print(f"FAIL: package 'cell2cell' is not installed ({e})")
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


print(f"cell2cell version: {_version(cell2cell, 'cell2cell')}")

failures = 0

# A tensor with genuine rank-2 structure plus a little noise, shaped like what
# `to_tensor_c2c()` produces: contexts x ligand-receptor pairs x senders x
# receivers. Planted structure is what makes the elbow assertion meaningful —
# on noise alone kneed correctly finds no knee and returns None.
RANK = 2
_rng = np.random.default_rng(0)
_dims = (6, 8, 6, 6)
_factors = [_rng.random((n, RANK)) for n in _dims]
_data = np.einsum("ir,jr,kr,lr->ijkl", *_factors) + 0.01 * _rng.random(_dims)

ORDER_NAMES = [
    [f"context{i}" for i in range(_dims[0])],
    [f"L{i}^R{i}" for i in range(_dims[1])],
    [f"sender{i}" for i in range(_dims[2])],
    [f"receiver{i}" for i in range(_dims[3])],
]
ORDER_LABELS = ["Contexts", "Ligand-Receptor Pairs", "Sender Cells", "Receiver Cells"]


def _tensor():
    return cell2cell.tensor.PreBuiltTensor(
        _data, order_names=ORDER_NAMES, order_labels=ORDER_LABELS
    )


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


def test_exposes_tensor_namespace():
    assert hasattr(cell2cell, "tensor")
    assert hasattr(cell2cell.tensor, "PreBuiltTensor")


def test_factorization_returns_correctly_shaped_factors():
    t = _tensor()
    t.compute_tensor_factorization(rank=RANK, random_state=0)
    assert t.factors is not None, "no factors after compute_tensor_factorization"
    assert len(t.factors) == len(_dims), f"expected {len(_dims)} factor matrices"
    for label, dim in zip(ORDER_LABELS, _dims):
        assert label in t.factors, f"missing factor for {label}"
        assert t.factors[label].shape == (dim, RANK), (
            f"{label}: expected {(dim, RANK)}, got {t.factors[label].shape}"
        )


def test_elbow_recovers_the_planted_rank():
    t = _tensor()
    t.elbow_rank_selection(upper_rank=5, runs=1, random_state=0)
    assert t.rank == RANK, f"elbow chose rank {t.rank}, expected {RANK}"


run_test("exposes cell2cell.tensor.PreBuiltTensor", test_exposes_tensor_namespace)
run_test("tensor factorization yields correctly shaped factors", test_factorization_returns_correctly_shaped_factors)
run_test("elbow rank selection recovers the planted rank", test_elbow_recovers_the_planted_rank)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cell2cell smoke tests passed")
