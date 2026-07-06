#!/usr/bin/env python3
"""Run every library-validator smoke test in this directory and emit a report.

Each sibling `<package>.py` / `<package>.R` in this folder is one self-contained
smoke test that follows the house contract (see data.table.R / numpy.py):

    PASS: all <pkg> smoke tests passed          -> exit 0   (installed & healthy)
    FAIL: package '<pkg>' is not installed       -> exit 1   (absent; expected)
    FAIL: N test(s) failed                       -> exit 1   (installed but BROKEN)

This runner discovers them, executes each with the right interpreter
(python3 for .py, Rscript for .R) in parallel, classifies the outcome from the
script's final stdout line, and prints a grouped report:

    python3 run_all.py                 # full report, all scripts
    python3 run_all.py --lang py       # only Python validators
    python3 run_all.py --filter scanpy # only scripts whose name contains "scanpy"
    python3 run_all.py --json          # machine-readable results
    python3 run_all.py --verbose       # include failing output for FAIL/ERROR

Runner exit code: 0 when nothing is BROKEN — i.e. every installed library passed
(absent libraries are skipped, not failures). Non-zero if any validator reports
FAIL (installed but broken), ERROR (crashed/timed out), or if an interpreter is
missing for scripts that need it.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELF = Path(__file__).resolve().name

# Outcome buckets. PASS/SKIP are healthy; FAIL/ERROR/NO_INTERP are actionable.
PASS = "PASS"           # installed, all sub-tests passed
SKIP = "NOT_INSTALLED"  # guard fired: library absent (expected, not a failure)
FAIL = "FAIL"           # installed but one or more sub-tests failed
ERROR = "ERROR"         # crashed, timed out, or emitted an unrecognized result
NO_INTERP = "NO_INTERP"  # interpreter (python3/Rscript) unavailable

_NOT_INSTALLED_RE = re.compile(r"^FAIL: package '.*' is not installed$")
_TESTS_FAILED_RE = re.compile(r"^FAIL: \d+ test\(s\) failed$")
_PASS_RE = re.compile(r"^PASS: all .* smoke tests passed$")
_VERSION_RE = re.compile(r"version:\s*(.+)$", re.IGNORECASE)


@dataclasses.dataclass
class Result:
    name: str          # package name (filename stem)
    lang: str          # "py" or "R"
    status: str        # one of the buckets above
    exit_code: int | None
    ok: int            # count of "  ok   ..." sub-test lines
    failed: int        # count of "  FAIL ..." sub-test lines
    version: str       # library version the script reported, if any
    duration: float    # wall-clock seconds
    detail: str        # short reason for FAIL/ERROR (tail of output)


def _interp_for(path: Path) -> list[str] | None:
    """Command prefix to run a script, or None if the interpreter is missing."""
    if path.suffix == ".py":
        return [sys.executable]
    if path.suffix == ".R":
        rscript = shutil.which("Rscript")
        return [rscript] if rscript else None
    return None


def _classify(stdout: str, exit_code: int) -> tuple[str, int, int, str]:
    """Map a script's stdout + exit code to (status, ok, failed, detail)."""
    lines = [ln.rstrip() for ln in stdout.splitlines()]
    non_empty = [ln for ln in lines if ln.strip()]
    ok = sum(1 for ln in lines if ln.startswith("  ok   "))
    failed = sum(1 for ln in lines if ln.startswith("  FAIL "))
    last = non_empty[-1] if non_empty else ""

    if _PASS_RE.match(last):
        return PASS, ok, failed, ""
    if _NOT_INSTALLED_RE.match(last):
        return SKIP, ok, failed, ""
    if _TESTS_FAILED_RE.match(last):
        # Surface the individual failing sub-tests as the detail.
        fails = [ln.strip() for ln in lines if ln.startswith("  FAIL ")]
        return FAIL, ok, failed, "; ".join(fails) or last
    # Anything else: a crash, a partial run, or an unexpected final line.
    return ERROR, ok, failed, last or f"no recognizable result (exit {exit_code})"


def _version_from(stdout: str) -> str:
    for ln in stdout.splitlines():
        m = _VERSION_RE.search(ln)
        if m:
            return m.group(1).strip()
    return ""


