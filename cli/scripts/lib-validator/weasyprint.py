#!/usr/bin/env python3
"""Smoke test for the Python `weasyprint` package.

Fully self-contained: no input files, no network, no packages beyond weasyprint
(and its implied deps). Exercises the core API surface and exits 0 only if every
check passes, so it can be used as a pass/fail library validator:

    python3 weasyprint.py

Install: pip install weasyprint   (import name: weasyprint)

NOTE — native library dependency: weasyprint renders through Pango, Cairo and
gdk-pixbuf, which are SYSTEM libraries (not pip-installable). Even with the
Python package present, `import weasyprint` raises OSError at import time if the
shared libs are missing (`brew install pango`, or the distro's libpango/cairo/
gdk-pixbuf packages). A green run here therefore also attests the native stack.

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
    import weasyprint
except ImportError:
    print("FAIL: package 'weasyprint' is not installed")
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


print(f"weasyprint version: {_version(weasyprint, 'weasyprint')}")

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


def test_html_string_renders_pdf_bytes():
    pdf = weasyprint.HTML(string="<h1>Hi</h1>").write_pdf()
    assert isinstance(pdf, (bytes, bytearray))
    # Every PDF file begins with the "%PDF" magic header.
    assert bytes(pdf[:4]) == b"%PDF"
    assert len(pdf) > 0


def test_richer_document_still_produces_pdf():
    html = "<html><body><h1>Title</h1><p>A paragraph.</p><ul><li>a</li><li>b</li></ul></body></html>"
    pdf = weasyprint.HTML(string=html).write_pdf()
    assert bytes(pdf[:4]) == b"%PDF"
    # A real PDF ends with the end-of-file marker.
    assert b"%%EOF" in bytes(pdf[-1024:])


run_test("HTML string -> PDF bytes", test_html_string_renders_pdf_bytes)
run_test("richer document -> PDF", test_richer_document_still_produces_pdf)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all weasyprint smoke tests passed")
