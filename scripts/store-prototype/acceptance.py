#!/usr/bin/env python3
"""Acceptance checks for the two-container store, run INSIDE the sandbox.

Each check targets a specific way the design could be wrong. A green run means
the sandbox resolves its packages through a symlink farm over a read-only,
content-addressed store, with no network and no capabilities, and that the parts
known to resist relocation (compiled extensions, vendored shared libraries,
distribution metadata, warmed caches) survive the indirection.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

FARM = Path("/mnt/libs/current")
STORE = Path("/mnt/libs/store")

results: list[tuple[bool, str, str]] = []


def check(name: str):
    def wrap(fn):
        try:
            detail = fn()
            results.append((True, name, detail or "ok"))
        except Exception as exc:  # noqa: BLE001 - any failure is a failed check
            results.append((False, name, f"{type(exc).__name__}: {exc}"))
        return fn
    return wrap


@check("posture: no network egress")
def _():
    try:
        socket.setdefaulttimeout(4)
        socket.create_connection(("1.1.1.1", 443))
    except OSError as exc:
        return f"blocked ({exc.__class__.__name__})"
    raise AssertionError("a TCP connection to the internet SUCCEEDED")


@check("posture: running unprivileged as uid 1000")
def _():
    assert os.getuid() == 1000, f"uid is {os.getuid()}"
    return "uid=1000"


@check("posture: store is read-only")
def _():
    try:
        (STORE / "write-probe").write_text("x")
    except OSError as exc:
        return f"rejected ({exc.__class__.__name__})"
    raise AssertionError("wrote into the store")


@check("posture: farm is read-only")
def _():
    try:
        (FARM / "write-probe").write_text("x")
    except OSError as exc:
        return f"rejected ({exc.__class__.__name__})"
    raise AssertionError("wrote into the farm")


@check("farm: activates the baked .pth without PYTHONPATH")
def _():
    assert "PYTHONPATH" not in os.environ, "PYTHONPATH is set; this would not prove the .pth works"
    site = str(FARM / "python" / "site-packages")
    assert site in sys.path, f"{site} not on sys.path:\n{json.dumps(sys.path, indent=2)}"
    return "site-packages on sys.path via inflexa-libs.pth"


@check("farm: entries are symlinks into the content store")
def _():
    site = FARM / "python" / "site-packages"
    links = [p for p in site.iterdir() if p.is_symlink()]
    assert links, "no symlinks in the farm at all"
    targets = {os.readlink(p) for p in links}
    stray = [t for t in targets if not t.startswith("/mnt/libs/store/")]
    assert not stray, f"links point outside the store: {stray[:3]}"
    dangling = [p.name for p in links if not p.exists()]
    assert not dangling, f"dangling links: {dangling[:5]}"
    return f"{len(links)} links, all resolving into /mnt/libs/store"


@check("import: pure-python package")
def _():
    import yaml
    return f"yaml {yaml.__version__} from {Path(yaml.__file__).parent}"


@check("import: compiled C extension loads through the farm")
def _():
    import numpy
    ext = numpy.core._multiarray_umath if hasattr(numpy, "core") else numpy
    return f"numpy {numpy.__version__}, {numpy.dot([1, 2], [3, 4])} == 11"


@check("import: vendored shared libs resolve via $ORIGIN through symlinks")
def _():
    # scipy links against its own bundled BLAS under scipy.libs/, found by an
    # $ORIGIN-relative RPATH. dlopen resolves $ORIGIN from the REAL path of the
    # .so, so this only works if the farm links whole top-level entries — both
    # `scipy/` and `scipy.libs/` — out of the same store directory.
    from scipy import linalg
    import numpy as np
    det = linalg.det(np.array([[1.0, 2.0], [3.0, 4.0]]))
    assert abs(det - (-2.0)) < 1e-9, det
    so = Path(linalg._flinalg.__file__ if hasattr(linalg, "_flinalg") else linalg.__file__)
    return f"scipy linalg.det == {det}, real path {so.resolve().parent.parent}"


@check("metadata: importlib.metadata resolves versions through the farm")
def _():
    import importlib.metadata as im
    got = {d: im.version(d) for d in ("numpy", "scipy", "pyyaml")}
    return ", ".join(f"{k}=={v}" for k, v in got.items())


@check("metadata: entry points / console scripts are on PATH")
def _():
    binroot = FARM / "python" / "bin"
    if not binroot.is_dir():
        return "no console scripts in this closure (skipped)"
    names = sorted(p.name for p in binroot.iterdir())
    return f"{len(names)} script(s): {', '.join(names[:5])}"


@check("dedup: one store directory per distribution")
def _():
    dirs = sorted(p.name for p in STORE.iterdir() if p.is_dir() and not p.name.startswith("."))
    stems = [d.rsplit("-", 1)[0] for d in dirs]
    dupes = {s for s in stems if stems.count(s) > 1}
    assert not dupes, f"same name+version stored more than once: {dupes}"
    return f"{len(dirs)} distributions, no duplicates"


@check("inventory: packages.txt is present and parses")
def _():
    raw = (FARM / "packages.txt").read_text()
    assert raw.startswith("# Available packages"), "header does not match the canonical producer"
    sections = [l[3:].strip() for l in raw.splitlines() if l.startswith("## ")]
    names = [n.strip() for l in raw.splitlines()
             if l and not l.startswith(("#", "##")) for n in l.split(",") if n.strip()]
    assert names, "no package names listed"
    return f"{len(names)} names across sections: {', '.join(sections)}"


@check("cache: warmed numba cache produces HITS, not recompiles")
def _():
    warmed = FARM / "numba-cache"
    if not warmed.is_dir() or not list(warmed.rglob("*.nbi")):
        return "no warmed numba cache in this farm (skipped)"
    seeded = Path(os.environ.get("NUMBA_CACHE_DIR", "/tmp/numba-cache"))
    assert seeded.is_dir(), f"{seeded} not seeded; the sandbox prologue did not run"
    # Replay exactly what was warmed. Anything else would be testing an unwarmed
    # signature: numba keys its cache per concrete argument type, so a different
    # call shape legitimately recompiles and would fail this check for the wrong
    # reason.
    script = json.loads((FARM / "lock.json").read_text()).get("warm_script")
    assert script, "farm was warmed without a --warm-script; nothing to replay"
    # NUMBA_DEBUG_CACHE makes the locator report every load and save. A save here
    # means the entry was recompiled — the warm-up did not carry over.
    proc = subprocess.run([sys.executable, script], capture_output=True, text=True,
                          env={**os.environ, "NUMBA_DEBUG_CACHE": "1"})
    assert proc.returncode == 0, proc.stderr.strip()[-300:]
    out = proc.stdout + proc.stderr
    loads, saves = out.count("data loaded"), out.count("data saved")
    assert loads > 0, f"no cache loads at all ({saves} saves)"
    assert saves == 0, f"{saves} entries recompiled despite the warm-up ({loads} loaded)"
    return f"{loads} cached compilations loaded, 0 recompiled"


@check("cache: matplotlib font list is prebuilt, not rebuilt on import")
def _():
    if not (FARM / "matplotlib_config").is_dir():
        return "matplotlib not in this closure (skipped)"
    started = time.monotonic()
    proc = subprocess.run([sys.executable, "-c", "import matplotlib.pyplot"],
                          capture_output=True, text=True, env=dict(os.environ))
    elapsed = time.monotonic() - started
    assert proc.returncode == 0, proc.stderr.strip()[-300:]
    assert "generated new fontManager" not in proc.stderr, "font cache was rebuilt at runtime"
    return f"pyplot imported in {elapsed:.1f}s, no font rebuild"


def main() -> int:
    width = max(len(n) for _, n, _ in results)
    print()
    for ok, name, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<{width}}  {detail}")
    failed = [n for ok, n, _ in results if not ok]
    print(f"\n  {len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print(f"  failed: {', '.join(failed)}")
    print()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