def run_one(path: Path, timeout: float) -> Result:
    lang = "py" if path.suffix == ".py" else "R"
    interp = _interp_for(path)
    if interp is None:
        return Result(path.stem, lang, NO_INTERP, None, 0, 0, "",
                      0.0, "Rscript not found on PATH")

    start = time.perf_counter()
    # PYTHONSAFEPATH keeps the validator's own directory off sys.path[0], so a
    # script named like a real package (joblib.py, numpy.py, plotly.py) does not
    # shadow the installed package it is meant to smoke-test. Harmless for Rscript.
    env = {**os.environ, "PYTHONSAFEPATH": "1"}
    try:
        proc = subprocess.run(
            [*interp, str(path)],
            cwd=str(HERE),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return Result(path.stem, lang, ERROR, None, 0, 0, "",
                      time.perf_counter() - start, f"timed out after {timeout:.0f}s")
    except Exception as e:  # noqa: BLE001 - report any launch failure as ERROR
        return Result(path.stem, lang, ERROR, None, 0, 0, "",
                      time.perf_counter() - start, f"failed to launch: {e}")

    dur = time.perf_counter() - start
    status, ok, failed, detail = _classify(proc.stdout, proc.returncode)
    if status == ERROR and proc.stderr.strip():
        # Prefer a stderr tail (traceback / R error) as the detail for crashes.
        tail = [ln for ln in proc.stderr.splitlines() if ln.strip()][-3:]
        detail = " / ".join(tail) or detail
    return Result(path.stem, lang, status, proc.returncode, ok, failed,
                  _version_from(proc.stdout), dur, detail)


def discover(lang: str, name_filter: str | None) -> list[Path]:
    paths: list[Path] = []
    for p in sorted(HERE.iterdir(), key=lambda q: q.name.lower()):
        if p.name == SELF or not p.is_file():
            continue
        if p.suffix == ".py":
            if lang in ("all", "py"):
                paths.append(p)
        elif p.suffix == ".R":
            if lang in ("all", "r"):
                paths.append(p)
        else:
            continue
    if name_filter:
        needle = name_filter.lower()
        paths = [p for p in paths if needle in p.stem.lower()]
    return paths


# ---- reporting ----------------------------------------------------------------

def _c(text: str, code: str, use_color: bool) -> str:
    return f"\033[{code}m{text}\033[0m" if use_color else text


_STATUS_COLOR = {PASS: "32", SKIP: "90", FAIL: "31", ERROR: "1;31", NO_INTERP: "33"}
_STATUS_LABEL = {
    PASS: "PASS", SKIP: "skip (absent)", FAIL: "FAIL", ERROR: "ERROR",
    NO_INTERP: "no interpreter",
}


def print_report(results: list[Result], elapsed: float, use_color: bool) -> None:
    by_status: dict[str, list[Result]] = {}
    for r in results:
        by_status.setdefault(r.status, []).append(r)

    total = len(results)
    n_pass = len(by_status.get(PASS, []))
    n_skip = len(by_status.get(SKIP, []))
    n_fail = len(by_status.get(FAIL, []))
    n_err = len(by_status.get(ERROR, []))
    n_noi = len(by_status.get(NO_INTERP, []))

    py = sum(1 for r in results if r.lang == "py")
    rr = sum(1 for r in results if r.lang == "R")

    bar = "=" * 72
    print(bar)
    print("  Library validator report")
    print(f"  {datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M:%S %Z')}"
          f"  ·  {total} scripts ({py} py, {rr} R)  ·  {elapsed:.1f}s")
    print(bar)
    print(f"  {_c('PASS', _STATUS_COLOR[PASS], use_color)}         {n_pass:>4}   installed & healthy")
    print(f"  {_c('FAIL', _STATUS_COLOR[FAIL], use_color)}         {n_fail:>4}   installed but a sub-test failed")
    print(f"  {_c('ERROR', _STATUS_COLOR[ERROR], use_color)}        {n_err:>4}   crashed / timed out / unrecognized")
    print(f"  {_c('skip', _STATUS_COLOR[SKIP], use_color)}         {n_skip:>4}   library not installed (expected)")
    if n_noi:
        print(f"  {_c('no-interp', _STATUS_COLOR[NO_INTERP], use_color)}    {n_noi:>4}   interpreter missing (Rscript)")
    print(bar)

    # Actionable first: everything that is not PASS/skip.
    def _row(r: Result) -> str:
        label = _c(_STATUS_LABEL[r.status].ljust(14), _STATUS_COLOR[r.status], use_color)
        tests = f"{r.ok}/{r.ok + r.failed}" if (r.ok or r.failed) else "-"
        return f"  {label} {r.name:<26} {r.lang:<3} {tests:>7}  {r.duration:5.1f}s"

    actionable = sorted(
        by_status.get(FAIL, []) + by_status.get(ERROR, []) + by_status.get(NO_INTERP, []),
        key=lambda r: (r.status, r.name.lower()),
    )
    if actionable:
        print("  NEEDS ATTENTION")
        for r in actionable:
            print(_row(r))
            if r.detail:
                print(f"       └─ {r.detail}")
        print(bar)

    passed = sorted(by_status.get(PASS, []), key=lambda r: r.name.lower())
    if passed:
        print(f"  PASSED ({len(passed)}) — installed libraries validated")
        for r in passed:
            ver = f"v{r.version}" if r.version else ""
            tests = f"{r.ok}/{r.ok + r.failed}"
            print(f"  {_c('ok'.ljust(6), _STATUS_COLOR[PASS], use_color)} "
                  f"{r.name:<26} {r.lang:<3} {tests:>6} tests  {ver}")
        print(bar)

    skipped = sorted(by_status.get(SKIP, []), key=lambda r: r.name.lower())
    if skipped:
        print(f"  NOT INSTALLED ({len(skipped)}) — guard fired, nothing to validate")
        names = [r.name for r in skipped]
        # Compact multi-column list; these have no detail beyond "absent".
        width = max((len(n) for n in names), default=0) + 2
        per_row = max(1, 76 // max(width, 1))
        for i in range(0, len(names), per_row):
            print("    " + "".join(n.ljust(width) for n in names[i:i + per_row]))
        print(bar)

    verdict_broken = n_fail + n_err + n_noi
    if verdict_broken == 0:
        print(f"  VERDICT: {_c('OK', '32', use_color)} — "
              f"{n_pass} installed librar{'y' if n_pass == 1 else 'ies'} healthy, "
              f"{n_skip} absent.")
    else:
        print(f"  VERDICT: {_c('PROBLEMS', '1;31', use_color)} — "
              f"{n_fail} broken, {n_err} errored"
              + (f", {n_noi} unrunnable" if n_noi else "") + ".")
    print(bar)


def main() -> int:
    ap = argparse.ArgumentParser(description="Run all library-validator smoke tests.")
    ap.add_argument("--lang", choices=["all", "py", "r"], default="all",
                    help="which validators to run (default: all)")
    ap.add_argument("--filter", metavar="SUBSTR", default=None,
                    help="only run scripts whose name contains SUBSTR")
    ap.add_argument("--jobs", type=int, default=min(8, (os.cpu_count() or 4)),
                    help="parallel workers (default: min(8, cpus))")
    ap.add_argument("--timeout", type=float, default=300.0,
                    help="per-script timeout in seconds (default: 300)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a report")
    ap.add_argument("--verbose", action="store_true",
                    help="(reserved) include extra detail; FAIL/ERROR detail is always shown")
    args = ap.parse_args()

    scripts = discover(args.lang, args.filter)
    if not scripts:
        print("No validator scripts found matching the given filters.", file=sys.stderr)
        return 2

    start = time.perf_counter()
    results: list[Result] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as ex:
        futs = {ex.submit(run_one, p, args.timeout): p for p in scripts}
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
    elapsed = time.perf_counter() - start

    results.sort(key=lambda r: r.name.lower())

    if args.json:
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "elapsed_seconds": round(elapsed, 3),
            "counts": {
                s: sum(1 for r in results if r.status == s)
                for s in (PASS, FAIL, ERROR, SKIP, NO_INTERP)
            },
            "results": [dataclasses.asdict(r) for r in results],
        }
        print(json.dumps(payload, indent=2))
    else:
        use_color = sys.stdout.isatty()
        print_report(results, elapsed, use_color)

    broken = sum(1 for r in results if r.status in (FAIL, ERROR, NO_INTERP))
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
