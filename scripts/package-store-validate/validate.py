#!/usr/bin/env python3
"""Acceptance validation suite — runs INSIDE the sandbox-base image with the
library store at /mnt/libs/farm (no network, runtime env only). The store is
there because the published store artifact is mounted read-only at /mnt/libs. No
runtime image bakes a package set after the retirement of the variants, thus the
mounted store is the one source of a library.

It derives its work from the farm lock and the image record, not a hardcoded
list, and runs two phases:

  1. import-all   import()/library()/require()/--version EVERY advertised package.
                  The advertised == loadable invariant (advertised ⊆ loadable):
                  the advertised inventory must not LIE. Extra loadable-but-unadvertised
                  packages are tolerated, not flagged.
  2. validators   the per-library smoke-test suite (lib-validator/run_all.py):
                  each covered library runs a real operation on synthetic data.
                  An installed-but-broken library is a failure; an absent one
                  (its not-installed guard fires) is a skip.

Acceptance is NON-GATING: it promotes nothing (the build already advanced
`latest`). It reports a per-arch results table (written to $PACKAGE_STORE_SUMMARY_MD
when set) and exits non-zero if anything is broken — a green/red status a
maintainer reviews.
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
from concurrent.futures import ThreadPoolExecutor
import sys
from pathlib import Path

# Runtime mount contract path of the farm; INFLEXA_FARM_ROOT overrides it.
STORE = Path(os.environ.get("INFLEXA_FARM_ROOT", "/mnt/libs/farm"))
# The one metadata file of a farm — the advertised inventory of the store tracks.
FARM_LOCK = STORE / "inflexa.lock"
# The baked inventory record of the image-owned tracks (conda + node). The
# validator reads the copy of the image under test, not the copy of the store,
# because the invariant is about what THIS image advertises.
IMAGE_RECORD = Path("/opt/inflexa/image-packages.json")
# Where run.sh mounts scripts/lib-validator inside the container.
LIB_VALIDATOR_DIR = Path(os.environ.get("LIB_VALIDATOR_DIR", "/opt/lib-validator"))

# Display order for the per-track tables/summary.
TRACK_ORDER = ["python", "r", "conda", "node"]


def arch() -> str:
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "amd64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return m


def parse_image_record(path: Path) -> dict[str, list[str]]:
    """Return {ecosystem: [names]} from the baked image record.

    A conda entry contributes its ``executable`` where the record gives one, because
    the check probes the binary on PATH and not the conda package. Raises ValueError on
    an unreadable record or a schema the validator does not know: silently dropping the
    record would remove the image tracks from ``advertised``, turning the advertised
    ⊆ loadable gate into a no-op for them. Fail loud on shape drift."""
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        # A read that fails after .is_file() (permission/IO/JSON) is an image problem,
        # not a package failure — raise so main() signals the store-error exit code.
        raise ValueError(f"cannot read {path}: {e}") from e
    if record.get("schema") != 1:
        raise ValueError(
            f"{path} is at schema {record.get('schema')!r}, and this validator reads "
            f"schema 1. A producer shape drifted — update the reader or fix the producer."
        )
    out: dict[str, list[str]] = {"conda": [], "node": []}
    for tool in record.get("system_tools") or []:
        name = tool.get("executable") or tool.get("name")
        if name:
            out["conda"].append(str(name))
    for pkg in record.get("node") or []:
        if pkg.get("name"):
            out["node"].append(str(pkg["name"]))
    return out


LOCK_TRACK_ECOSYSTEM = {
    "python": "python",
    "cran": "r",
    "bioconductor": "r",
    "github": "r",
}


def parse_inventory() -> dict[str, list[str]]:
    """Return {ecosystem: [names]} from the farm lock plus the image record.

    The farm advertises its store tracks through `inflexa.lock`, and the image
    advertises its two owned tracks (conda + node) through the baked record.
    An unknown lock track raises, for the same fail-loud reason a drifted
    section header does."""
    out: dict[str, list[str]] = {"r": [], "python": [], "node": [], "conda": []}
    try:
        lock = json.loads(FARM_LOCK.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"cannot read {FARM_LOCK}: {e}") from e
    for pkg in lock.get("packages") or []:
        track = pkg.get("track")
        eco = LOCK_TRACK_ECOSYSTEM.get(track)
        if eco is None:
            raise ValueError(
                f"unknown track {track!r} in {FARM_LOCK} (known: "
                f"{sorted(LOCK_TRACK_ECOSYSTEM)}). A producer track drifted — "
                f"update the mapping or fix the producer.")
        if pkg.get("name"):
            out[eco].append(str(pkg["name"]))
    if IMAGE_RECORD.is_file():
        record = parse_image_record(IMAGE_RECORD)
        out["conda"] += record["conda"]
        out["node"] += record["node"]
    return out


# --- Python import name derivation (mirrors the build's load check) ----------
#
# The import name of a distribution is not the distribution name. `protobuf`
# imports as `google.protobuf`, `python-levenshtein` as `Levenshtein`, and each
# `sphinxcontrib-*` dist as a member of the `sphinxcontrib` namespace. A swap of a
# dash for an underscore in the dist name gives a wrong module and a false FAIL.
#
# `importlib.metadata.packages_distributions()` maps each real top-level module
# onto the dist names that provide it. It reads the metadata of every dist on
# `sys.path`, and the farm site-packages is on `sys.path` through the image .pth
# file. Thus the map covers the store. The inverse of the map gives the true import
# names of a dist, and not a guess from the dist name.

def _norm_dist(name: str) -> str:
    """Return the normalized form of a distribution name (PEP 503).

    `packages_distributions()` reports the raw `Name` metadata of a dist. A lookup
    must compare the normalized form, because a dash, an underscore, and a dot are
    one separator in a distribution name."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _is_public_top_level(mod: str) -> bool:
    """Report whether a name is a public top-level import name.

    `packages_distributions()` derives some names from a file scan. Thus it can
    report a scan artifact such as `__pycache__`, a private helper that starts with
    an underscore, or a compiled mypyc module whose name starts with a digit. A
    public import name is a valid identifier and does not start with an underscore.
    This filter keeps the public names and drops the artifacts."""
    return mod.isidentifier() and not mod.startswith("_")


