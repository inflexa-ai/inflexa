#!/usr/bin/env python3
"""Smoke test for the Python `grpcio-tools` package.

Fully self-contained: no input files, no network, no packages beyond
grpcio-tools (and its implied deps: grpcio, protobuf). Exercises the core API
surface — compiling a tiny inline .proto written to a scratch tempdir — and
exits 0 only if every check passes, so it can be used as a pass/fail library
validator:

    python3 grpcio-tools.py

Install: pip install "grpcio-tools>=1.60"   (import name: grpc_tools)

Pin note: orbax-checkpoint otherwise resolves grpcio-tools 1.30.0, whose
setup.py imports the now-unavailable pkg_resources and fails to build — so pin
grpcio-tools >= 1.60.

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
    import grpc_tools
    from grpc_tools import protoc
except ImportError:
    print("FAIL: package 'grpcio-tools' is not installed")
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


# grpc_tools has no __version__; _version falls back to installed metadata.
print(f"grpcio-tools version: {_version(grpc_tools, 'grpcio-tools')}")

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


_PROTO = """syntax = "proto3";

package smoke;

message Ping {
  string id = 1;
  int32 seq = 2;
}

service Echo {
  rpc Send (Ping) returns (Ping);
}
"""


def _compile(tmpdir):
    """Run protoc over the inline .proto in tmpdir; return its exit code.

    grpc_tools bundles the well-known-type .proto includes; --proto_path points
    protoc at their location so imports resolve without a system protoc.
    """
    import pkg_resources

    proto_path = os.path.join(tmpdir, "smoke.proto")
    with open(proto_path, "w") as fh:
        fh.write(_PROTO)
    well_known = pkg_resources.resource_filename("grpc_tools", "_proto")
    return protoc.main(
        [
            "grpc_tools.protoc",
            f"--proto_path={tmpdir}",
            f"--proto_path={well_known}",
            f"--python_out={tmpdir}",
            f"--grpc_python_out={tmpdir}",
            proto_path,
        ]
    )


def test_protoc_returns_zero_and_emits_python():
    import tempfile

    tmpdir = tempfile.mkdtemp(prefix="grpc-smoke-")
    try:
        code = _compile(tmpdir)
        assert code == 0, f"protoc exited {code}"
        pb2 = os.path.join(tmpdir, "smoke_pb2.py")
        grpc_pb2 = os.path.join(tmpdir, "smoke_pb2_grpc.py")
        assert os.path.exists(pb2), "smoke_pb2.py not generated"
        assert os.path.exists(grpc_pb2), "smoke_pb2_grpc.py not generated"
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


run_test("protoc compiles inline .proto to python", test_protoc_returns_zero_and_emits_python)

if failures > 0:
    print(f"FAIL: {failures} test(s) failed")
    sys.exit(1)
print("PASS: all grpcio-tools smoke tests passed")
