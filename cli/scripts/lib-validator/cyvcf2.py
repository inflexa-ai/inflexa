#!/usr/bin/env python3
"""Smoke test for the Python `cyvcf2` package.

Fully self-contained: no input files, no network, no packages beyond cyvcf2
(and its implied deps: numpy). The VCF fixture is synthesized into a tempfile
at runtime and deleted afterwards. Exercises the core API surface and exits 0
only if every check passes, so it can be used as a pass/fail library validator:

    python3 cyvcf2.py

Install: pip install cyvcf2   (import name: cyvcf2)

NOTE: cyvcf2 is a thin Cython wrapper over htslib; the wheel bundles htslib, but
a source build needs htslib (libhts) present at build time. If import fails on a
freshly built cyvcf2, that is usually a missing/mismatched htslib.

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
    import cyvcf2
except ImportError:
    print("FAIL: package 'cyvcf2' is not installed")
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


print(f"cyvcf2 version: {_version(cyvcf2, 'cyvcf2')}")

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


# A minimal but valid VCF v4.2: header + contig/FORMAT lines + two records with
# one genotyped sample. First record is a heterozygote (0/1), second is
# homozygous-alt (1/1).
_VCF_TEXT = (
    "##fileformat=VCFv4.2\n"
    "##contig=<ID=chr1,length=1000>\n"
    '##FILTER=<ID=PASS,Description="All filters passed">\n'
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n'
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE1\n"
    "chr1\t100\t.\tA\tT\t50\tPASS\t.\tGT\t0/1\n"
    "chr1\t200\trs2\tG\tC\t60\tPASS\t.\tGT\t1/1\n"
)


def _write_vcf():
    """Materialize the fixture VCF into a tempfile; caller deletes it."""
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".vcf")
    with os.fdopen(fd, "w") as fh:
        fh.write(_VCF_TEXT)
    return path


def test_read_variants_and_fields():
    path = _write_vcf()
    try:
        vcf = cyvcf2.VCF(path)
        try:
            assert vcf.samples == ["SAMPLE1"]
            variants = list(vcf)
            assert len(variants) == 2

            v0 = variants[0]
            assert v0.CHROM == "chr1"
            assert v0.POS == 100  # cyvcf2 exposes POS as 1-based
            assert v0.REF == "A"
            assert v0.ALT == ["T"]

            v1 = variants[1]
            assert v1.POS == 200
            assert v1.REF == "G"
            assert v1.ALT == ["C"]
            assert v1.ID == "rs2"
        finally:
            vcf.close()
    finally:
        os.remove(path)


def test_genotype_types():
    # gts012=True fixes the encoding to HOM_REF=0, HET=1, HOM_ALT=2, UNKNOWN=3,
    # which is stable to assert against (the default encoding differs).
    path = _write_vcf()
    try:
        vcf = cyvcf2.VCF(path, gts012=True)
        try:
            variants = list(vcf)
            # gt_types is a numpy int array, one entry per sample.
            assert list(variants[0].gt_types) == [1]  # 0/1 -> HET
            assert list(variants[1].gt_types) == [2]  # 1/1 -> HOM_ALT
        finally:
            vcf.close()
    finally:
        os.remove(path)


run_test("read variants + CHROM/POS/REF/ALT", test_read_variants_and_fields)
run_test("genotype types (gt_types)", test_genotype_types)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all cyvcf2 smoke tests passed")