_MODULES_BY_DIST: dict[str, list[str]] | None = None


def _modules_by_dist() -> dict[str, list[str]]:
    """Build and cache the map {normalized dist name: [public top-level modules]}.

    The map is the inverse of `packages_distributions()`. The scan runs one time,
    because it reads the metadata of every dist on `sys.path`."""
    global _MODULES_BY_DIST
    if _MODULES_BY_DIST is None:
        out: dict[str, set[str]] = {}
        for module, dists in im.packages_distributions().items():
            if not _is_public_top_level(module):
                continue
            for dist in dists:
                out.setdefault(_norm_dist(dist), set()).add(module)
        _MODULES_BY_DIST = {k: sorted(v) for k, v in out.items()}
    return _MODULES_BY_DIST


def _module_shaped(files, mod: str) -> bool:
    """Report whether the dist ships `mod` as an importable module or package.

    The candidate names come from the dist metadata, and that metadata carries
    junk: a `top_level.txt` with sdist artifacts (`build`, `testing`), and a
    RECORD whose script entries yield roots such as `bin`. A junk name still
    imports as an accidental namespace package, and the farm rule then reads
    it as a shadow. The shape test keeps a name only when the dist ships real
    Python under it: a package file inside `mod/`, a root `mod.py`, or a root
    compiled `mod.*`."""
    for f in files:
        parts = f.parts
        if not parts:
            continue
        if parts[0] == mod and len(parts) > 1 and f.suffix in (".py", ".so", ".pyd"):
            return True
        if len(parts) == 1 and (f.name == f"{mod}.py" or (f.name.startswith(f"{mod}.") and f.suffix in (".so", ".pyd"))):
            return True
    return False


def modules_for(dist: str) -> list[str]:
    """Return the public top-level modules that a distribution provides.

    An empty list means the dist provides no importable module. A stub dist is one
    such case (for example `python-levenshtein`, which only pulls in `Levenshtein`).
    The caller treats an empty list as a skip, and not as a failure. A dist whose
    RECORD is unreadable keeps its unfiltered candidates, because a lost filter
    must widen the check and never silence it."""
    mods = _modules_by_dist().get(_norm_dist(dist), [])
    try:
        files = im.distribution(dist).files or []
    except im.PackageNotFoundError:
        return mods
    if not files:
        return mods
    return [m for m in mods if _module_shaped(files, m)]


