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
import subprocess
import sys
from pathlib import Path

PYTHON = "/usr/bin/python3"


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


def check_r(pkgs: list[tuple[str, str]], lib_paths: list[str]) -> list[dict]:
    """One namespace load per R package, in one Rscript call."""
    if not pkgs:
        return []
    script = (
        f".libPaths(c({', '.join(json.dumps(p) for p in lib_paths)}, .libPaths())); "
        'for (line in readLines(file("stdin"))) { '
        'ok <- tryCatch({ requireNamespace(line, quietly = TRUE) }, error = function(e) FALSE); '
        'cat(line, "\\t", if (isTRUE(ok)) "ok" else "fail", "\\n", sep = "") '
        "}"
    )
    proc = subprocess.run(["Rscript", "-e", script],
                          input="\n".join(name for _pkg, name in pkgs),
                          capture_output=True, text=True)
    verdicts: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        name, tab, verdict = line.partition("\t")
        if tab:
            verdicts[name.strip()] = verdict.strip()
    results = []
    for pkg, name in pkgs:
        ok = verdicts.get(name) == "ok"
        results.append({"package": pkg, "track": "r", "ok": ok,
                        **({} if ok else {"error": f"requireNamespace({name}) failed"})})
    return results


def from_nodes(store_root: Path, report: dict) -> list[dict]:
    """The staged-node check of an acquisition: load each node from the pool."""
    nodes = report.get("nodes") or {}
    store = store_root / "store"
    python_paths = [str(store / key) for key, node in nodes.items() if node.get("track") == "python"]
    imports_by_pkg = {key: list(node.get("imports") or [])
                      for key, node in nodes.items() if node.get("track") == "python"}
    r_paths = sorted({str(store / key) for key, node in nodes.items() if node.get("track") == "r"})
    r_pkgs = [(key, node.get("r_dir") or node.get("name"))
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
        node = graph.get(p["store_dir"]) or {}
        imports_by_pkg[p["name"]] = list(node.get("imports") or [p["name"].replace("-", "_")])
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
