#!/usr/bin/env python3
"""Smoke test for the Python `rpds-py` package.

Fully self-contained: no input files, no network, no packages beyond rpds-py.
Exercises the core API surface and exits 0 only if every check passes, so it
can be used as a pass/fail library validator:

    python3 rpds-py.py

Install: pip install rpds-py   (import name: rpds)

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
    import rpds
except ImportError:
    print("FAIL: package 'rpds-py' is not installed")
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


print(f"rpds-py version: {_version(rpds, 'rpds-py')}")

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


def test_hash_trie_map_insert_is_immutable():
    from rpds import HashTrieMap

    m = HashTrieMap({"a": 1})
    m2 = m.insert("b", 2)
    # insert returns a NEW map; the original is untouched (persistent structure).
    assert len(m) == 1 and len(m2) == 2
    assert "b" not in m and "b" in m2
    assert m.get("a") == 1 and m2.get("b") == 2
    assert m.get("missing") is None
    assert dict(m2.items()) == {"a": 1, "b": 2}
    assert dict(m.items()) == {"a": 1}


def test_hash_trie_map_equality():
    from rpds import HashTrieMap

    assert HashTrieMap({"a": 1, "b": 2}) == HashTrieMap({"b": 2, "a": 1})
    assert HashTrieMap({"a": 1}) != HashTrieMap({"a": 2})


def test_hash_trie_set_insert_discard_immutable():
    from rpds import HashTrieSet

    s = HashTrieSet([1, 2, 3])
    s_ins = s.insert(4)
    s_dis = s.discard(2)
    # Both derivations leave the source set unchanged.
    assert len(s) == 3
    assert len(s_ins) == 4 and 4 in s_ins and 4 not in s
    assert len(s_dis) == 2 and 2 not in s_dis and 2 in s


def test_list_push_front_first_rest():
    from rpds import List

    li = List([1, 2, 3])
    li2 = li.push_front(0)
    # push_front prepends onto a NEW list; the original is unchanged.
    assert len(li) == 3 and len(li2) == 4
    assert li.first == 1 and li2.first == 0
    assert list(li.rest) == [2, 3]
    assert list(li) == [1, 2, 3]


def test_list_equality_and_iteration():
    from rpds import List

    assert List([1, 2, 3]) == List([1, 2, 3])
    assert List([1, 2, 3]) != List([1, 2])
    assert list(List([1, 2, 3]).push_front(0)) == [0, 1, 2, 3]


run_test("HashTrieMap insert is immutable", test_hash_trie_map_insert_is_immutable)
run_test("HashTrieMap equality", test_hash_trie_map_equality)
run_test("HashTrieSet insert/discard immutable", test_hash_trie_set_insert_discard_immutable)
run_test("List push_front/first/rest", test_list_push_front_first_rest)
run_test("List equality and iteration", test_list_equality_and_iteration)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all rpds-py smoke tests passed")