# --- farm-backed store detection --------------------------------------------

# The system python of the image owns the packaging toolchain, and its copies
# sit ahead of the farm on `sys.path`. That shadow is a property of the BASE
# IMAGE, not of the store artifact this suite proves — the remedy is a path
# reorder in the image, and this suite must not go red on the image's choice.
FARM_RULE_EXEMPT_DISTS = {"setuptools", "pip", "wheel"}

def find_store_dir(store_root: Path) -> Path | None:
    """Return the content-addressed ``store/`` directory that backs a farm, or None.

    A farm is a directory of symbolic links whose targets live in a sibling
    ``store/`` directory. The root is ``/mnt/libs/farm``, which is a mount of the
    farm of the analysis, or a farm path itself. Resolve the root, then walk up until
    a ``store/`` directory appears beside it. A baked tree holds real package
    directories and no such sibling, so it returns None."""
    try:
        real = store_root.resolve()
    except OSError:
        return None
    for base in (real, *real.parents):
        cand = base / "store"
        if cand.is_dir():
            return cand.resolve()
    return None


def _loaded_from_store(mod, store_dir: Path, farm_dir: Path) -> bool:
    """Report whether an imported module resolves into the farm-backed store.

    A farm link points a top-level name at a ``store/`` directory, so the real
    path of a module the farm serves is under ``store_dir``. A namespace parent
    (`sphinxcontrib`, the `rpy2` split dists) is a REAL directory that the farm
    owns, thus a path under the resolved farm root passes too. A module with no
    path at all is unverifiable, and it passes: an absence proves no shadow. A
    module that resolves elsewhere came from a baked or system location."""
    paths = []
    f = getattr(mod, "__file__", None)
    if f:
        paths.append(f)
    for p in getattr(mod, "__path__", []) or []:
        paths.append(p)
    if not paths:
        return True
    for p in paths:
        try:
            real = Path(p).resolve()
        except OSError:
            continue
        for root in (store_dir, farm_dir):
            if real == root or root in real.parents:
                return True
    return False


# --- import-all (the invariant) ---------------------------------------------

def check_python(names: list[str], farm_store: Path | None = None) -> list[str]:
    failed = []
    skipped = []
    farm_dir = STORE.resolve()
    for name in names:
        try:
            im.distribution(name)
        except im.PackageNotFoundError:
            # Advertised, but its metadata is absent from the store. packages.txt
            # names a dist the store does not carry — the lie the invariant catches.
            print(f"  FAIL python {name}: no distribution metadata found on the store")
            failed.append(name)
            continue
        mods = modules_for(name)
        if not mods:
            # The dist is present but provides no importable module. A stub dist is
            # one such case (for example python-levenshtein, which only pulls in
            # Levenshtein). The dist advertises no module, thus a missing module is
            # not a lie. Skip it with a reason, and do not count it as a failure.
            print(f"  SKIP python {name}: provides no importable top-level module (stub dist)")
            skipped.append(name)
            continue
        # Import every module the dist provides. A dist that advertises a module it
        # cannot load is a lie, thus one failed module fails the dist.
        for mod in mods:
            try:
                imported = importlib.import_module(mod)
            except Exception as e:  # noqa: BLE001
                print(f"  FAIL python {name}: {mod}: {type(e).__name__}: {e}")
                failed.append(name)
                break
            # In farm mode the invariant is stronger: an advertised package must load
            # FROM the farm, not from a stray baked or system copy. A module that
            # resolves outside the store means packages.txt names a package the farm
            # does not actually serve.
            if farm_store is not None and _norm_dist(name) not in FARM_RULE_EXEMPT_DISTS and not _loaded_from_store(imported, farm_store, farm_dir):
                src = getattr(imported, "__file__", "no __file__")
                print(f"  FAIL python {name}: {mod} imported from outside the farm store ({src})")
                failed.append(name)
                break
    ok = len(names) - len(failed) - len(skipped)
    msg = f"import-all python: {ok}/{len(names)} OK"
    if skipped:
        msg += f" ({len(skipped)} skipped: {', '.join(skipped)})"
    print(msg)
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


