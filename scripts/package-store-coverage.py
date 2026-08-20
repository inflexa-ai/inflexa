#!/usr/bin/env python3
"""The per-arch coverage report of the package-store build.

After the load check, the build reports, per track: the wanted names (the
manifest entries), the loaded names (the advertised inventory of the farm
lock), and the missing names. The report then diffs the loaded set against
the last published artifact of the SAME arch:

- A package that the last artifact advertised, that the manifest still holds,
  and that is now missing is a REGRESSION, and the build fails.
- A package that never built for this arch reports informationally, and the
  build does not fail on it.
- A package that the manifest no longer holds reports as dropped, by name,
  and the build does not fail on it.

Usage:
    package-store-coverage.py --manifest <manifest.yaml> --lock <inflexa.lock>
        [--previous-lock <inflexa.lock of the last published artifact>]
        --arch <amd64|arm64> [--summary <path of the step summary>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def entry_name(raw) -> str | None:
    if isinstance(raw, str):
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", raw.strip())
        return match.group(1) if match else None
    if isinstance(raw, dict):
        return str(raw.get("name")) if raw.get("name") else None
    return None


def wanted_by_track(manifest: dict, arch: str) -> dict[str, set[str]]:
    """The manifest names per track, canonicalized per its ecosystem."""
    pip = (manifest.get("python") or {}).get("pip") or {}
    python = {canon(n) for raw in list(pip.get("common") or []) + list(pip.get(arch) or [])
              if (n := entry_name(raw))}
    r = manifest.get("r") or {}
    out = {"python": python}
    for track in ("cran", "bioconductor", "github"):
        out[track] = {n for raw in r.get(track) or [] if (n := entry_name(raw))}
    # The git track names install under their package name; the manifest
    # entries carry `name` beside the url.
    out["bioconductor"] |= {n for raw in r.get("git") or [] if (n := entry_name(raw))}
    return out


def loaded_by_track(lock: dict) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for pkg in lock.get("packages") or []:
        track = pkg.get("track")
        name = pkg.get("name")
        if not track or not name:
            continue
        out.setdefault(track, set()).add(canon(name) if track == "python" else name)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--lock", required=True)
    ap.add_argument("--previous-lock", default=None)
    ap.add_argument("--arch", required=True)
    ap.add_argument("--summary", default=None)
    args = ap.parse_args()

    manifest = yaml.safe_load(Path(args.manifest).read_text()) or {}
    lock = json.loads(Path(args.lock).read_text())
    previous = json.loads(Path(args.previous_lock).read_text()) if args.previous_lock else None

    wanted = wanted_by_track(manifest, args.arch)
    loaded = loaded_by_track(lock)
    previous_loaded = loaded_by_track(previous) if previous else {}

    lines = [f"## Package-store coverage ({args.arch})", "", "| Track | Wanted | Loaded | Missing |", "|-|-|-|-|"]
    regressions: list[str] = []
    for track in ("python", "cran", "bioconductor", "github"):
        want = wanted.get(track, set())
        have = loaded.get(track, set())
        missing = sorted(want - have)
        lines.append(f"| {track} | {len(want)} | {len(want & have)} | {len(missing)} |")
        if missing:
            lines.append(f"| | | | {', '.join(missing)} |")
        # The regression gate: published before for this arch, still wanted,
        # now missing.
        before = previous_loaded.get(track, set())
        for name in sorted((before & want) - have):
            regressions.append(f"{track}/{name}")
        # A wanted name that the last artifact did not carry either is
        # informational — it never built for this arch.
        never = sorted((want - have) - before)
        if never and previous is not None:
            lines.append(f"| | | | note — never built for {args.arch}: {', '.join(never)} |")

    if previous is not None:
        dropped = sorted({name for track, names in previous_loaded.items()
                          for name in names if name not in wanted.get(track, set())})
        if dropped:
            lines.append("")
            lines.append(f"Dropped from the manifest (not a regression): {', '.join(dropped)}")

    if regressions:
        lines.append("")
        lines.append(f"REGRESSION: published before, still in the manifest, now missing: {', '.join(regressions)}")

    text = "\n".join(lines) + "\n"
    print(text)
    if args.summary:
        with open(args.summary, "a") as handle:
            handle.write(text)
    if regressions:
        print(f"::error::{len(regressions)} coverage regression(s): {', '.join(regressions)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
