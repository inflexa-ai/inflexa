#!/usr/bin/env python3
"""Smoke test for the Python `plotly` package.

Fully self-contained: no input files, no network, no packages beyond plotly
(and its implied deps — pandas for the express test). Builds figures purely as
in-memory objects and serializes them to dict/JSON; it never renders to an
image or opens a browser (rendering would need kaleido + a Chromium backend).
Exercises the graph-object / express API and exits 0 only if every check
passes, so it can be used as a pass/fail library validator:

    python3 plotly.py

Install: pip install plotly   (import name: plotly)

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
    import plotly
except ImportError:
    print("FAIL: package 'plotly' is not installed")
    sys.exit(1)

import json

import plotly.express as px
import plotly.graph_objects as go


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


print(f"plotly version: {_version(plotly, 'plotly')}")

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


def test_scatter_trace_data_roundtrips():
    fig = go.Figure(data=go.Scatter(x=[1, 2, 3], y=[4, 5, 6], mode="lines+markers"))
    assert len(fig.data) == 1
    trace = fig.data[0]
    assert tuple(trace.x) == (1, 2, 3)
    assert tuple(trace.y) == (4, 5, 6)
    assert trace.type == "scatter"


def test_to_dict_structure():
    fig = go.Figure(data=go.Scatter(x=[0, 1], y=[10, 20]))
    fig.update_layout(title="smoke")
    d = fig.to_dict()
    assert "data" in d and "layout" in d
    assert d["data"][0]["type"] == "scatter"
    assert tuple(d["data"][0]["x"]) == (0, 1)
    assert tuple(d["data"][0]["y"]) == (10, 20)
    assert d["layout"]["title"]["text"] == "smoke"


def test_to_json_is_parseable():
    fig = go.Figure(data=go.Scatter(x=[1, 2], y=[3, 4]))
    s = fig.to_json()
    assert isinstance(s, str)
    parsed = json.loads(s)
    assert parsed["data"][0]["type"] == "scatter"
    assert list(parsed["data"][0]["x"]) == [1, 2]


def test_express_scatter_returns_figure():
    import pandas as pd

    df = pd.DataFrame({"a": [1, 2, 3], "b": [3, 2, 1]})
    fig = px.scatter(df, x="a", y="b")
    assert isinstance(fig, go.Figure)
    assert len(fig.data) == 1
    assert tuple(fig.data[0].x) == (1, 2, 3)
    assert tuple(fig.data[0].y) == (3, 2, 1)


def test_add_trace_accumulates():
    fig = go.Figure()
    fig.add_trace(go.Bar(x=["a", "b"], y=[1, 2]))
    fig.add_trace(go.Scatter(x=["a", "b"], y=[2, 1]))
    assert len(fig.data) == 2
    assert fig.data[0].type == "bar"
    assert fig.data[1].type == "scatter"


run_test("scatter trace data roundtrips", test_scatter_trace_data_roundtrips)
run_test("to_dict structure", test_to_dict_structure)
run_test("to_json is parseable", test_to_json_is_parseable)
run_test("express scatter returns Figure", test_express_scatter_returns_figure)
run_test("add_trace accumulates", test_add_trace_accumulates)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all plotly smoke tests passed")
