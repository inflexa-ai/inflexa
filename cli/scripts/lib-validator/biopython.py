#!/usr/bin/env python3
"""Smoke test for the Python `biopython` package (import name: Bio).

Fully self-contained: no input files, no network, no packages beyond biopython
(and its implied deps: numpy). Exercises the core API surface and exits 0 only
if every check passes, so it can be used as a pass/fail library validator:

    python3 biopython.py

Install: pip install biopython   (import name: Bio)

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
    import Bio
except ImportError:
    print("FAIL: package 'biopython' is not installed")
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


print(f"biopython version: {_version(Bio, 'biopython')}")

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


def test_seq_basic_operations():
    from Bio.Seq import Seq

    s = Seq("ATGGCC")
    assert len(s) == 6
    # complement A<->T, G<->C: ATGGCC -> TACCGG
    assert str(s.complement()) == "TACCGG"
    # reverse of the complement
    assert str(s.reverse_complement()) == "GGCCAT"
    # ATG=Met(M), GCC=Ala(A)
    assert str(s.translate()) == "MA"
    assert s.count("G") == 2


def test_gc_fraction():
    from Bio.Seq import Seq
    from Bio.SeqUtils import gc_fraction

    # ATGGCC has 4 G/C out of 6 bases -> 0.6667 (gc_fraction returns a fraction,
    # not a percentage).
    frac = gc_fraction(Seq("ATGGCC"))
    assert abs(frac - (4.0 / 6.0)) < 1e-9


def test_seqrecord():
    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord

    rec = SeqRecord(Seq("ACGTACGT"), id="rec1", description="demo record")
    assert rec.id == "rec1"
    assert str(rec.seq) == "ACGTACGT"
    assert len(rec) == 8
    assert rec.description == "demo record"


def test_seqio_parse_inline_fasta():
    import io

    from Bio import SeqIO

    # Parse an in-memory FASTA string via StringIO — no external file touched.
    handle = io.StringIO(">x description here\nACGT\nTTGG\n")
    records = list(SeqIO.parse(handle, "fasta"))
    assert len(records) == 1
    assert records[0].id == "x"
    assert str(records[0].seq) == "ACGTTTGG"


def test_pairwise_aligner():
    import math

    from Bio.Align import PairwiseAligner

    aligner = PairwiseAligner()
    # Default global aligner: match=1, mismatch/gap=0. Identical 4-mers -> 4.0.
    alignments = aligner.align("ACGT", "ACGT")
    assert math.isfinite(alignments.score)
    assert alignments.score == 4.0
    # A single-mismatch pair must score strictly lower than the perfect match.
    mismatched = aligner.align("ACGT", "ACGA")
    assert mismatched.score < alignments.score


run_test("Seq complement/reverse_complement/translate/count", test_seq_basic_operations)
run_test("GC content via gc_fraction", test_gc_fraction)
run_test("SeqRecord id + seq", test_seqrecord)
run_test("SeqIO.parse inline FASTA (StringIO)", test_seqio_parse_inline_fasta)
run_test("PairwiseAligner score is finite + exact", test_pairwise_aligner)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all biopython smoke tests passed")