# One R session cannot hold the whole catalog. A session accumulates the DLL
# of every loaded namespace and of every dependency, and R caps the loaded
# DLLs at 614 by default. Past the cap the loads fail, and a direct load can
# abort the session. The names split into small sessions, and a real sandbox
# loads a few namespaces per analysis, thus the small session is also the
# faithful shape.
R_IMPORT_BATCH = 48


def check_r(names: list[str]) -> list[str]:
    if not names:
        return []
    # Load each advertised package with loadNamespace, and not with library. The
    # invariant is that each advertised package loads. loadNamespace loads the
    # namespace and the compiled code. Thus it catches a real load failure, for
    # example rgl, whose .onLoad opens the graphics driver.
    #
    # library also attaches the package, and an attach puts the package on the shared
    # search path. A package can scan that path when it attaches. conflicted is one
    # such package. conflicted then fails when the other advertised packages attach at
    # the same time, but that condition is not the invariant. loadNamespace tests each
    # package on its own. It is the R form of the Python importlib.import_module check
    # above.
    #
    # Append each failure to the batch file inside the loop, and not one time at
    # the end. A native crash does not go through tryCatch, and it loses each
    # package after it. The incremental append keeps the failures seen so far,
    # and the Rscript exit status stays the authoritative signal of the batch.
    script = (
        "args <- commandArgs(trailingOnly=TRUE);"
        "ff <- args[[1]]; pkgs <- args[-1];"
        "bad <- character(0);"
        "for (p in pkgs) {"
        "  ok <- tryCatch({ suppressMessages(loadNamespace(p)); TRUE },"
        "                 error=function(e){ cat(sprintf('  FAIL R %s: %s\\n', p, conditionMessage(e))); FALSE });"
        "  if (!isTRUE(ok)) { bad <- c(bad, p); cat(paste0(p, '\\n'), file=ff, append=TRUE) }"
        "};"
        "cat(sprintf('import R batch: %d/%d OK\\n', length(pkgs)-length(bad), length(pkgs)))"
    )
    # The dependency closure of one batch can pass the default DLL cap on its
    # own — the belt to the batching's braces. 1000 is the maximum R takes.
    env = dict(os.environ, R_MAX_NUM_DLLS="1000")
    batches = list(enumerate(names[i:i + R_IMPORT_BATCH] for i in range(0, len(names), R_IMPORT_BATCH)))

    def run_batch(entry: tuple[int, list[str]]) -> list[str]:
        idx, batch = entry
        fpath = Path(f"/tmp/r_import_failures.{idx}.txt")
        fpath.unlink(missing_ok=True)
        r = subprocess.run(["Rscript", "--vanilla", "-e", script, str(fpath), *batch], text=True, env=env)
        failed: list[str] = []
        if fpath.exists():
            failed = [l.strip() for l in fpath.read_text().splitlines() if l.strip()]
            fpath.unlink()
        # tryCatch cannot catch a segfault, thus a crash can leave a clean file.
        # The marker keeps the R track loud, and it names the batch, because the
        # names past the crash point were never tested.
        if r.returncode != 0:
            failed.append(f"<Rscript crashed on batch {idx}: exit {r.returncode}>")
        return failed

    # The sessions are independent processes, thus they run beside each other,
    # and each batch owns its failure file — no shared-file interleaving.
    with ThreadPoolExecutor(max_workers=4) as pool:
        per_batch = list(pool.map(run_batch, batches))
    failed = [name for batch in per_batch for name in batch]
    print(f"import-all R: {len(names) - len(failed)}/{len(names)} OK")
    return failed


# --- per-library validators (the behavioral pass) ----------------------------

