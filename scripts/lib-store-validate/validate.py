#!/usr/bin/env python3
"""Acceptance validation suite — runs INSIDE a sandbox image with the library
store at /mnt/libs/current (no network, runtime env only). The store is there
either because it is baked into the image (the OSS path — a published
sandbox-python/-r booted directly) or mounted read-only at /mnt/libs (the managed
path).

It derives its work from packages.txt, not a hardcoded list:

  1. import-all   import()/library()/require()/--version EVERY advertised package
                  (the escaping-bug net). This IS the invariant check: every
                  advertised package must be loadable (advertised ⊆ loadable).
                  The direction is deliberate — packages.txt must not LIE; extra
                  loadable-but-unadvertised packages are tolerated, not flagged.
  2. anchors      a curated real operation for the compiled anchor packages
                  (registry: anchors.json + anchors/*), filtered to this arch and
                  to the tracks actually present in the store.
  3. r-examples   (opt-in, --r-examples) each R package's own examples via
                  tools::testInstalledPackage, with a network/\\donttest denylist.

Any failure exits non-zero (fail loud) so acceptance blocks promotion.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.metadata as im
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Runtime mount contract path; INFLEXA_LIB_ROOT overrides to match the image's
# baked env var, defaulting to the mount contract.
STORE = Path(os.environ.get("INFLEXA_LIB_ROOT", "/mnt/libs/current"))
PACKAGES_TXT = STORE / "packages.txt"
SUITE_DIR = Path(__file__).resolve().parent

SECTION_ECOSYSTEM = {
    "R (CRAN)": "r",
    "R (Bioconductor)": "r",
    "R (GitHub)": "r",
    "Python (pip)": "python",
    "Node (npm)": "node",
    "System tools (CLI)": "conda",
}


def arch() -> str:
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "amd64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return m


def canonical(name: str) -> str:
    """PEP 503 canonical distribution name: case-folded, with runs of ``-``/``_``/``.``
    collapsed to a single ``-``. Lets the anchor registry name a package by either its
    import name or its distribution name and still match what packages.txt advertises
    (so ``ms_deisotope`` ≡ ``ms-deisotope``)."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def parse_packages_txt(path: Path) -> dict[str, list[str]]:
    """Return {ecosystem: [names]} parsed from the mounted packages.txt.

    Raises ValueError on a ``## <title>`` header mapping to no known ecosystem: silently
    dropping the section would remove its packages from ``advertised``, turning the
    advertised ⊆ loadable gate into a no-op for that track. Fail loud on header drift."""
    out: dict[str, list[str]] = {"r": [], "python": [], "node": [], "conda": []}
    eco: str | None = None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        # A read that fails after .exists() (permission/IO) is a store problem, not
        # a package failure — raise so main() signals the store-error exit code.
        raise ValueError(f"cannot read {path}: {e}") from e
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("## "):
            title = line[3:].strip()
            eco = SECTION_ECOSYSTEM.get(title)
            if eco is None:
                raise ValueError(
                    f"unrecognized section header '## {title}' in packages.txt "
                    f"(known: {sorted(SECTION_ECOSYSTEM)}). A producer header drifted "
                    f"from SECTION_ECOSYSTEM — update the mapping or fix the header."
                )
            continue
        if not line or line.startswith("#"):
            continue
        if eco is None:
            continue
        for tok in line.split(","):
            name = tok.strip()
            # Defensive: drop any trailing "(repo)" annotation.
            if " (" in name:
                name = name.split(" (", 1)[0].strip()
            if name:
                out[eco].append(name)
    return out


# --- Python import name derivation (mirrors the build's load check) ----------

def modules_for(dist: str) -> list[str]:
    try:
        d = im.distribution(dist)
    except im.PackageNotFoundError:
        return []
    txt = d.read_text("top_level.txt")
    mods = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("_")] if txt else []
    if not mods:
        seen = set()
        for f in d.files or []:
            parts = f.parts
            if len(parts) == 1 and parts[0].endswith(".py") and not parts[0].startswith("_"):
                seen.add(parts[0][:-3])
            elif len(parts) >= 2 and parts[1] == "__init__.py":
                top = parts[0]
                if top and not top.startswith("_") and not top.endswith((".dist-info", ".data")):
                    seen.add(top)
        mods = sorted(seen)
    if not mods:
        # Namespace/meta dist (e.g. rpy2, whose code lives in the rpy2-rinterface /
        # rpy2-robjects sub-dists): no top_level.txt and no own top-level module files,
        # but the dist name itself is the importable namespace. Fall back to it — a
        # genuinely-missing package then fails at the real import, not here.
        mods = [dist.replace("-", "_")]
    return mods


