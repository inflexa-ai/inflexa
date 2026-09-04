#!/usr/bin/env python3
"""The load check of the package store. Runs INSIDE the sandbox image.

The check proves the image that runs the code, not the image that built it —
that is why it never runs inside the provisioner. Two callers:

- The acquisition flight of the host. It passes the acquire report
  (`--nodes`), and the check loads each staged package from the POOL, before
  the host commits the staged nodes to deps.json and before any link. Thus a
  failed check leaves no advertised state.

- The store build workflow. It passes the `inflexa.lock` of the catalog farm
  (`--farm-lock`), and the check loads each advertised package. The workflow
  applies the per-track floor to the result.

The check is one import per Python distribution and one namespace load per R
package. The result is one JSON object on stdout: per package, ok or the
error text. The exit code is 0 when every load passed, and 1 otherwise —
the CALLER decides what a failure gates, because the build floor and the
flight gate differ.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PYTHON = "/usr/bin/python3"

# A testable top-level import is one Python identifier. The graph's import
# lists carry what the wheels shipped, and a wheel can ship junk beside its
# modules: a `-stubs` directory, a stray `site-packages`, a path with a
# slash. Such a name cannot be imported, thus testing it fails a usable
# package. The filter keeps the test honest, and the emitter applies the
# same rule at the source.
IMPORT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def testable_imports(node: dict | None, dist_name: str) -> list[str]:
    """The import names worth testing for one Python package.

    An ABSENT node keeps the historic guess from the distribution name — an
    old store carries no graph entry for every directory. A PRESENT node
    with an empty list means the distribution ships nothing importable (a
    meta package), and nothing-to-test is a pass, never a guess.
    """
    if node is None:
        return [dist_name.replace("-", "_")]
    return [name for name in (node.get("imports") or []) if IMPORT_NAME.match(name)]


def check_python(imports_by_pkg: dict[str, list[str]], path_entries: list[str]) -> list[dict]:
    """Import each top-level name of each Python package, one child per package."""
    results = []
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(path_entries)
    for pkg, names in sorted(imports_by_pkg.items()):
        errors = []
        for name in names:
            proc = subprocess.run([PYTHON, "-c", f"import {name}"],
                                  env=env, capture_output=True, text=True)
            if proc.returncode != 0:
                tail = (proc.stderr or "").strip().splitlines()[-3:]
                errors.append(f"import {name}: " + (" | ".join(tail) or f"exit {proc.returncode}"))
        results.append({"package": pkg, "track": "python", "ok": not errors,
                        **({"error": "; ".join(errors)} if errors else {})})
    return results


# How many R packages one loader session takes. A session accumulates the
# DLL of every loaded namespace and of every dependency, and R caps the
# loaded DLLs (614 by default). One session over the whole catalog crossed
# the cap: the alphabetic tail failed wholesale, and a direct-load variant
# segfaulted. A real sandbox loads a few namespaces per analysis, thus the
# small session is also the faithful one.
R_CHECK_BATCH = 48


def check_r(pkgs: list[tuple[str, str]], lib_paths: list[str]) -> list[dict]:
    """One namespace load per R package, in one Rscript session per batch.

    EVERYTHING rides stdin: the first line carries the tab-joined library
    paths, and each later line carries one package name. A catalog check
    holds a thousand paths, and one `-e` expression caps at 10,000 bytes —
    R then warns on stdout, runs nothing, and exits 0. The stdin protocol
    has no cap, and the small fixed expression stays under the limit.
    """
    if not pkgs:
        return []
    script = (
        'con <- file("stdin"); open(con); '
        'paths <- strsplit(readLines(con, n = 1), "\\t", fixed = TRUE)[[1]]; '
        ".libPaths(c(paths, .libPaths())); "
        "for (line in readLines(con)) { "
        "out <- tryCatch({ if (requireNamespace(line, quietly = TRUE)) TRUE else \"the namespace did not load\" }, "
        "error = function(e) conditionMessage(e)); "
        'cat(line, "\\t", if (isTRUE(out)) "ok" else paste0("fail\\t", gsub("[\\t\\n]", " ", out)), "\\n", sep = "") '
        "}"
    )
    env = dict(os.environ)
    # The dependency closure of one batch can pass the default cap on its
    # own — the belt to the batching's braces. 1000 is the maximum R takes.
    env["R_MAX_NUM_DLLS"] = "1000"

    def run_batch(batch: list[tuple[str, str]]) -> list[dict]:
        proc = subprocess.run(["Rscript", "-e", script],
                              input="\t".join(lib_paths) + "\n" + "\n".join(name for _pkg, name in batch),
                              env=env, capture_output=True, text=True)
        verdicts: dict[str, str] = {}
        reasons: dict[str, str] = {}
        for line in proc.stdout.splitlines():
            name, tab, rest = line.partition("\t")
            if tab:
                verdict, _tab, reason = rest.partition("\t")
                verdicts[name.strip()] = verdict.strip()
                if reason:
                    reasons[name.strip()] = reason.strip()
        # A loader that ran reports one verdict per input line. Zero
        # verdicts from a non-empty batch means the LOADER died, and each
        # entry of the batch must say that, with the loader's own tail — a
        # bare per-package "failed" already hid one wholesale death.
        if not verdicts:
            tail = " | ".join(((proc.stderr or proc.stdout or "").strip().splitlines() or ["no output"])[-3:])
            loader = f"the R loader itself failed (exit {proc.returncode}): {tail}"
            return [{"package": pkg, "track": "r", "ok": False, "error": loader} for pkg, _name in batch]
        out = []
        for pkg, name in batch:
            ok = verdicts.get(name) == "ok"
            detail = reasons.get(name, "the namespace did not load")
            out.append({"package": pkg, "track": "r", "ok": ok,
                        **({} if ok else {"error": f"requireNamespace({name}): {detail}"})})
        return out

    # The sessions are independent processes, thus they run beside each
    # other. Each batch reloads the shared dependency closure, and the
    # parallel width buys that cost back on the catalog scale.
    batches = [pkgs[start:start + R_CHECK_BATCH] for start in range(0, len(pkgs), R_CHECK_BATCH)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        per_batch = list(pool.map(run_batch, batches))
    return [entry for batch in per_batch for entry in batch]


def from_nodes(store_root: Path, report: dict) -> list[dict]:
    """The staged-node check of an acquisition: load each node from the pool."""
    nodes = report.get("nodes") or {}
    store = store_root / "store"
    python_paths = [str(store / key) for key, node in nodes.items() if node.get("track") == "python"]
    imports_by_pkg = {key: testable_imports(node, node.get("name") or key)
                      for key, node in nodes.items() if node.get("track") == "python"}
    r_paths = sorted({str(store / key) for key, node in nodes.items() if node.get("track") == "r"})
    # The name of an R node IS its DESCRIPTION spelling, thus the inner
    # directory of its store directory carries that same name.
    r_pkgs = [(key, node.get("name"))
              for key, node in sorted(nodes.items()) if node.get("track") == "r"]
    return check_python(imports_by_pkg, python_paths) + check_r(r_pkgs, r_paths)


def from_farm_lock(store_root: Path, farm: Path, lock: dict) -> list[dict]:
    """The advertised-inventory check of a farm: load each lock package."""
    store = store_root / "store"
    site = farm / "python" / "site-packages"
    python_pkgs = [p for p in lock.get("packages", []) if p.get("track") == "python"]
    r_pkgs = [p for p in lock.get("packages", []) if p.get("track") in ("cran", "bioconductor", "github")]
    # The farm links every Python distribution into one site-packages, thus
    # the farm path alone resolves each import. The import names come from the
    # graph when it is present, and from the package name otherwise.
    graph = {}
    graph_path = store_root / "deps.json"
    if graph_path.is_file():
        try:
            graph = json.loads(graph_path.read_text()).get("nodes", {})
        except (OSError, ValueError):
            graph = {}
    imports_by_pkg = {}
    for p in python_pkgs:
        imports_by_pkg[p["name"]] = testable_imports(graph.get(p["store_dir"]), p["name"])
    r_lib_paths = sorted({str(store / p["store_dir"]) for p in r_pkgs})
    return check_python(imports_by_pkg, [str(site)]) + check_r(
        [(p["name"], p["name"]) for p in sorted(r_pkgs, key=lambda p: p["name"])], r_lib_paths)


def main() -> int:
    ap = argparse.ArgumentParser(description="Load each staged or advertised package inside the sandbox image.")
    ap.add_argument("--store-root", default="/mnt/libs")
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--nodes", help="an acquire report: check its staged nodes from the pool")
    source.add_argument("--farm-lock", help="an inflexa.lock: check the advertised inventory of its farm")
    args = ap.parse_args()

    store_root = Path(args.store_root)
    if args.nodes:
        results = from_nodes(store_root, json.loads(Path(args.nodes).read_text()))
    else:
        lock_path = Path(args.farm_lock)
        results = from_farm_lock(store_root, lock_path.parent, json.loads(lock_path.read_text()))

    print(json.dumps({"results": results}, indent=2, sort_keys=True))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
