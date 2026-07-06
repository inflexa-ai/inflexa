#!/usr/bin/env python3
"""Smoke test for the Python `pyfaidx` package.

Fully self-contained: no input files, no network, no packages beyond pyfaidx.
The FASTA fixture is synthesized into a tempfile at runtime; both it and the
`.fai` index pyfaidx builds beside it are deleted afterwards. Exercises the core
API surface and exits 0 only if every check passes, so it can be used as a
pass/fail library validator:

    python3 pyfaidx.py

Install: pip install pyfaidx   (import name: pyfaidx)

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
    import pyfaidx
except ImportError:
    print("FAIL: package 'pyfaidx' is not installed")
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


print(f"pyfaidx version: {_version(pyfaidx, 'pyfaidx')}")

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


# chr1 is 20 bp (two wrapped 10-bp lines), chr2 is 10 bp.
_FASTA_TEXT = ">chr1 first contig\nACGTACGTAC\nGTACGTACGT\n>chr2\nTTTTGGGGCC\n"


def _write_fasta():
    """Materialize the fixture FASTA into a tempfile; caller deletes it (+ .fai)."""
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".fa")
    with os.fdopen(fd, "w") as fh:
        fh.write(_FASTA_TEXT)
    return path


def test_indexed_fasta_access():
    path = _write_fasta()
    try:
        fa = pyfaidx.Fasta(path)
        try:
            # keys() preserves record order from the file.
            assert list(fa.keys()) == ["chr1", "chr2"]
            # slice -> FastaRecord/Sequence; .seq is the base string.
            assert fa["chr1"][0:4].seq == "ACGT"
            assert len(fa["chr1"]) == 20
            assert fa["chr2"][:].seq == "TTTTGGGGCC"
            # 1-based description helper: last base of chr1.
            assert fa["chr1"][-1:].seq == "T"
        finally:
            fa.close()
    finally:
        os.remove(path)
        # pyfaidx writes a samtools-style <path>.fai index beside the FASTA.
        fai = path + ".fai"
        if os.path.exists(fai):
            os.remove(fai)


run_test("indexed FASTA slice/len/keys", test_indexed_fasta_access)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pyfaidx smoke tests passed")