def run_validators() -> dict | None:
    """Run the per-library smoke-test suite (lib-validator/run_all.py) and return
    its parsed --json payload, or None if the suite could not run.

    Scopes to Python validators when the image has no R runtime (``--lang py`` when
    ``Rscript`` is absent), so R validators are not counted as unrunnable on a
    python-only image — their absence there is expected, and the R track's presence
    where advertised is enforced by import-all, not the smoke suite."""
    runner = LIB_VALIDATOR_DIR / "run_all.py"
    if not runner.exists():
        print(f"  FAIL validators: runner not found at {runner} — is scripts/lib-validator mounted?",
              file=sys.stderr)
        return None
    lang = "all" if shutil.which("Rscript") else "py"
    proc = subprocess.run(
        [sys.executable, str(runner), "--lang", lang, "--json"],
        capture_output=True, text=True,
    )
    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-5:]
        print("  FAIL validators: run_all.py did not emit JSON:\n    " + "\n    ".join(tail),
              file=sys.stderr)
        return None


# --- results table (non-gating visibility) -----------------------------------

def _md_escape(s: str) -> str:
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def write_summary_md(path: Path, this_arch: str, version: str,
                     pkgs: dict[str, list[str]], failures: dict[str, list[str]],
                     val_payload: dict | None, green: bool) -> None:
    """Assemble the acceptance results table (GitHub-flavored markdown) for the
    run summary: verdict header, import-all per track, per-library counts, and a
    needs-attention list of failing/errored libraries."""
    lines: list[str] = []
    hdr = f"## Acceptance — linux-{this_arch}"
    if version:
        hdr += f"  ·  {version}"
    lines += [hdr, ""]
    lines += [f"**{'🟢 GREEN' if green else '🔴 RED'}** — acceptance is non-gating; "
              f"`latest` was set by the build. This run reports what it verified.", ""]

    lines += ["### Import-all (advertised ⊆ loadable)", "",
              "| Track | Advertised | Loadable | Failing |", "|-|-|-|-|"]
    for track in TRACK_ORDER:
        adv = len(pkgs.get(track, []))
        bad = failures.get(track, [])
        fail_str = "—" if not bad else _md_escape(", ".join(bad[:8]) + ("…" if len(bad) > 8 else ""))
        lines.append(f"| {track} | {adv} | {adv - len(bad)} | {fail_str} |")
    lines.append("")

    if val_payload is not None:
        c = val_payload.get("counts", {})
        lines += ["### Library validators (per-library smoke tests)", "",
                  "| Result | Count |", "|-|-|",
                  f"| ✅ pass | {c.get('PASS', 0)} |",
                  f"| ❌ fail | {c.get('FAIL', 0)} |",
                  f"| 💥 error | {c.get('ERROR', 0)} |",
                  f"| ⏭ absent | {c.get('NOT_INSTALLED', 0)} |"]
        if c.get("NO_INTERP", 0):
            lines.append(f"| ⚠ no-interpreter | {c.get('NO_INTERP', 0)} |")
        lines.append("")

        actionable = [r for r in val_payload.get("results", [])
                      if r.get("status") in ("FAIL", "ERROR", "NO_INTERP")]
        if actionable:
            lines += ["### Needs attention", "",
                      "| Library | Lang | Status | Detail |", "|-|-|-|-|"]
            for r in sorted(actionable, key=lambda r: (r.get("status", ""), r.get("name", ""))):
                detail = _md_escape(r.get("detail", ""))
                if len(detail) > 120:
                    detail = detail[:117] + "…"
                lines.append(f"| {r.get('name')} | {r.get('lang')} | {r.get('status')} | {detail} |")
            lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="package-store acceptance validation suite (non-gating)")
    ap.add_argument("--validators", dest="validators", action="store_true", default=True,
                    help=argparse.SUPPRESS)
    ap.add_argument("--no-validators", dest="validators", action="store_false",
                    help="import-all only (skip the per-library smoke-test suite) — quick local check")
    ap.add_argument("--farm", action="store_true",
                    help="validate a farm-backed store root: run import-all only, and confirm "
                         "every advertised Python package loads from the farm's content store")
    args = ap.parse_args()

    if not FARM_LOCK.exists():
        print(f"ERROR: {FARM_LOCK} not found — is the farm mounted?", file=sys.stderr)
        return 2

    farm_store: Path | None = None
    if args.farm:
        # A farm has a sibling content store. Its absence means the root is a baked
        # tree or an empty mount, so --farm cannot prove "loaded from the farm".
        farm_store = find_store_dir(STORE)
        if farm_store is None:
            print(f"ERROR: --farm given, but {STORE} is not backed by a content store "
                  f"(no sibling store/ directory found)", file=sys.stderr)
            return 2
        # The flag ADDS the farm-store rule beside the suite. The driver mounts
        # the per-library validators on the store path too, and the spec wants
        # both: import-all with the farm-store proof, plus the smoke suite.

    this_arch = arch()
    try:
        pkgs = parse_inventory()
    except ValueError as e:
        # A drifted header or an unreadable store is a config/store problem, not a
        # package failure — surface the store-error exit code.
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    advertised = {n for names in pkgs.values() for n in names}
    mode = "farm-backed" if farm_store is not None else "baked tree"
    print(f"=== package-store validation ({this_arch}, {mode}) — {len(advertised)} advertised packages ===")
    if farm_store is not None:
        print(f"    content store: {farm_store}")

    # 1. import-all == the invariant: every advertised package must be loadable.
    #    One-way on purpose — the advertised inventory must not LIE; extra loadable packages
    #    it does not advertise are tolerated (advertised ⊆ loadable).
    print("\n[1/2] import-all (the advertised == loadable invariant)")
    failures: dict[str, list[str]] = {}
    failures["python"] = check_python(pkgs["python"], farm_store=farm_store)
    failures["node"] = check_node(pkgs["node"])
    failures["conda"] = check_conda(pkgs["conda"])
    failures["r"] = check_r(pkgs["r"])
    import_fail = sum(len(v) for v in failures.values())

    # 2. per-library validators — the behavioral pass.
    val_payload: dict | None = None
    if args.validators:
        print("\n[2/2] library validators (per-library smoke tests)")
        val_payload = run_validators()
        if val_payload is None:
            # A requested-but-unavailable suite is a setup error (suite not mounted /
            # non-JSON) — fail loud rather than silently skipping the behavioral pass.
            print("ERROR: validators requested but the suite could not run", file=sys.stderr)
            return 2
    else:
        print("\n[2/2] validators skipped (--no-validators)")

    val_counts = (val_payload or {}).get("counts", {})
    val_results = (val_payload or {}).get("results", [])
    val_broken = val_counts.get("FAIL", 0) + val_counts.get("ERROR", 0) + val_counts.get("NO_INTERP", 0)
    green = (import_fail == 0) and (val_broken == 0)

    print("\n=== summary ===")
    for track in TRACK_ORDER:
        adv = len(pkgs[track])
        bad = failures.get(track, [])
        status = "OK" if not bad else f"FAIL ({', '.join(bad)})"
        print(f"  import-all {track}: {adv - len(bad)}/{adv} — {status}")
    if val_payload is not None:
        print(f"  validators: {val_counts.get('PASS', 0)} pass, {val_counts.get('FAIL', 0)} fail, "
              f"{val_counts.get('ERROR', 0)} error, {val_counts.get('NOT_INSTALLED', 0)} absent"
              + (f", {val_counts.get('NO_INTERP', 0)} no-interp" if val_counts.get("NO_INTERP", 0) else ""))
        for r in val_results:
            if r.get("status") in ("FAIL", "ERROR", "NO_INTERP"):
                print(f"    {r['status']} {r['name']} ({r['lang']}): {r.get('detail', '')}")

    summary_md = os.environ.get("PACKAGE_STORE_SUMMARY_MD")
    if summary_md:
        try:
            write_summary_md(Path(summary_md), this_arch, os.environ.get("PACKAGE_STORE_VERSION", ""),
                             pkgs, failures, val_payload, green)
        except OSError as e:
            print(f"  (could not write summary markdown to {summary_md}: {e})", file=sys.stderr)

    if not green:
        print(f"\nAcceptance RED (arch {this_arch}) — {import_fail} import failure(s), "
              f"{val_broken} broken validator(s). Reported for review; `latest` was set by the build.",
              file=sys.stderr)
        return 1
    print(f"\nAcceptance GREEN (arch {this_arch}) — advertised ⊆ loadable, validators healthy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
