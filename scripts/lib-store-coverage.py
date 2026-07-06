#!/usr/bin/env python3
"""Coverage report — the want-vs-got check that runs after the build's load
check, for one architecture.

For each track it computes, from the manifest wishlist (want) and the just-built
store's per-track packages.txt fragments (loaded):

  * want    — the packages the manifest asked for
  * loaded  — the packages that actually installed AND loaded (the fragment)
  * missing — want minus loaded

and prints a per arch × track table. It then diffs the loaded set against the
last published coverage for this arch: a package that was loaded before and is
now missing is a REGRESSION. On linux/amd64 (the primary target) a regression
fails the build; on linux/arm64 a never-built package is informational and never
fails the build.

It also writes the new coverage JSON (loaded names per track) so the next build
has a baseline to diff against.

Usage:
  lib-store-coverage.py --arch <amd64|arm64> --manifest <yaml> --store <dir> \
      [--previous <coverage.json>] [--out <coverage.json>]

Exit codes:
  0  no regression (or arm64)
  1  amd64 regression detected (a previously-loaded package no longer loads)
  2  usage / IO error
"""
import argparse
import json
import os
import re
import sys

import yaml


def canon(name: str) -> str:
    """Normalize a package/dist name for cross-source comparison."""
    return re.sub(r"[-_.]+", "-", name.strip().lower())


def canon_pip(spec: str) -> str:
    """pip spec -> canonical distribution name (strip version/extras/markers)."""
    return canon(re.split(r"[<>=!~;\[\s]", spec.strip())[0])


def want_for(manifest: dict, arch: str) -> dict[str, list[str]]:
    """The manifest wishlist per track, for the given arch."""
    r = manifest.get("r", {}) or {}
    pip = manifest.get("python", {}).get("pip", {}) or {}
    tools = manifest.get("system_tools", {}) or {}
    return {
        "cran": list(r.get("cran", []) or []),
        "bioconductor": list(r.get("bioconductor", []) or []),
        # github wants are owner/repo[@ref] strings; loaded names are the R
        # package dir names, so per-name missing is approximate for this track.
        "github": [g.split("/")[-1].split("@")[0] for g in (r.get("github", []) or [])],
        "python": [canon_pip(s) for s in (pip.get("common", []) or []) + (pip.get(arch, []) or [])],
        "conda": list((tools.get("common", []) or []) + (tools.get(arch, []) or [])),
        "node": ["echarts"],
    }


# The fragment filename each track writes at the store root.
FRAGMENTS = {
    "cran": "cran.packages.txt",
    "bioconductor": "bioconductor.packages.txt",
    "github": "github.packages.txt",
    "python": "python.packages.txt",
    "conda": "conda.packages.txt",
    "node": "node.packages.txt",
}


def loaded_for(store: str) -> dict[str, list[str]]:
    """The loaded set per track, parsed from the store's packages.txt fragments.

    Each fragment is `## <title>` followed by a single comma-joined line of the
    packages that loaded (mirrors the load check's output)."""
    out: dict[str, list[str]] = {}
    for track, frag in FRAGMENTS.items():
        path = os.path.join(store, frag)
        names: list[str] = []
        if os.path.isfile(path):
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    names.extend(p.strip() for p in line.split(",") if p.strip())
        out[track] = names
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="lib-store coverage report")
    ap.add_argument("--arch", required=True, choices=["amd64", "arm64"])
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--store", required=True, help="assembled store dir with <track>.packages.txt fragments")
    ap.add_argument("--previous", help="last published coverage.json for this arch (baseline for regression diff)")
    ap.add_argument("--out", help="write the new coverage.json here")
    args = ap.parse_args()

    try:
        manifest = yaml.safe_load(open(args.manifest))
    except OSError as e:
        print(f"coverage: cannot read manifest: {e}", file=sys.stderr)
        return 2

    want = want_for(manifest, args.arch)
    loaded = loaded_for(args.store)

    previous: dict[str, list[str]] = {}
    if args.previous and os.path.isfile(args.previous):
        try:
            prev_doc = json.load(open(args.previous))
            previous = {t: v.get("loaded", []) for t, v in prev_doc.get("tracks", {}).items()}
        except (OSError, ValueError) as e:
            print(f"coverage: ignoring unreadable previous coverage ({e})", file=sys.stderr)

    print(f"\n## Coverage report — linux/{args.arch}\n")
    print("| Track | Want | Loaded | Missing | Regressions |")
    print("|-|-|-|-|-|")

    regressions: dict[str, list[str]] = {}
    coverage_tracks: dict[str, dict] = {}
    for track in FRAGMENTS:
        w = want.get(track, [])
        got = loaded.get(track, [])
        got_canon = {canon(g) for g in got}
        # github wants are repo basenames vs loaded package names — skip per-name
        # missing there (report count only); every other track compares by name.
        if track == "github":
            missing = []
        else:
            missing = sorted(x for x in w if canon(x) not in got_canon)
        # Regression: a package present in the previous published loaded set for
        # this arch that no longer loads now.
        prev = previous.get(track, [])
        regressed = sorted(p for p in prev if canon(p) not in got_canon)
        if regressed:
            regressions[track] = regressed
        coverage_tracks[track] = {"want": len(w), "loaded": got}
        miss_str = str(len(missing)) + (f" ({', '.join(missing[:6])}{'…' if len(missing) > 6 else ''})" if missing else "")
        reg_str = str(len(regressed)) + (f" ({', '.join(regressed[:6])}{'…' if len(regressed) > 6 else ''})" if regressed else "")
        print(f"| {track} | {len(w)} | {len(got)} | {miss_str} | {reg_str} |")

    if args.out:
        with open(args.out, "w") as fh:
            json.dump({"arch": f"linux-{args.arch}", "tracks": coverage_tracks}, fh, indent=2)
        print(f"\nWrote coverage baseline to {args.out}")

    if regressions:
        total = sum(len(v) for v in regressions.values())
        if args.arch == "amd64":
            print(f"\ncoverage: {total} amd64 REGRESSION(s) — packages that used to load no longer do. Failing.", file=sys.stderr)
            for track, pkgs in regressions.items():
                print(f"  {track}: {', '.join(pkgs)}", file=sys.stderr)
            return 1
        print(f"\ncoverage: {total} arm64 package(s) missing vs last publish — informational, not failing (arm64 is best-effort).")

    print("\ncoverage: no amd64 regressions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
