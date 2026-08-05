#!/usr/bin/env python3
"""Unit tests for the store-side logic of ``provision.py``.

These cover the OFFLINE-verifiable slice of the change's §9 verification tasks
(``harness/openspec/changes/content-addressed-lib-store/tasks.md``). Each test
drives the real Python logic of ``provision.py``; every external tool the code
shells out to (``uv``, ``chmod``, ``Rscript``/``R``/``pak``) is monkeypatched at
``provision.subprocess.run``, so the whole suite runs with only the standard
library — no ``uv``, no ``docker``, no third-party packages, no yaml.

Run with either::

    python3 -m unittest -v images/sandbox-provisioner/test_provision.py
    cd images/sandbox-provisioner && python3 -m unittest -v test_provision
    python3 images/sandbox-provisioner/test_provision.py

§9 coverage map (test -> task):
  ContentAddressingTests.test_ensure_stored_content_address_and_reuse -> 2.2/2.3, 3.2
  ContentAddressingTests.test_store_r_package_content_address_and_reuse -> 6.1 (store side)
  VerifyStoreTests.test_verify_detects_tampering                      -> 9.6, 2.5
  RepairTests.test_repair_clears_staging_and_is_idempotent            -> 9.5, 2.4
  StoreLockTests.test_second_acquire_reports_conflict                 -> 9.8, 7.1
  FlipCurrentTests.test_refused_under_active_lease                    -> 9.10, 7.2
  FarmAssemblyTests.test_build_farm_invariants                        -> 4.1/4.3/4.4, 4.6-guard
  FarmAssemblyTests.test_build_r_farm_skips_empty_subtree             -> 6.2
  SupplyChainTests.test_reject_off_index                              -> 3.1 (request boundary)
  SupplyChainTests.test_resolve_parses_hashes_and_rejects_off_host    -> 3.1 (resolved output)
  ProvisionRunTests.test_refused_repoint_keeps_farm_and_requested_set -> 9.10/7.2, 3.4, 4.5
  ProvisionRunTests.test_rebuild_drops_stale_links_but_keeps_records  -> 4.1/4.4, 4.5
  ProvisionRunTests.test_warm_runs_through_current_and_reaches_lock   -> 4.6, 5.2/5.4
  FailureMessageTests.test_failed_resolve_reports_uv_stderr           -> 3.1 (actionable failure)
  FailureMessageTests.test_failed_install_reports_uv_stderr           -> 3.2 (actionable failure)
  ReclaimTests.test_reclaim_keeps_referenced_drops_orphan            -> 7.3
  ReclaimTests.test_remove_farm_refuses_current                       -> 7.3

§9 tasks deliberately NOT covered here (require the real container / external
tools / a running host, i.e. CI- or container-gated, not unit-verifiable):
  9.1  port acceptance.py — needs a real installed farm (compiled extensions,
       $ORIGIN-relative vendored libs, distribution metadata).
  9.2  cache-effectiveness — replays a numba workload; needs the JIT toolchain.
  9.3  validate.py against a farm — belongs to the lib-store-validate suite.
  9.4  store-vs-image comparison — needs both real image builds.
  9.7  disk-full actionable message — the FS-full condition is not reproducible
       in a stdlib unit test.
  9.9  ~500-package scale + timing — needs real installs.
  9.11 amd64 run of the whole suite — an architecture/runner concern.
  9.12 Linux import-time re-measurement — a timing measurement, not a unit test.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

# provision.py computes LIBS/STORE/FARMS/LEASES/SANDBOX_MOUNT at IMPORT TIME from
# LIB_ROOT, so a temp root must exist before the import; every test then reassigns
# those module globals to its own hermetic temp store (see StoreTestCase.setUp), so
# no test ever writes to this import-time root — it stays empty and is removed in
# tearDownModule.
_IMPORT_ROOT = tempfile.mkdtemp(prefix="prov-import-")
os.environ["LIB_ROOT"] = _IMPORT_ROOT
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import provision  # noqa: E402  (import after LIB_ROOT/sys.path are set up)


def tearDownModule():
    shutil.rmtree(_IMPORT_ROOT, ignore_errors=True)


class StoreTestCase(unittest.TestCase):
    """Base: a fresh, isolated temp store per test.

    provision's import-time path globals are repointed at the temp store, and
    ``provision.subprocess.run`` is monkeypatched to a stdlib-only fake so no
    external tool (uv / chmod / Rscript) is ever invoked. LIBS is kept EQUAL to
    SANDBOX_MOUNT so build_farm's mount-path guard passes; a test that needs them
    to differ overrides SANDBOX_MOUNT locally and restores it.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="prov-test-"))
        provision.LIBS = self.root
        provision.STORE = self.root / "store"
        provision.FARMS = self.root / "farms"
        provision.LEASES = self.root / "leases"
        provision.SANDBOX_MOUNT = self.root
        provision.STORE.mkdir(parents=True, exist_ok=True)
        provision.FARMS.mkdir(parents=True, exist_ok=True)

        # Canned outputs the fake subprocess.run produces for the tool it stands in
        # for; a test overrides these before exercising the relevant code path.
        self.compile_text = ""
        self.install_tree: dict[str, str] = {}
        # What the fake uv reports, so a test can drive the failure paths.
        self.uv_rc = 0
        self.uv_stderr = ""
        # One entry per warm-up child: the PYTHONPATH it was given, and that path
        # resolved AT THAT MOMENT. The resolution has to happen in the fake,
        # because it is what proves `current` already selected the farm.
        self.warm_paths: list[tuple[str, str]] = []

        self._orig_run = provision.subprocess.run
        provision.subprocess.run = self._fake_run

    def tearDown(self):
        provision.subprocess.run = self._orig_run
        shutil.rmtree(self.root, ignore_errors=True)

    # -- monkeypatch + helpers ------------------------------------------------
    def _fake_run(self, cmd, *args, **kwargs):
        """Stand in for the external tools provision.py shells out to.

        - ``chmod`` -> no-op (the store is world-readable in the real run; the
          Python logic under test does not depend on the mode change here).
        - ``uv pip compile`` -> write the canned resolved requirements to the
          ``-o`` path the resolver asked for; the real logic then parses it.
        - ``uv pip install`` -> populate the ``--target`` staging dir with the
          canned install tree, so tree_hash sees real files.
        - ``inflexa-libs-refresh`` -> write the inventory the real producer would
          (see ``_fake_refresh``).
        - the warm-up interpreter -> record its PYTHONPATH and report success.

        ``self.uv_rc`` makes both uv steps fail with ``self.uv_stderr``.
        """
        argv = list(cmd)
        prog = argv[0]
        if prog == "chmod":
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == "uv" and "compile" in argv:
            if self.uv_rc:
                return SimpleNamespace(returncode=self.uv_rc, stdout="", stderr=self.uv_stderr)
            Path(argv[argv.index("-o") + 1]).write_text(self.compile_text)
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == "uv" and "install" in argv:
            if self.uv_rc:
                return SimpleNamespace(returncode=self.uv_rc, stdout="", stderr=self.uv_stderr)
            self._write_tree(Path(argv[argv.index("--target") + 1]), self.install_tree)
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog.endswith("inflexa-libs-refresh"):
            self._fake_refresh(Path(kwargs["env"]["INFLEXA_LIB_ROOT"]))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == provision.PYTHON:
            ppath = (kwargs.get("env") or {}).get("PYTHONPATH", "")
            self.warm_paths.append((ppath, os.path.realpath(ppath)))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        raise AssertionError(f"test triggered an unexpected subprocess: {argv!r}")

    @staticmethod
    def _fake_refresh(root: Path) -> None:
        """Stand in for ``inflexa-libs-refresh --rederive``.

        Models the two properties of the real producer that the farm's records
        depend on: it re-derives a fragment only for a subtree that exists, and it
        concatenates every fragment it finds into packages.txt.
        """
        site = root / "python" / "site-packages"
        if site.is_dir():
            names = sorted(d.name.split("-")[0] for d in site.iterdir()
                           if d.name.endswith(".dist-info"))
            (root / "python.packages.txt").write_text(
                "## Python (pip)\n" + ", ".join(names) + "\n")
        for sub in provision.R_SUBTREES:
            subtree = root / "r" / sub
            if subtree.is_dir():
                (root / f"{sub}.packages.txt").write_text(
                    f"## R ({sub})\n" + ", ".join(sorted(p.name for p in subtree.iterdir())) + "\n")
        text = "# Available packages in the sandbox environment.\n\n"
        for frag in sorted(root.glob("*.packages.txt")):
            text += frag.read_text()
        (root / "packages.txt").write_text(text)

    @staticmethod
    def _args(farm: str, specs: list[str] | None = None, **over) -> SimpleNamespace:
        """The parsed command line ``_provision`` reads, with the parser defaults."""
        defaults = dict(farm=farm, specs=specs or [], r_manifest=None,
                        warm="", warm_script=None, force_repoint=False)
        return SimpleNamespace(**{**defaults, **over})

    @staticmethod
    def _write_tree(root: Path, tree: dict[str, str]) -> None:
        root.mkdir(parents=True, exist_ok=True)
        for rel, content in tree.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

    @staticmethod
    def _make_r_pkg(where: Path, name: str, version: str, body: str = "f <- function() 1L\n") -> Path:
        where.mkdir(parents=True, exist_ok=True)
        (where / "DESCRIPTION").write_text(f"Package: {name}\nVersion: {version}\nTitle: t\n")
        (where / "R").mkdir(exist_ok=True)
        (where / "R" / "code.R").write_text(body)
        return where


