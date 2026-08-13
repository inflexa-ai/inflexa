#!/usr/bin/env python3
"""The R load check. It runs INSIDE the sandbox runtime image, against one farm.

A package can install and farm cleanly and still fail to load. The farm resolves it
through symlinks, and a compiled package finds its shared object by the path that R
gives it. A runtime dependency that no farm carries is the other failure, and only
the image of the sandbox can reveal it. The provisioner image carries `pak` and
`yaml`. Thus a check inside the provisioner resolves those two names, and it reports
a load that the sandbox cannot do.

As a result, this program sets the three `R_LIBS_SITE` paths of the farm, and no
other library. R keeps its system library at the end of the search path, and that is
correct: the base packages and the recommended packages resolve there in the sandbox
too. The site library is the one library that separates the two images, and here the
farm is the site library.

The program runs one R process for each package, because a single process for the
whole set cannot name the package that failed.

The invoker gives two mounts:

  - the store root, read-only at /mnt/libs, because a farm link is an absolute path
    into /mnt/libs/store
  - the target farm, read-only at /mnt/libs/current, because the sandbox resolves
    its farm at that path

Usage, with `sandbox-base` as the image and this file bound into it:

    <engine> run --rm --network none --user 1000:1000 \\
        -v <store root>:/mnt/libs:ro \\
        -v <store root>/farms/<farm>:/mnt/libs/current:ro \\
        -v <this file>:/opt/lib-store-r-load-check.py:ro \\
        --entrypoint python3 <sandbox image> /opt/lib-store-r-load-check.py

The exit code is the gate:

- 0 — each recorded package loads, or the farm carries no R package
- 1 — one package or more does not load, and the report names each one
- 2 — the mounts are absent, or the farm holds no record to read
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# The path at which a sandbox resolves its farm. The store carries no pointer, thus
# the invoker binds the target farm here. The value is fixed, because the sandbox
# image bakes this same path into R_LIBS_SITE. A farm at another path would resolve
# a library set that the sandbox never reads.
FARM = Path("/mnt/libs/current")

# The order of the three subtrees in the R_LIBS_SITE of the sandbox image. A GitHub
# package shadows a Bioconductor package of the same name, and a Bioconductor package
# shadows a CRAN package, thus the order is part of what the check proves.
R_SUBTREES = ("github", "bioconductor", "cran")

# The last line of an R failure is usually the bare "Execution halted". The cause
# sits in the lines above it, thus the report carries the tail of the stream and not
# one line.
STDERR_TAIL_LINES = 8


def log(msg: str) -> None:
    print(f"[r-load-check] {msg}", flush=True)


def probe_expression(name: str, compiled: bool, libs_expr: str) -> str:
    """The R program that loads one package through the farm.

    A compiled package keeps its shared object under `libs/`. For such a package the
    program also reads the registered native routines. Thus the run reaches the
    compiled code of the package, and not only the resolution of the symlink.
    """
    probe = ""
    if compiled:
        probe = (f"dll <- getLoadedDLLs()[['{name}']]; "
                 f"if (!is.null(dll)) invisible(getDLLRegisteredRoutines(dll)); ")
    return (f".libPaths(c({libs_expr})); "
            f"suppressMessages(library('{name}', character.only = TRUE)); {probe}")


def main() -> int:
    if not FARM.is_dir():
        log(f"no farm at {FARM}. The invoker must bind the target farm there, "
            f"read-only, nested inside the read-only bind of the store root at "
            f"/mnt/libs. A farm link is an absolute path into /mnt/libs/store, thus "
            f"the two mounts go together.")
        return 2

    lock_path = FARM / "lock.json"
    if not lock_path.is_file():
        log(f"the farm at {FARM} holds no lock.json. The check reads the record of "
            f"the provisioning run, and it walks no farm.")
        return 2

    # The record of the run names each package that it farmed. Thus the check loads
    # the set that the run produced, and a package that no run farmed cannot enter it.
    farmed = (json.loads(lock_path.read_text()).get("r") or {}).get("farmed") or []
    if not farmed:
        log("the farm carries no R package, thus no R ran")
        return 0

    lib_dirs = [FARM / "r" / sub for sub in R_SUBTREES if (FARM / "r" / sub).is_dir()]
    if not lib_dirs:
        log(f"the record names {len(farmed)} R package(s), and the farm at {FARM} "
            f"has no r/ subtree")
        return 2
    libs_expr = ", ".join(f"'{d}'" for d in lib_dirs)
    log(f"{len(farmed)} recorded R package(s), through {' '.join(str(d) for d in lib_dirs)}")

    failed: list[str] = []
    for entry in farmed:
        name = entry["name"]
        rexpr = probe_expression(name, bool(entry.get("compiled")), libs_expr)
        proc = subprocess.run(["Rscript", "-e", rexpr], capture_output=True, text=True)
        if proc.returncode != 0:
            tail = (proc.stderr or "").strip().splitlines()[-STDERR_TAIL_LINES:]
            detail = "\n  ".join(tail) if tail else "(R wrote nothing to stderr)"
            print(f"FAIL {name} (exit {proc.returncode})\n  {detail}", flush=True)
            failed.append(name)

    if failed:
        log(f"FAIL: {len(failed)} of {len(farmed)} recorded R package(s) do not load "
            f"through the farm: {', '.join(failed)}")
        return 1
    log(f"PASS: {len(farmed)} recorded R package(s) load through the farm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
