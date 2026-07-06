#!/usr/bin/env python3
"""Acceptance validation suite — runs INSIDE a sandbox image with the library
store at /mnt/libs/current (no network, runtime env only). The store is there
either because it is baked into the image (the OSS path — a published
sandbox-python/-r booted directly) or mounted read-only at /mnt/libs (the managed
path).

It derives its work from packages.txt, not a hardcoded list, and runs two phases:

  1. import-all   import()/library()/require()/--version EVERY advertised package.
                  The advertised == loadable invariant (advertised ⊆ loadable):
                  packages.txt must not LIE. Extra loadable-but-unadvertised
                  packages are tolerated, not flagged.
  2. validators   the per-library smoke-test suite (lib-validator/run_all.py):
                  each covered library runs a real operation on synthetic data.
                  An installed-but-broken library is a failure; an absent one
                  (its not-installed guard fires) is a skip.

Acceptance is NON-GATING: it promotes nothing (the build already advanced
`latest`). It reports a per-arch results table (written to $LIB_STORE_SUMMARY_MD
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
import shutil
import subprocess
import sys
from pathlib import Path

# Runtime mount contract path; INFLEXA_LIB_ROOT overrides to match the image's
# baked env var, defaulting to the mount contract.
STORE = Path(os.environ.get("INFLEXA_LIB_ROOT", "/mnt/libs/current"))
PACKAGES_TXT = STORE / "packages.txt"
# Where run.sh mounts scripts/lib-validator inside the container.
LIB_VALIDATOR_DIR = Path(os.environ.get("LIB_VALIDATOR_DIR", "/opt/lib-validator"))

SECTION_ECOSYSTEM = {
    "R (CRAN)": "r",
    "R (Bioconductor)": "r",
    "R (GitHub)": "r",
    "Python (pip)": "python",
    "Node (npm)": "node",
    "System tools (CLI)": "conda",
}

# Display order for the per-track tables/summary.
TRACK_ORDER = ["python", "r", "conda", "node"]


def arch() -> str:
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "amd64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return m


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
    ap = argparse.ArgumentParser(description="lib-store acceptance validation suite (non-gating)")
    ap.add_argument("--validators", dest="validators", action="store_true", default=True,
                    help=argparse.SUPPRESS)
    ap.add_argument("--no-validators", dest="validators", action="store_false",
                    help="import-all only (skip the per-library smoke-test suite) — quick local check")
    args = ap.parse_args()

    if not PACKAGES_TXT.exists():
        print(f"ERROR: {PACKAGES_TXT} not found — is the store mounted?", file=sys.stderr)
        return 2

    this_arch = arch()
    try:
        pkgs = parse_packages_txt(PACKAGES_TXT)
    except ValueError as e:
        # A drifted header or an unreadable store is a config/store problem, not a
        # package failure — surface the store-error exit code.
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    advertised = {n for names in pkgs.values() for n in names}
    print(f"=== lib-store validation ({this_arch}) — {len(advertised)} advertised packages ===")

    # 1. import-all == the invariant: every advertised package must be loadable.
    #    One-way on purpose — packages.txt must not LIE; extra loadable packages
    #    it does not advertise are tolerated (advertised ⊆ loadable).
    print("\n[1/2] import-all (the advertised == loadable invariant)")
    failures: dict[str, list[str]] = {}
    failures["python"] = check_python(pkgs["python"])
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

    summary_md = os.environ.get("LIB_STORE_SUMMARY_MD")
    if summary_md:
        try:
            write_summary_md(Path(summary_md), this_arch, os.environ.get("LIB_STORE_VERSION", ""),
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
