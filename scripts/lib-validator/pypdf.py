#!/usr/bin/env python3
"""Smoke test for the Python `pypdf` package.

Fully self-contained: no input files, no network, no packages beyond pypdf (and
its implied deps). Exercises the core API surface and exits 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 pypdf.py

Install: pip install pypdf   (import name: pypdf)

NOTE — pypdf reads and manipulates PDFs, it is not a content-authoring library:
there is no reportlab-style drawing API here. So these checks synthesize input
with `PdfWriter.add_blank_page(width=..., height=...)` (points; 72pt = 1 inch),
then read it back and merge, which is the whole read/write/merge surface without
any external PDF file.

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
    import pypdf
except ImportError:
    print("FAIL: package 'pypdf' is not installed")
    sys.exit(1)

import io
import tempfile


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


print(f"pypdf version: {_version(pypdf, 'pypdf')}")

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


def test_blank_page_write_read_tempfile():
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=72, height=72)
    fd, path = tempfile.mkstemp(suffix=".pdf")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            writer.write(fh)
        assert os.path.getsize(path) > 0
        reader = pypdf.PdfReader(path)
        assert len(reader.pages) == 1
        # add_blank_page dimensions are in points; the mediabox echoes them.
        page = reader.pages[0]
        assert float(page.mediabox.width) == 72.0
        assert float(page.mediabox.height) == 72.0
    finally:
        os.remove(path)


def test_write_to_bytesio_starts_with_pdf_magic():
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=100, height=120)
    buf = io.BytesIO()
    writer.write(buf)
    data = buf.getvalue()
    assert data[:4] == b"%PDF"
    reader = pypdf.PdfReader(io.BytesIO(data))
    assert len(reader.pages) == 1


def test_merge_two_writers():
    a = pypdf.PdfWriter()
    a.add_blank_page(width=72, height=72)
    b = pypdf.PdfWriter()
    b.add_blank_page(width=72, height=72)

    buf_a, buf_b = io.BytesIO(), io.BytesIO()
    a.write(buf_a)
    b.write(buf_b)
    buf_a.seek(0)
    buf_b.seek(0)

    merged = pypdf.PdfWriter()
    merged.append(pypdf.PdfReader(buf_a))
    merged.append(pypdf.PdfReader(buf_b))
    out = io.BytesIO()
    merged.write(out)

    reader = pypdf.PdfReader(io.BytesIO(out.getvalue()))
    assert len(reader.pages) == 2


run_test("blank page write/read tempfile", test_blank_page_write_read_tempfile)
run_test("write to BytesIO (%PDF magic)", test_write_to_bytesio_starts_with_pdf_magic)
run_test("merge two writers -> 2 pages", test_merge_two_writers)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all pypdf smoke tests passed")
