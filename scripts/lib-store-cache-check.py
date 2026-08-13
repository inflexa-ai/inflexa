#!/usr/bin/env python3
"""The cache effectiveness check. It runs INSIDE the sandbox runtime image.

A prepared cache on disk is not evidence. numba selects its cache directory by a
write probe, and it keys each entry on the type signature of the call and on the
absolute directory of the source. Thus a cache can be present and miss on every
call. This program runs the recorded workload again with the cache debug on, and it
reads the line that numba writes for each cache file that it loads or saves.

The record of the preparation run decides the result. That run wrote each entry,
then it ran the same workload a second time and recorded the entries that loaded.
Thus the record holds the entries that a later run reuses, and nothing else.

Two numba kernels of the sparse route write on each run and load on none. The
signature of each one holds a type that a `type()` call builds, thus the index of
the cache never matches that entry again. No workload prevents such a write, and no
list of names stays true across a package update. The record answers both: an entry
that no run reuses never enters it, thus a write outside the record fails nothing.

The invoker gives three mounts and one seeded cache:

  - the store root, read-only at /mnt/libs, because a farm link is an absolute path
    into /mnt/libs/store
  - the target farm, read-only at /mnt/libs/current, because the sandbox resolves
    its farm at that path, and a cache key holds that path
  - this file, at a path of its own
  - NUMBA_CACHE_DIR, at a writable copy of the cache of the farm. The store is
    read-only, and numba skips a cache directory that it cannot write to, for a read
    as much as for a write. A sandbox makes that copy at its entrypoint
    (`seed_caches`), and the invoker of this check makes it the same way.

Usage, with `sandbox-base` as the image and this file bound into it:

    <engine> run --rm --network none --user 1000:1000 \\
        -v <store root>:/mnt/libs:ro \\
        -v <store root>/farms/<farm>:/mnt/libs/current:ro \\
        -v <this file>:/opt/lib-store-cache-check.py:ro \\
        -e NUMBA_CACHE_DIR=/tmp/numba-cache -e MPLCONFIGDIR=/tmp/mpl \\
        --entrypoint /bin/bash <sandbox image> -c '<seed the caches>
            python3 /opt/lib-store-cache-check.py'

The exit code is the gate:

- 0 — each recorded entry loads, and nothing recompiles a recorded entry
- 1 — a recorded entry did not load, or a recorded entry was written again
- 2 — a mount is absent, the record is absent, or the workload drifted from it
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# The path at which a sandbox resolves its farm. The store carries no pointer, thus
# the invoker binds the target farm here. A numba cache key holds the directory of
# the source, thus a farm at another path gives a key that matches nothing.
FARM = Path("/mnt/libs/current")

# The two lines that NUMBA_DEBUG_CACHE writes for a cache data file. The preparation
# run parses the same pattern to build the record, thus the two sides must agree on
# it. Refer to CACHE_EVENT in images/sandbox-provisioner/provision.py.
CACHE_EVENT = re.compile(r"\[cache\] data (loaded from|saved to) ['\"](.+?)['\"]")

# The last line of a traceback is the exception, and the frames above it name the
# module that raised. Thus a report carries the tail of the stream and not one line.
STDERR_TAIL_LINES = 8

# A report names this many entries at most. A whole set can hold hundreds, and the
# first names are enough to start the work.
NAMES_IN_REPORT = 10


def log(msg: str) -> None:
    print(f"[cache-check] {msg}", flush=True)


def cache_entry_key(path: str, root: Path) -> str:
    """The portable name of one numba cache data file.

    The name of the file holds the module, the qualified name, the first line, and
    the ABI tag. Its directory holds a hash of the absolute directory of the source,
    which is the farm path above. The root is the one part that differs between the
    preparation run and this run, thus the key drops it.
    """
    rel = os.path.relpath(path, root)
    return path if rel.startswith("..") else rel


def replay(label: str, argv: list[str], root: Path) -> tuple[set[str], set[str]]:
    """Run one job of the workload again, and report what it loaded and what it saved.

    The job runs in a child process, because numba compiles at the first call of a
    process and it reads its cache one time for each entry.
    """
    proc = subprocess.run([sys.executable, *argv], capture_output=True, text=True,
                          env={**os.environ, "NUMBA_DEBUG_CACHE": "1"})
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-STDERR_TAIL_LINES:]
        detail = "\n  ".join(tail) if tail else "(the child wrote nothing to stderr)"
        raise SystemExit(f"[cache-check] FAIL: the replay of {label} exited "
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
    lock_path = FARM / "lock.json"
    if not lock_path.is_file():
        log(f"no farm record at {lock_path}. The invoker must bind the target farm "
            f"at {FARM}, read-only, nested inside the read-only bind of the store "
            f"root at /mnt/libs.")
        return 2

    lock = json.loads(lock_path.read_text())
    script = lock.get("warm_script")
    workload = lock.get("warm_workload") or {}
    if not script:
        log("the farm records no warm script, thus no preparation run reached it")
        return 2

    # A path can point at another file later. A changed byte at the recorded path is
    # a different workload, and a replay of it would exercise an unprepared call.
    recorded_hash = workload.get("script_sha256")
    actual_hash = hashlib.sha256(Path(script).read_bytes()).hexdigest()
    if recorded_hash != actual_hash:
        log(f"the warm script bytes differ from the record (recorded "
            f"{recorded_hash}, actual {actual_hash})")
        return 2

    recorded = set(workload.get("cache_entries") or [])
    if not recorded:
        log("the preparation run recorded no cache entry, thus this check has "
            "nothing to prove")
        return 2

    cache_dir = os.environ.get("NUMBA_CACHE_DIR")
    if not cache_dir or not os.access(cache_dir, os.W_OK):
        log(f"NUMBA_CACHE_DIR names no writable directory ({cache_dir!r}). The store "
            f"is read-only, thus the runtime must copy the cache of the farm to a "
            f"writable path and name it here before a workload runs.")
        return 2
    root = Path(cache_dir)

    jobs = [(f"the module {m}", ["-c", f"import {m}"])
            for m in (workload.get("modules") or [])]
    jobs.append((f"the script {script}", [script]))
    log(f"{len(recorded)} recorded entry(s), {len(jobs)} job(s) of the workload")

    loaded: set[str] = set()
    saved: set[str] = set()
    for label, argv in jobs:
        job_loaded, job_saved = replay(label, argv, root)
        loaded |= job_loaded
        saved |= job_saved

    # A write outside the record names a kernel that the preparation could not carry
    # forward. The report names it, because a person judges the workload, and the
    # check passes on it.
    outside = sorted(saved - recorded)
    if outside:
        log(f"{len(outside)} entry(s) that no run reuses: {report(outside)}")

    # A recorded entry that writes again is the defect this check exists for: the
    # runtime compiled a prepared code path. It comes before the report of an entry
    # that did not load, because a write names the same entry and it tells more.
    rewritten = sorted(saved & recorded)
    if rewritten:
        log(f"FAIL: {len(rewritten)} recorded entry(s) compiled again at run time: "
            f"{report(rewritten)}")
        return 1

    missing = sorted(recorded - loaded)
    if missing:
        log(f"FAIL: {len(missing)} of {len(recorded)} recorded entry(s) did not "
            f"load: {report(missing)}")
        return 1

    log(f"PASS: {len(recorded)} recorded entry(s) loaded, 0 recompiled, "
        f"{len(outside)} write(s) outside the record")
    return 0


if __name__ == "__main__":
    sys.exit(main())
