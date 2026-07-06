#!/usr/bin/env python3
"""Smoke test for the Python `Pillow` package (imported as `PIL`).

Fully self-contained: no input files, no network, no packages beyond Pillow
(and its implied deps). Exercises the core imaging API and exits 0 only if
every check passes, so it can be used as a pass/fail library validator:

    python3 Pillow.py

Install: pip install Pillow   (import name: PIL)

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
    import PIL
    from PIL import Image
except ImportError:
    print("FAIL: package 'Pillow' is not installed")
    sys.exit(1)

import tempfile


def _version(mod, dist):
    """Best-effort version string: module.__version__, else installed metadata.

    The dist name is `Pillow`, the import name is `PIL`; when `PIL.__version__`
    is absent this falls back to the installed-distribution metadata for Pillow.
    """
    v = getattr(mod, "__version__", None)
    if v:
        return v
    try:
        import importlib.metadata as m

        return m.version(dist)
    except Exception:
        return "unknown"


print(f"Pillow version: {_version(PIL, 'Pillow')}")

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


def test_new_image_size_mode_pixel():
    img = Image.new("RGB", (16, 8), (255, 0, 0))
    assert img.size == (16, 8)
    assert img.mode == "RGB"
    assert img.getpixel((0, 0)) == (255, 0, 0)


def test_grayscale_conversion():
    img = Image.new("RGB", (16, 8), (255, 0, 0))
    grey = img.convert("L")
    assert grey.mode == "L"
    assert grey.size == (16, 8)
    # Pure red maps to luminance 0.299*255 ≈ 76 under ITU-R 601-2 (Pillow's L).
    px = grey.getpixel((0, 0))
    assert isinstance(px, int)
    assert 70 <= px <= 82


def test_resize():
    img = Image.new("RGB", (16, 8), (255, 0, 0))
    small = img.resize((8, 4))
    assert small.size == (8, 4)


def test_rotate_expand():
    img = Image.new("RGB", (16, 8), (255, 0, 0))
    rotated = img.rotate(90, expand=True)
    # A 90-degree rotation with expand swaps width and height.
    assert rotated.size == (8, 16)


def test_save_and_reopen_png():
    img = Image.new("RGB", (16, 8), (0, 128, 255))
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        img.save(path)
        assert os.path.getsize(path) > 0
        with Image.open(path) as reopened:
            assert reopened.size == (16, 8)
            assert reopened.mode == "RGB"
    finally:
        os.remove(path)


run_test("new image size/mode/pixel", test_new_image_size_mode_pixel)
run_test("grayscale conversion", test_grayscale_conversion)
run_test("resize", test_resize)
run_test("rotate with expand", test_rotate_expand)
run_test("save and reopen PNG", test_save_and_reopen_png)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all Pillow smoke tests passed")