# --- import-all (the invariant) ---------------------------------------------

def check_python(names: list[str]) -> list[str]:
    failed = []
    for name in names:
        mods = modules_for(name)
        if not mods:
            print(f"  FAIL python {name}: no import module resolvable on the store")
            failed.append(name)
            continue
        last = ""
        for mod in mods:
            try:
                importlib.import_module(mod)
                break
            except Exception as e:  # noqa: BLE001
                last = f"{mod}: {type(e).__name__}: {e}"
        else:
            print(f"  FAIL python {name}: {last}")
            failed.append(name)
    print(f"import-all python: {len(names) - len(failed)}/{len(names)} OK")
    return failed


def check_node(names: list[str]) -> list[str]:
    failed = []
    for name in names:
        r = subprocess.run(["node", "-e", f"require({json.dumps(name)})"], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  FAIL node {name}: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'require failed'}")
            failed.append(name)
    print(f"import-all node: {len(names) - len(failed)}/{len(names)} OK")
    return failed


def check_conda(names: list[str]) -> list[str]:
    failed = []
    for name in names:
        if shutil.which(name) is None:
            print(f"  FAIL conda {name}: not on PATH")
            failed.append(name)
            continue
        # Version is logged, not gated: on PATH is the pass condition; a nonzero
        # --version does not fail the check.
        ver = subprocess.run([name, "--version"], capture_output=True, text=True)
        out = (ver.stdout or ver.stderr).strip().splitlines()
        print(f"  conda {name}: {out[0] if out else '(no --version output)'}")
    print(f"import-all conda: {len(names) - len(failed)}/{len(names)} OK")
    return failed


def check_r(names: list[str]) -> list[str]:
    if not names:
        return []
    fpath = Path("/tmp/r_import_failures.txt")
    if fpath.exists():
        fpath.unlink()  # clear any stale file from a prior run before this loop appends
    # Append each failure to the file INSIDE the loop (not once at the end). A native
    # crash — a segfault, OOM, or R aborting — cannot be caught by tryCatch and loses
    # every package after it; incremental appends preserve the failures seen so far so a
    # crash still surfaces partial results. The Rscript EXIT STATUS is the separate,
    # authoritative signal for "did the run complete cleanly at all".
    script = (
        "args <- commandArgs(trailingOnly=TRUE);"
        "ff <- '/tmp/r_import_failures.txt';"
        "bad <- character(0);"
        "for (p in args) {"
        "  ok <- tryCatch({ suppressPackageStartupMessages(library(p, character.only=TRUE)); TRUE },"
        "                 error=function(e){ cat(sprintf('  FAIL R %s: %s\\n', p, conditionMessage(e))); FALSE });"
        "  if (!isTRUE(ok)) { bad <- c(bad, p); cat(paste0(p, '\\n'), file=ff, append=TRUE) }"
        "};"
        "cat(sprintf('import-all R: %d/%d OK\\n', length(args)-length(bad), length(args)))"
    )
    r = subprocess.run(["Rscript", "--vanilla", "-e", script, *names], text=True)
    failed: list[str] = []
    if fpath.exists():
        failed = [l.strip() for l in fpath.read_text().splitlines() if l.strip()]
        fpath.unlink()
    # A non-zero Rscript exit is a FAILURE regardless of the failure file — tryCatch cannot
    # catch a segfault, so a crash can produce a clean-looking (or empty) file. Surface a
    # synthetic marker so the R track fails loud and acceptance blocks promotion. Mirrors
    # check_node/check_conda, which already gate on subprocess return codes.
    if r.returncode != 0 and not failed:
        failed.append(f"<Rscript crashed: exit {r.returncode}>")
    return failed


# --- anchors -----------------------------------------------------------------