class ContentAddressingTests(StoreTestCase):
    """§2.2/2.3, §3.2, §6.1 — content addressing, reuse by pin marker, hashless refusal."""

    def test_ensure_stored_content_address_and_reuse(self):
        """§2.2/2.3, §3.2: a pin installs to store/<name>-<version>-<hash16>/ with a
        PIN_MARKER; a second store of the same pin reuses that dir; a hashless pin is
        refused and installs nothing."""
        self.install_tree = {
            "foo/__init__.py": "x = 1\n",
            "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n",
        }
        path, is_new = provision.ensure_stored("foo==1.0", ["sha256:abc"])
        self.assertTrue(is_new)
        self.assertEqual(path.parent, provision.STORE)
        self.assertRegex(path.name, r"^foo-1\.0-[0-9a-f]{16}$")
        marker = path / provision.PIN_MARKER
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.read_text().strip(), "foo==1.0")

        # Second store of the same pin is a reuse (found via the PIN_MARKER), not a
        # reinstall — same dir, is_new False.
        path2, is_new2 = provision.ensure_stored("foo==1.0", ["sha256:abc"])
        self.assertEqual(path2, path)
        self.assertFalse(is_new2)

        # A pin that reached here without a source hash is refused, installs nothing.
        before = set(provision.STORE.iterdir())
        with self.assertRaises(SystemExit) as cm:
            provision.ensure_stored("bar==2.0", [])
        self.assertIn("without a source hash", str(cm.exception))
        self.assertEqual(set(provision.STORE.iterdir()), before)

    def test_store_r_package_content_address_and_reuse(self):
        """§6.1 (store side): an already-installed R package directory is
        content-addressed into the store (name/version from DESCRIPTION), carries the
        PIN_MARKER, is published by rename, and a second identical install reuses it."""
        staging = provision.STORE / ".staging-r" / "cran"
        pkg1 = self._make_r_pkg(staging / "myRpkg", "myRpkg", "1.2.3")
        final, is_new = provision.store_r_package(pkg1)
        self.assertTrue(is_new)
        self.assertEqual(final.parent, provision.STORE)
        self.assertRegex(final.name, r"^myrpkg-1\.2\.3-[0-9a-f]{16}$")
        self.assertEqual((final / provision.PIN_MARKER).read_text().strip(), "myRpkg==1.2.3")
        self.assertFalse(pkg1.exists())  # published out of staging by rename

        pkg2 = self._make_r_pkg(staging / "myRpkg-again", "myRpkg", "1.2.3")
        final2, is_new2 = provision.store_r_package(pkg2)
        self.assertEqual(final2, final)
        self.assertFalse(is_new2)


