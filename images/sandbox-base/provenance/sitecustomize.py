"""
Provenance tracking for Python scripts in Inflexa sandbox containers.

Installs a CPython audit hook (PEP 578) that intercepts file open events
and reports reads, writes, and deletes within data directories to the
sandbox-server via a Unix domain socket.

The hook is C-level and cannot be removed once installed.

Loaded automatically by Python's site module when PYTHONPATH includes
the directory containing this file.
"""

import json
import os
import socket
import sys
import time

PROV_SOCKET = os.environ.get("PROVENANCE_SOCKET", "")
DATA_PREFIXES = tuple(
    os.environ.get("PROVENANCE_DATA_PREFIXES", "/data/").split(":")
)
# Dedup by (path, op) — same file can be read AND written
_seen: set[tuple[str, str]] = set()
_DEDUP_CAP = 32768
_debug = os.environ.get("PROVENANCE_DEBUG") == "1"


def _send(path: str, op: str) -> None:
    """Send a provenance datagram. Failures are silently ignored."""
    if not PROV_SOCKET:
        return
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.sendto(
            json.dumps(
                {"t": time.time(), "p": path, "pid": os.getpid(),
                 "layer": "python", "op": op}
            ).encode(),
            PROV_SOCKET,
        )
        s.close()
    except Exception as e:
        if _debug:
            print(f"[provtrack-py] send failed: {e}", file=sys.stderr)


def _check_and_send(path: str, op: str) -> None:
    """Resolve path, check prefix, dedup, and send."""
    abspath = os.path.abspath(path)
    if not any(abspath.startswith(prefix) for prefix in DATA_PREFIXES):
        return
    key = (abspath, op)
    if len(_seen) < _DEDUP_CAP:
        if key in _seen:
            return
        _seen.add(key)
    _send(abspath, op)


def _audit_hook(event: str, args: tuple) -> None:
    if event == "open":
        if not args or not isinstance(args[0], str):
            return
        path = args[0]

        # Classify by mode
        op = "read"  # default
        if len(args) > 1 and isinstance(args[1], str):
            mode = args[1]
            if any(c in mode for c in ("w", "a", "x")):
                op = "write"
        elif len(args) > 2:
            # flags-based open (os.open)
            flags = args[2] if isinstance(args[2], int) else 0
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
                op = "write"

        _check_and_send(path, op)

    elif event in ("os.remove", "os.unlink"):
        if args and isinstance(args[0], str):
            _check_and_send(args[0], "delete")


if PROV_SOCKET:
    sys.addaudithook(_audit_hook)