def run_anchors(advertised: set[str], this_arch: str) -> list[str]:
    reg_path = SUITE_DIR / "anchors.json"
    if not reg_path.exists():
        print("anchors: registry not found, skipping")
        return []
    anchors = json.loads(reg_path.read_text())
    # Compare PEP 503-canonically: the registry may name a package by its import
    # name (underscores) while packages.txt advertises the hyphenated distribution
    # name (ms_deisotope vs ms-deisotope). Passes are counted over the run set
    # (arch-matched AND advertised), so without this canonicalization a mis-named
    # anchor is dropped from the run set entirely rather than checked.
    advertised_canon = {canonical(n) for n in advertised}
    failed: list[str] = []
    ran = 0
    for a in anchors:
        name = a["name"]
        if this_arch not in a.get("arches", []):
            print(f"  skip anchor {name}: not built for {this_arch}")
            continue
        if canonical(name) not in advertised_canon:
            # Legitimately absent from this store (e.g. an R anchor on arm64):
            # skip WITHOUT counting it — a not-run anchor is neither a pass nor
            # a fail.
            print(f"  skip anchor {name}: not advertised in this store")
            continue
        ran += 1
        op = SUITE_DIR / "anchors" / a["op"]
        runner = a["runner"]
        if runner == "python":
            cmd = ["python3", str(op)]
        elif runner == "R":
            cmd = ["Rscript", "--vanilla", str(op)]
        elif runner == "shell":
            cmd = ["bash", str(op)]
        else:
            print(f"  FAIL anchor {name}: unknown runner {runner}")
            failed.append(name)
            continue
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0:
            print(f"  OK anchor {name} ({a['track']})")
        else:
            tail = (r.stderr or r.stdout).strip().splitlines()
            print(f"  FAIL anchor {name}: {tail[-1] if tail else 'nonzero exit'}")
            failed.append(name)
    print(f"anchors: {ran - len(failed)}/{ran} passed")
    return failed


# --- R examples (opt-in) -----------------------------------------------------

def run_r_examples(r_names: list[str]) -> int:
    if not r_names:
        return 0
    op = SUITE_DIR / "r_examples.R"
    limit = os.environ.get("LIB_STORE_R_EXAMPLE_LIMIT", "")
    cmd = ["Rscript", "--vanilla", str(op)]
    if limit:
        cmd.append(limit)
    r = subprocess.run(cmd, text=True)
    return r.returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="lib-store acceptance validation suite")
    ap.add_argument("--anchors", dest="anchors", action="store_true", default=True)
    ap.add_argument("--no-anchors", dest="anchors", action="store_false")
    ap.add_argument("--r-examples", action="store_true", help="also run R package examples (heavy; acceptance --full)")
    args = ap.parse_args()

    if not PACKAGES_TXT.exists():
        print(f"ERROR: {PACKAGES_TXT} not found — is the store mounted?", file=sys.stderr)
        return 2

    this_arch = arch()
    try:
        pkgs = parse_packages_txt(PACKAGES_TXT)
    except ValueError as e:
        # A drifted header or an unreadable store is a config/store problem, not a
        # package failure — block promotion.
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    advertised = {n for names in pkgs.values() for n in names}
    print(f"=== lib-store validation ({this_arch}) — {len(advertised)} advertised packages ===")

    failures: dict[str, list[str]] = {}

    # 1. import-all == the invariant: every advertised package must be loadable.
    #    One-way on purpose — packages.txt must not LIE; extra loadable packages
    #    it does not advertise are tolerated (advertised ⊆ loadable).
    print("\n[1/3] import-all (the advertised == loadable invariant)")
    failures["python"] = check_python(pkgs["python"])
    failures["node"] = check_node(pkgs["node"])
    failures["conda"] = check_conda(pkgs["conda"])
    failures["r"] = check_r(pkgs["r"])

    # 2. anchors — curated real ops for compiled backends.
    if args.anchors:
        print("\n[2/3] anchors (curated real ops for compiled backends)")
        failures["anchors"] = run_anchors(advertised, this_arch)
    else:
        print("\n[2/3] anchors skipped (--no-anchors)")

    # 3. R examples (opt-in).
    rex_rc = 0
    if args.r_examples:
        print("\n[3/3] R package examples (tools::testInstalledPackage, network-filtered)")
        rex_rc = run_r_examples(pkgs["r"])
    else:
        print("\n[3/3] R examples skipped (pass --r-examples / acceptance --full to run)")

    total_fail = sum(len(v) for v in failures.values()) + (1 if rex_rc else 0)
    print("\n=== summary ===")
    for k, v in failures.items():
        status = "OK" if not v else f"FAIL ({', '.join(v)})"
        print(f"  {k}: {status}")
    print(f"  r-examples: {'OK' if rex_rc == 0 else 'FAIL'}")

    if total_fail:
        print(f"\nAcceptance RED — {total_fail} failing check group(s). latest MUST NOT advance.", file=sys.stderr)
        return 1
    print("\nAcceptance GREEN — advertised ⊆ loadable, anchors pass. Safe to promote latest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