class VerifyStoreTests(StoreTestCase):
    """§9.6 / §2.5 — a tampered store dir fails verify; a clean one passes; dot-dirs skipped."""

    def test_verify_detects_tampering(self):
        self.install_tree = {
            "pkg/__init__.py": "print('hi')\n",
            "pkg-1.0.dist-info/METADATA": "Name: pkg\n",
        }
        final, is_new = provision.ensure_stored("pkg==1.0", ["sha256:h"])
        self.assertTrue(is_new)

        # A clean, freshly-published store verifies clean.
        self.assertEqual(provision.verify_store(), 0)

        # The staging dot-dirs are skipped, not re-hashed: only the one published
        # store dir is checked.
        (provision.STORE / ".staging-r").mkdir(exist_ok=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = provision.verify_store()
        self.assertEqual(rc, 0)
        self.assertIn("1 store dir(s) checked", buf.getvalue())

        # Mutating stored content makes the content drift from its address: verify
        # returns 1 and names the offending dir.
        (final / "pkg" / "__init__.py").write_text("print('tampered')\n")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = provision.verify_store()
        self.assertEqual(rc, 1)
        self.assertIn("MISMATCH", buf.getvalue())
        self.assertIn(final.name, buf.getvalue())


class RepairTests(StoreTestCase):
    """§9.5 / §2.4 — repair clears abandoned staging (both tracks) and is idempotent."""

    def test_repair_clears_staging_and_is_idempotent(self):
        (provision.STORE / ".staging" / "foo").mkdir(parents=True)
        (provision.STORE / ".staging" / "foo" / "junk").write_text("partial install\n")
        (provision.STORE / ".staging-r" / "cran" / "bar").mkdir(parents=True)

        self.assertEqual(provision.repair_staging(), 0)
        self.assertFalse((provision.STORE / ".staging").exists())
        self.assertFalse((provision.STORE / ".staging-r").exists())
        self.assertTrue(provision.STORE.exists())  # only the staging trees are cleared

        # Idempotent: a second repair with nothing to clear still returns 0.
        self.assertEqual(provision.repair_staging(), 0)


class StoreLockTests(StoreTestCase):
    """§9.8 / §7.1 — a second store_lock reports the conflict; it re-acquires after release."""

    def test_second_acquire_reports_conflict(self):
        # Two open file descriptions on the same lock file conflict under flock even
        # within one process, which models two concurrent provisioning runs.
        with provision.store_lock():
            with self.assertRaises(SystemExit) as cm:
                with provision.store_lock():
                    pass
            self.assertIn("holds the store lock", str(cm.exception))

        # Released now: the lock re-acquires cleanly.
        with provision.store_lock():
            pass


class FlipCurrentTests(StoreTestCase):
    """§9.10 / §7.2 — re-pointing `current` is refused while a sandbox lease is active."""

    def _target(self) -> str:
        return os.readlink(provision.LIBS / "current")

    def test_refused_under_active_lease(self):
        provision.flip_current("a")
        self.assertEqual(self._target(), "farms/a")

        provision.add_lease("s1")
        # Re-point to a different farm under a live lease is refused; current unchanged.
        with self.assertRaises(SystemExit) as cm:
            provision.flip_current("b")
        self.assertIn("refusing to re-point", str(cm.exception))
        self.assertEqual(self._target(), "farms/a")

        # Re-pointing to the SAME target is a no-op even under a lease (no raise).
        provision.flip_current("a")
        self.assertEqual(self._target(), "farms/a")

        # --force is the escape hatch for a stale lease.
        provision.flip_current("b", force=True)
        self.assertEqual(self._target(), "farms/b")

        # After the lease drops, it moves freely again.
        provision.drop_lease("s1")
        provision.flip_current("a")
        self.assertEqual(self._target(), "farms/a")


class FarmAssemblyTests(StoreTestCase):
    """§4 — farm assembly invariants for the Python and R tracks."""

    def test_build_farm_invariants(self):
        """§4.1/4.3/4.4 + the mount-path guard: links top-level entries to absolute
        store targets, creates conda/ but not r//node//bin, and refuses when the store
        root is not the sandbox mount."""
        store_dir = provision.STORE / "demo-1.0-000000000000000f"
        (store_dir / "demo").mkdir(parents=True)
        (store_dir / "demo" / "__init__.py").write_text("VERSION = '1.0'\n")
        (store_dir / "demo-1.0.dist-info").mkdir()
        (store_dir / "demo-1.0.dist-info" / "METADATA").write_text("Name: demo\n")

        farm = provision.FARMS / "an1"
        collisions = provision.build_farm(farm, [store_dir])
        self.assertEqual(collisions, [])

        site = farm / "python" / "site-packages"
        link = site / "demo"
        self.assertTrue(link.is_symlink())
        target = os.readlink(link)
        self.assertTrue(os.path.isabs(target))          # absolute store target
        self.assertIn("/store/", target)                # under the store, not a host path
        self.assertTrue((site / "demo-1.0.dist-info").is_symlink())

        # conda is a bare mount point; r/ and node/ are NOT created for unprovisioned
        # tracks, so the inventory does not advertise empty sections.
        self.assertTrue((farm / "conda").is_dir())
        self.assertFalse((farm / "r").exists())
        self.assertFalse((farm / "node").exists())
        # No bin/ in the store dir -> nothing hoisted -> no python/bin.
        self.assertFalse((farm / "python" / "bin").exists())

        # Mount-path guard: farming a store rooted elsewhere would bake a path the
        # sandbox cannot resolve, so it is refused.
        saved = provision.SANDBOX_MOUNT
        provision.SANDBOX_MOUNT = self.root / "elsewhere"
        try:
            with self.assertRaises(SystemExit) as cm:
                provision.build_farm(provision.FARMS / "an2", [store_dir])
            self.assertIn("refusing to build a farm", str(cm.exception))
        finally:
            provision.SANDBOX_MOUNT = saved

    def test_build_r_farm_skips_empty_subtree(self):
        """§4.4/6.2: R packages link into r/{cran,bioconductor}; an empty subtree
        (github) is not created."""
        ra = provision.STORE / "rpkga-1.0-000000000000aaaa"
        rb = provision.STORE / "rpkgb-2.0-000000000000bbbb"
        ra.mkdir()
        rb.mkdir()

        farm = provision.FARMS / "rf"
        provision.build_r_farm(farm, {
            "cran": [("rpkgA", ra)],
            "bioconductor": [("rpkgB", rb)],
            "github": [],
        })
        self.assertTrue((farm / "r" / "cran" / "rpkgA").is_symlink())
        self.assertEqual(os.readlink(farm / "r" / "cran" / "rpkgA"), str(ra))
        self.assertTrue((farm / "r" / "bioconductor" / "rpkgB").is_symlink())
        self.assertFalse((farm / "r" / "github").exists())  # empty subtree skipped


class ProvisionRunTests(StoreTestCase):
    """A whole run of ``_provision``: what the farm keeps, and what it rebuilds.

    The farm's records (lock.json, meta.json, and the packages.txt inventory) are
    written before the step that can refuse, so a stop between the two never leaves
    a farm the harness drops without a message.
    """

    FOO_1 = "foo==1.0 \\\n    --hash=sha256:aaa\n"
    FOO_1_TREE = {"foo/__init__.py": "x = 1\n",
                  "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}
    RECORDS = ("lock.json", "meta.json", "packages.txt", "python.packages.txt")

    def _run(self, farm: str, specs: list[str] | None = None, **over) -> int:
        """Run a provisioning, with the run's own log kept out of the test output."""
        with contextlib.redirect_stdout(io.StringIO()):
            return provision._provision(self._args(farm, specs, **over))

    def test_refused_repoint_keeps_farm_and_requested_set(self):
        """A refused re-point costs the farm nothing: every record stays, and a
        later run reads the requested set back and adds to it."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)

        # A sandbox holds the store mounted, and `current` selects another farm, so
        # the re-point this run asks for is refused.
        provision.flip_current("other")
        provision.add_lease("s1")

        farm = provision.FARMS / "demo"
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            provision._provision(self._args("demo", ["foo"]))
        self.assertIn("refusing to re-point", str(cm.exception))

        # `current` is untouched, and the farm it did NOT select is complete: both
        # markers libStoreUsable needs, plus the lock that carries the request.
        self.assertEqual(os.readlink(provision.LIBS / "current"), "farms/other")
        for record in self.RECORDS:
            self.assertTrue((farm / record).is_file(), f"{record} did not survive")
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["requested"], ["foo"])
        self.assertEqual(lock["resolved"], ["foo==1.0"])
        self.assertEqual(json.loads((farm / "meta.json").read_text())["tracks"], ["python"])
        self.assertTrue((farm / "python" / "site-packages" / "foo").is_symlink())

        # The request survived, so the next run adds to it instead of reporting that
        # there is nothing to do (exit 2), which is what a lost lock produces.
        provision.drop_lease("s1")
        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        self.assertEqual(self._run("demo", ["bar"]), 0)
        self.assertEqual(json.loads((farm / "lock.json").read_text())["requested"],
                         ["bar", "foo"])
        self.assertEqual(os.readlink(provision.LIBS / "current"), "farms/demo")

    def test_rebuild_drops_stale_links_but_keeps_records(self):
        """A farm holds this run's closure and nothing else: a link, an R subtree,
        and an inventory fragment from an earlier run all go."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"
        self.assertEqual(self._run("demo", ["foo"]), 0)

        site = farm / "python" / "site-packages"
        first_target = os.readlink(site / "foo")
        self.assertTrue((site / "foo-1.0.dist-info").is_symlink())

        # An R track from an earlier run, with the fragment that run derived from it.
        # This run passes no R manifest, so both belong to the previous farm only.
        (farm / "r" / "cran").mkdir(parents=True)
        (farm / "r" / "cran" / "oldRpkg").symlink_to(
            str(provision.STORE / "oldrpkg-1.0-000000000000dead"))
        (farm / "cran.packages.txt").write_text("## R (CRAN)\noldRpkg\n")
        (farm / "r-bulk.lock").write_text("{}\n")

        # The same spec resolves to a new version, which is the real shape of a
        # stale link: the 1.0 metadata directory has no place in the 2.0 closure.
        self.compile_text = "foo==2.0 \\\n    --hash=sha256:ccc\n"
        self.install_tree = {"foo/__init__.py": "x = 2\n",
                             "foo-2.0.dist-info/RECORD": "foo/__init__.py,,\n"}
        self.assertEqual(self._run("demo"), 0)

        self.assertTrue((site / "foo-2.0.dist-info").is_symlink())
        self.assertFalse((site / "foo-1.0.dist-info").is_symlink())
        self.assertNotEqual(os.readlink(site / "foo"), first_target)
        self.assertFalse((farm / "r").exists())
        self.assertFalse((farm / "r-bulk.lock").exists())
        self.assertFalse((farm / "cran.packages.txt").exists())
        # The inventory must not advertise a package the farm no longer holds.
        self.assertNotIn("oldRpkg", (farm / "packages.txt").read_text())

        # The records stayed, and they describe this run.
        for record in self.RECORDS:
            self.assertTrue((farm / record).is_file(), f"{record} did not survive")
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["requested"], ["foo"])
        self.assertEqual(lock["resolved"], ["foo==2.0"])

    def test_warm_runs_through_current_and_reaches_lock(self):
        """The warm-up still runs after the flip and through `current`, and the lock
        still carries its results — neither is lost to the split write."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"
        self.assertEqual(self._run("demo", ["foo"], warm="foo"), 0)

        self.assertEqual(len(self.warm_paths), 1)
        given, resolved = self.warm_paths[0]
        # Through `current`, never the farm's own path: the JIT cache key holds the
        # source path the sandbox will import from.
        self.assertEqual(given, str(provision.LIBS / "current" / "python" / "site-packages"))
        # And `current` already selected this farm when the child ran, which is what
        # makes that path resolve to the farm.
        self.assertEqual(resolved, os.path.realpath(farm / "python" / "site-packages"))

        lock = json.loads((farm / "lock.json").read_text())
        self.assertTrue(lock["warm"]["foo"].startswith("ok"), lock["warm"])
        self.assertEqual(lock["warm"]["_numba_cache_entries"], "0")


class FailureMessageTests(StoreTestCase):
    """A tool that fails reports what failed, with the tool's own message."""

    def test_failed_resolve_reports_uv_stderr(self):
        self.uv_rc = 2
        self.uv_stderr = "error: Failed to fetch https://pypi.org/simple/numpy/"
        with self.assertRaises(SystemExit) as cm:
            provision.resolve(["numpy"])
        msg = str(cm.exception)
        self.assertIn("[provision] uv could not resolve numpy", msg)
        self.assertIn("exit 2", msg)
        self.assertIn(self.uv_stderr, msg)  # uv names the real cause

    def test_failed_install_reports_uv_stderr(self):
        self.uv_rc = 1
        self.uv_stderr = "error: Hash mismatch for foo==1.0"
        with self.assertRaises(SystemExit) as cm:
            provision.ensure_stored("foo==1.0", ["sha256:aaa"])
        msg = str(cm.exception)
        self.assertIn("[provision] uv could not install foo==1.0", msg)
        self.assertIn(self.uv_stderr, msg)


class SupplyChainTests(StoreTestCase):
    """§3 — supply-chain guards at the request boundary and in the resolved output."""

    def test_reject_off_index(self):
        # Naming a package (or a name==version / range) is allowed.
        provision.reject_off_index(["numpy", "scipy==1.11.4", "pandas>=2"])

        # Naming a location — URL, VCS, local path, or an artifact filename — is refused.
        for bad in (
            "torch @ https://example.com/torch.whl",
            "git+https://github.com/x/y",
            "./dist/pkg-1.0.whl",
            "/abs/pkg",
            "pkg-1.0.tar.gz",
            "pkg-1.0.zip",
            "https://example.com/x",
        ):
            with self.assertRaises(SystemExit):
                provision.reject_off_index([bad])

    def test_resolve_parses_hashes_and_rejects_off_host(self):
        # A canned --generate-hashes output, deliberately out of alphabetical order to
        # prove resolve() returns it sorted by pin.
        self.compile_text = (
            "# resolved via uv pip compile\n"
            "scipy==1.11.4 \\\n"
            "    --hash=sha256:ccc\n"
            "numpy==1.26.4 \\\n"
            "    --hash=sha256:aaa \\\n"
            "    --hash=sha256:bbb\n"
        )
        result = provision.resolve(["numpy", "scipy"])
        self.assertEqual(result, {
            "numpy==1.26.4": ["sha256:aaa", "sha256:bbb"],
            "scipy==1.11.4": ["sha256:ccc"],
        })
        self.assertEqual(list(result), ["numpy==1.26.4", "scipy==1.11.4"])  # sorted

        # A resolved line carrying a URL means a dependency resolved off-index: fail.
        self.compile_text = (
            "good==1.0 \\\n"
            "    --hash=sha256:x\n"
            "evil @ https://example.com/evil-1.0-py3-none-any.whl\n"
        )
        with self.assertRaises(SystemExit) as cm:
            provision.resolve(["good", "evil"])
        self.assertIn("unexpected host", str(cm.exception))


class ReclaimTests(StoreTestCase):
    """§7.3 — reclamation and farm removal as harness operations."""

    def test_reclaim_keeps_referenced_drops_orphan(self):
        a = provision.STORE / "keepa-1.0-000000000000000a"
        b = provision.STORE / "dropb-1.0-000000000000000b"
        for d in (a, b):
            (d / "mod").mkdir(parents=True)
            (d / "mod" / "__init__.py").write_text("pass\n")

        # A farm references `a`; nothing references `b`.
        provision.build_farm(provision.FARMS / "an1", [a])

        self.assertEqual(provision.reclaim(), 0)
        self.assertTrue(a.exists())   # still referenced by a farm
        self.assertFalse(b.exists())  # unreferenced -> reclaimed

    def test_remove_farm_refuses_current(self):
        (provision.FARMS / "keep").mkdir()
        (provision.FARMS / "gone").mkdir()
        provision.flip_current("keep")

        # A farm `current` does not select can be removed.
        self.assertEqual(provision.remove_farm("gone"), 0)
        self.assertFalse((provision.FARMS / "gone").exists())

        # The farm `current` points at is refused — a live sandbox may be reading it.
        with self.assertRaises(SystemExit) as cm:
            provision.remove_farm("keep")
        self.assertIn("current points at it", str(cm.exception))
        self.assertTrue((provision.FARMS / "keep").exists())

        # An unknown farm is a soft failure (exit code 2), not a raise.
        self.assertEqual(provision.remove_farm("nonexistent"), 2)


if __name__ == "__main__":
    unittest.main()
