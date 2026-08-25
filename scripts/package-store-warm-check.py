#!/usr/bin/env python3
"""The cache check of the package store. It runs INSIDE the sandbox image.

A prepared cache on disk is not evidence. numba selects its cache directory by
a write probe, and it keys each entry on the type signature of the call and on
the absolute directory of the source. Thus a cache can be present and miss on
every call. This program replays each recorded warm workload with the cache
debug on, and it reads the line that numba writes for each cache file that it
loads or saves.

The record of the preparation run decides the result: the `warm` field of the
farm `inflexa.lock` holds, per package, the script, its hash, and the cache
entries that a later run of that workload reuses. A recorded entry that does
not load, or that writes again, fails the artifact.

The invoker gives three mounts:

  - the store root, read-only at /mnt/libs
  - the catalog farm, read-only at /mnt/libs/farm — the path a sandbox
    resolves its farm at, and the path each cache key holds
  - the manifest directory (with warm/), at WARM_ROOT (default
    /opt/package-store)

The invoker sources /usr/local/lib/inflexa-seed-caches.sh and calls seed_caches
first — the same code a sandbox runs — thus NUMBA_CACHE_DIR names the seeded
writable copy before this program starts.

The exit code is the gate:

- 0 — each recorded entry loads, and nothing recompiles a recorded entry
- 1 — a recorded entry did not load, or a recorded entry was written again
- 2 — a mount is absent, the record is absent, or a workload drifted from it
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# The path at which a sandbox resolves its farm under the image toolchain.
FARM = Path("/mnt/libs/farm")

# Where the invoker mounts the manifest directory, with the warm scripts.
WARM_ROOT = Path(os.environ.get("WARM_ROOT", "/opt/package-store"))

# The two lines that NUMBA_DEBUG_CACHE writes for a cache data file. The
# preparation run parses the same pattern to build the record. Refer to
# CACHE_EVENT in images/sandbox-provisioner/provision.py.
CACHE_EVENT = re.compile(r"\[cache\] data (loaded from|saved to) ['\"](.+?)['\"]")

STDERR_TAIL_LINES = 8
NAMES_IN_REPORT = 10


def log(msg: str) -> None:
    print(f"[warm-check] {msg}", flush=True)


def cache_entry_key(path: str, root: Path) -> str:
    rel = os.path.relpath(path, root)
    return path if rel.startswith("..") else rel


def replay(label: str, script: Path, root: Path) -> tuple[set[str], set[str]]:
    """Run one warm workload again, and report what it loaded and what it saved."""
    # -P keeps the script directory off sys.path: a warm script carries the name
    # of the package it warms, and would import itself without the flag.
    proc = subprocess.run([sys.executable, "-P", str(script)], capture_output=True, text=True,
                          env={**os.environ, "NUMBA_DEBUG_CACHE": "1"})
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-STDERR_TAIL_LINES:]
        detail = "\n  ".join(tail) if tail else "(the child wrote nothing to stderr)"
        raise SystemExit(f"[warm-check] FAIL: the replay of {label} exited "
                         f"{proc.returncode}:\n  {detail}")
    loaded: set[str] = set()
    saved: set[str] = set()
    for event, path in CACHE_EVENT.findall(proc.stdout + proc.stderr):
        key = cache_entry_key(path, root)
        (loaded if event == "loaded from" else saved).add(key)
    return loaded, saved


def report(names: list[str]) -> str:
    head = ", ".join(names[:NAMES_IN_REPORT])
    rest = len(names) - NAMES_IN_REPORT
    return f"{head} and {rest} more" if rest > 0 else head


def main() -> int:
    lock_path = FARM / "inflexa.lock"
    if not lock_path.is_file():
        log(f"no farm lock at {lock_path}. The invoker must bind the catalog farm "
            f"at {FARM}, read-only, nested inside the read-only bind of the store "
            f"root at /mnt/libs.")
        return 2

    lock = json.loads(lock_path.read_text())
    warm: dict = lock.get("warm") or {}
    if not warm:
        log("the farm records no warm workload, thus no preparation run reached it")
        return 2

    cache_dir = os.environ.get("NUMBA_CACHE_DIR")
    if not cache_dir or not os.access(cache_dir, os.W_OK):
        log(f"NUMBA_CACHE_DIR names no writable directory ({cache_dir!r}). The "
            f"invoker must source inflexa-seed-caches.sh and call seed_caches first.")
        return 2
    root = Path(cache_dir)

    failed = False
    for name in sorted(warm):
        record = warm[name] or {}
        rel = record.get("script")
        recorded = set(record.get("cache_entries") or [])
        if not rel:
            log(f"FAIL: the record of {name} names no script")
            return 2
        script = WARM_ROOT / rel
        if not script.is_file():
            log(f"FAIL: the warm script of {name} is absent at {script}")
            return 2
        # A path can point at another file later. A changed byte is a
        # different workload, and a replay of it exercises an unprepared call.
        actual_hash = hashlib.sha256(script.read_bytes()).hexdigest()
        if record.get("script_sha256") != actual_hash:
            log(f"FAIL: the warm script bytes of {name} differ from the record")
            return 2

        loaded, saved = replay(name, script, root)

        # A write outside the record names a kernel that the preparation
        # cannot carry forward. The report names it, and the check passes on it.
        outside = sorted(saved - recorded)
        if outside:
            log(f"  {name}: {len(outside)} entry(s) that no run reuses: {report(outside)}")

        rewritten = sorted(saved & recorded)
        if rewritten:
            log(f"FAIL: {name}: {len(rewritten)} recorded entry(s) compiled again "
                f"at run time: {report(rewritten)}")
            failed = True
            continue
        missing = sorted(recorded - loaded)
        if missing:
            log(f"FAIL: {name}: {len(missing)} of {len(recorded)} recorded entry(s) "
                f"did not load: {report(missing)}")
            failed = True
            continue
        log(f"  {name}: {len(recorded)} recorded entry(s) loaded, 0 recompiled")

    if failed:
        return 1
    log(f"PASS: {len(warm)} package workload(s) replayed clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
