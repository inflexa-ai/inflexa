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
  StoreLockTests.test_reclaim_excludes_an_acquisition_run             -> 9.8, 7.1
  LeaseGuardTests.test_a_lease_records_its_farm                       -> 9.10, 7.2
  FarmAssemblyTests.test_build_farm_invariants                        -> 4.1/4.3/4.4, 4.6-guard
  FarmAssemblyTests.test_build_r_farm_skips_empty_subtree             -> 6.2
  PublishFarmTests.test_publish_to_fresh_name                         -> 4.5 (atomic publish)
  PublishFarmTests.test_swap_replaces_existing_farm                   -> 4.5 (atomic swap)
  FarmSwapRecoveryTests.test_repair_restores_farm_after_interrupted_swap -> 9.5/4.5
  FarmSwapRecoveryTests.test_repair_drops_superseded_and_staging_debris  -> 9.5
  BiocReleaseTests.test_cran_only_lock_names_no_release               -> 6.4
  BiocReleaseTests.test_one_release_is_deduplicated                   -> 6.4
  BiocReleaseTests.test_two_releases_are_both_kept_and_sorted         -> 6.4
  BiocReleaseTests.test_git_pin_contributes_no_release                -> 6.4
  BiocReleaseTests.test_absent_lock_gives_empty_list                  -> 6.4
  BiocReleaseTests.test_damaged_entries_are_skipped                   -> 6.4
  SupplyChainTests.test_reject_off_index                              -> 3.1 (request boundary)
  SupplyChainTests.test_resolve_parses_hashes_and_rejects_off_host    -> 3.1 (resolved output)
  ProvisionRunTests.test_rebuild_drops_stale_links_but_keeps_records  -> 4.1/4.4, 4.5
  ProvisionRunTests.test_warm_runs_through_the_supplied_bind_and_reaches_lock -> 4.6, 5.2/5.4
  FailureMessageTests.test_failed_resolve_reports_uv_stderr           -> 3.1 (actionable failure)
  FailureMessageTests.test_failed_install_reports_uv_stderr           -> 3.2 (actionable failure)
  ReclaimTests.test_reclaim_keeps_referenced_drops_orphan            -> 7.3
  ReclaimTests.test_remove_farm_refuses_under_a_lease_of_that_farm    -> 7.3

Track preservation coverage map (test -> task of the change
``harness/openspec/changes/preserve-farm-tracks-and-single-runtime-image``):
  TrackPreservationTests.test_adding_a_python_package_keeps_the_r_track     -> 6.1
  TrackPreservationTests.test_records_cover_the_preserved_track             -> 6.2
  TrackPreservationTests.test_a_rebuilt_track_replaces_the_preserved_one    -> 6.3
  TrackPreservationTests.test_preservation_installs_nothing_and_opens_no_network -> 6.4
  TrackPreservationTests.test_a_stopped_run_leaves_a_farm_with_both_tracks  -> 6.5
  TrackPreservationTests.test_reclaim_spares_a_store_dir_of_a_preserved_track -> 6.6
  FarmAssemblyTests.test_farm_holds_no_conda_and_no_node                    -> 6.7

Task 6.8 and task 6.9 are NOT covered here: 6.8 needs a real sandbox with a store
mounted, and 6.9 needs the pak build, which does not fit the memory of a laptop.

Per-analysis farm mount coverage map (test -> task of the change
``harness/openspec/changes/per-analysis-farm-mount``):
  ProvisionRunTests.test_publish_writes_no_current_and_leaves_an_old_one_alone -> 4.4
  ProvisionRunTests.test_warm_runs_through_the_supplied_bind_and_reaches_lock  -> 4.3
  ProvisionRunTests.test_a_warm_run_without_the_bind_reports_it              -> 4.3
  LeaseGuardTests.test_a_lease_blocks_no_acquisition_run_and_no_extension    -> 4.2
  ReclaimTests.test_remove_farm_refuses_under_a_lease_of_that_farm           -> 4.2
  StoreLockTests.*                                                          -> 5.1/5.3
  ParallelAcquisitionTests.test_two_runs_for_two_packages_both_complete      -> 5.4
  ParallelAcquisitionTests.test_two_runs_for_one_package_converge_on_one_store_dir -> 5.5
  ParallelAcquisitionTests.test_a_publish_that_loses_the_race_keeps_the_published_copy -> 5.5
  ParallelAcquisitionTests.test_a_crashed_run_leaves_only_reclaim_food       -> 5.6
  MarkerTests.*                                                             -> 6.1
  DependencyGraphTests.test_a_python_node_carries_the_track_imports_entry_points_and_edges -> 6.1
  DependencyGraphTests.test_an_r_node_carries_its_inner_directory_and_its_dcf_edges -> 6.2
  DependencyGraphTests.test_an_edge_into_an_image_owned_package_drops        -> 6.3
  DependencyGraphTests.test_the_standalone_emitter_covers_every_farm         -> 6.4
  DependencyGraphTests.test_a_dangling_edge_fails_the_build_and_names_the_edge -> 6.5
  DependencyGraphTests.test_an_append_keeps_every_earlier_node_byte_identical -> 6.6

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
import errno
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
import unittest
import unittest.mock
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

import emit_deps  # noqa: E402  (import after LIB_ROOT/sys.path are set up)
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
        # A run sets the token, and the token names the staging trees of that run.
        # Clear it, so a test that calls a step directly reads the plain names.
        provision.RUN_TOKEN = ""
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
        # because it is what proves the bind of the farm resolved for the child.
        self.warm_paths: list[tuple[str, str]] = []
        # The argv of every external tool the run shelled out to. A preservation
        # test reads it to prove that a preserved track ran no installer.
        self.calls: list[list[str]] = []

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
        self.calls.append(argv)
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
                        warm="", warm_script=None)
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
        # The package nests inside the store directory under its real name, thus a
        # package that rebuilds its path as libname/packagename resolves itself.
        self.assertTrue((final / "myRpkg" / "DESCRIPTION").is_file())
        self.assertEqual((final / "myRpkg" / provision.PIN_MARKER).read_text().strip(), "myRpkg==1.2.3")
        self.assertFalse(pkg1.exists())  # published out of staging by rename

        pkg2 = self._make_r_pkg(staging / "myRpkg-again", "myRpkg", "1.2.3")
        final2, is_new2 = provision.store_r_package(pkg2)
        self.assertEqual(final2, final)
        self.assertFalse(is_new2)

    def test_store_r_package_records_linking_to(self):
        """§6.5: a stored R package records the LinkingTo packages from its
        DESCRIPTION, so a package compiled against another package's headers is
        recorded together with it. The record does not change the content address."""
        staging = provision.STORE / ".staging-r" / "cran"
        staging.mkdir(parents=True)
        pkg = staging / "cpkg"
        (pkg / "R").mkdir(parents=True)
        (pkg / "R" / "code.R").write_text("f <- function() 1L\n")
        # LinkingTo spans two lines and carries a version constraint; the record keeps
        # the bare names only.
        (pkg / "DESCRIPTION").write_text(
            "Package: cpkg\nVersion: 1.0\nTitle: t\n"
            "LinkingTo: Rcpp (>= 1.0.0), RcppArmadillo,\n    BH\n"
            "Imports: methods\n")

        final, is_new = provision.store_r_package(pkg)
        self.assertTrue(is_new)
        record = json.loads((final / "cpkg" / provision.R_LINKING_MARKER).read_text())
        self.assertEqual(record, ["Rcpp", "RcppArmadillo", "BH"])

        # The marker is excluded from the content address, so verify re-hashes clean.
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.verify_store(), 0)

        # A package with no LinkingTo records an empty list, not a missing marker.
        plain = self._make_r_pkg(staging / "plainpkg", "plainpkg", "2.0")
        final_plain, _ = provision.store_r_package(plain)
        self.assertEqual(json.loads((final_plain / "plainpkg" / provision.R_LINKING_MARKER).read_text()), [])


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
    """§5.1/§5.3 — one lock file, two modes: shared acquisition, exclusive reclaim.

    Two open file descriptions on the same lock file conflict under flock even
    within one process, which models two concurrent runs.
    """

    def test_two_acquisition_runs_share_the_lock(self):
        """The shared mode does not refuse a second acquisition run."""
        with provision.store_lock_shared():
            with provision.store_lock_shared():
                pass

    def test_reclaim_excludes_an_acquisition_run(self):
        """The exclusive mode waits while an acquisition run holds the lock, and it
        takes the lock once the run releases it."""
        with provision.store_lock_shared():
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
                with provision.store_lock_exclusive(wait=False):
                    pass
            self.assertIn("acquisition run holds the store lock", str(cm.exception))

        # Released now: the exclusive mode takes the lock cleanly.
        with provision.store_lock_exclusive(wait=False):
            pass

    def test_an_acquisition_run_refuses_under_reclaim(self):
        """Reclaim blocks a new acquisition run, and the run reports the conflict
        rather than queueing behind a scan of unknown length."""
        with provision.store_lock_exclusive(wait=False):
            with self.assertRaises(SystemExit) as cm:
                with provision.store_lock_shared():
                    pass
            self.assertIn("reclaim holds the store lock", str(cm.exception))

    def test_the_commit_mutex_is_a_second_lock_file(self):
        """The commit mutex is its own file, thus a commit never blocks on the store
        lock and the two orders can never deadlock."""
        with provision.store_lock_shared(), provision.commit_lock():
            self.assertTrue((provision.LIBS / ".commit.lock").is_file())
            self.assertTrue((provision.LIBS / ".provision.lock").is_file())


class LeaseGuardTests(StoreTestCase):
    """§4.2 — a lease blocks the removal of the farm that it names, and nothing else."""

    def test_a_lease_records_its_farm(self):
        provision.add_lease("s1", "alpha")
        self.assertEqual(provision.active_leases(), ["s1"])
        self.assertEqual(provision.lease_farm("s1"), "alpha")
        self.assertEqual(provision.leases_of_farm("alpha"), ["s1"])
        # The lease of one farm does not hold another farm.
        self.assertEqual(provision.leases_of_farm("beta"), [])

    def test_a_lease_that_names_no_farm_holds_every_farm(self):
        """The farm of the sandbox is unknown, thus the lease holds each farm. A
        removal is destructive, and an unknown farm cannot make it safe."""
        provision.add_lease("s1")
        self.assertEqual(provision.leases_of_farm("alpha"), ["s1"])
        self.assertEqual(provision.leases_of_farm("beta"), ["s1"])
        provision.drop_lease("s1")
        self.assertEqual(provision.leases_of_farm("alpha"), [])

    def test_a_lease_blocks_no_acquisition_run_and_no_extension(self):
        """§4.2: a live lease of the farm that the run extends costs the run nothing.
        An added link changes no path that the sandbox already resolved."""
        self.compile_text = "foo==1.0 \\\n    --hash=sha256:aaa\n"
        self.install_tree = {"foo/__init__.py": "x = 1\n",
                             "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision._provision(self._args("demo", ["foo"])), 0)

        farm = provision.FARMS / "demo"
        before = os.readlink(farm / "python" / "site-packages" / "foo")
        provision.add_lease("s1", "demo")

        # A second run extends the live farm under the lease.
        self.compile_text = ("bar==2.0 \\\n    --hash=sha256:bbb\n"
                             "foo==1.0 \\\n    --hash=sha256:aaa\n")
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision._provision(self._args("demo", ["bar"])), 0)

        site = farm / "python" / "site-packages"
        self.assertTrue((site / "bar").is_symlink())
        # The path the sandbox resolved before the run resolves the same content.
        self.assertEqual(os.readlink(site / "foo"), before)


class FarmAssemblyTests(StoreTestCase):
    """§4 — farm assembly invariants for the Python and R tracks."""

    def test_build_farm_invariants(self):
        """§4.1/4.3/4.4 + the mount-path guard: links top-level entries to absolute
        store targets, creates no r//node//conda//bin, and refuses when the store
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

        # conda, r/ and node/ are NOT created. The image owns the conda track and the
        # Node track, and an empty r/ would advertise an empty section.
        self.assertFalse((farm / "conda").exists())
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

    def _pkg(self, store_dir_name, module, extra_top=None):
        """A store directory holding one regular package, and an optional second one."""
        d = provision.STORE / store_dir_name
        (d / module).mkdir(parents=True)
        (d / module / "__init__.py").write_text(f"# {module}\n")
        if extra_top is not None:
            (d / extra_top).mkdir(parents=True)
            (d / extra_top / "__init__.py").write_text("# a top-level package the wheel ships\n")
            (d / extra_top / f"{module}_case.py").write_text("# case\n")
        return d

    def test_two_distributions_that_share_a_top_level_package_merge(self):
        """The published catalog holds `tests`, `benchmarks`, and `resources` from two
        distributions each, and each carries its own `__init__.py`. A merge is what an
        install into one site-packages gives, thus a refusal would refuse the catalog."""
        a = self._pkg("spectrum-like-0.5.0-00000000000ab001", "speclike", extra_top="tests")
        b = self._pkg("airr-like-2.0.0-00000000000ab002", "airrlike", extra_top="tests")

        farm = provision.FARMS / "an-merge"
        provision.build_farm(farm, [a, b])

        site = farm / "python" / "site-packages"
        self.assertTrue((site / "tests").is_dir())
        self.assertFalse((site / "tests").is_symlink())
        self.assertTrue((site / "tests" / "speclike_case.py").is_symlink())
        self.assertTrue((site / "tests" / "airrlike_case.py").is_symlink())

    def test_two_versions_of_one_distribution_refuse(self):
        """A farm resolves one version for a name. The second version would shadow the
        first, thus the run refuses rather than publish a farm that no lock describes.
        The composer of the CLI refuses at the same point."""
        a = self._pkg("demo-1.0-00000000000ab010", "demo")
        b = self._pkg("demo-2.0-00000000000ab011", "demo")

        with self.assertRaises(SystemExit) as cm:
            provision.build_farm(provision.FARMS / "an-collide", [a, b])

        self.assertIn("two versions of demo", str(cm.exception))

    def test_a_farm_under_a_hyphenated_root_still_merges(self):
        """The store directory of a path is read from the `store` component and never
        from a scan of each part. A temporary root whose own name carries two hyphens
        would otherwise read as a store directory and give a false refusal."""
        a = self._pkg("alpha-1.0-00000000000ab020", "alpha", extra_top="tests")
        b = self._pkg("beta-1.0-00000000000ab021", "beta", extra_top="tests")

        provision.build_farm(provision.FARMS / "an-hyphen", [a, b])

        self.assertTrue((provision.FARMS / "an-hyphen" / "python" / "site-packages" / "tests").is_dir())

    def test_farm_holds_no_conda_and_no_node(self):
        """§6.7: a farm the provisioner builds holds no conda directory and no node
        directory. The image owns both tracks, at a path outside the store mount, and
        a conda prefix cannot resolve from a path that a publish step swaps."""
        store_dir = provision.STORE / "demo-1.0-000000000000000f"
        (store_dir / "demo").mkdir(parents=True)
        (store_dir / "demo" / "__init__.py").write_text("x = 1\n")

        farm = provision.FARMS / "an1"
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_farm(farm, [store_dir])

        self.assertFalse((farm / "conda").exists())
        self.assertFalse((farm / "node").exists())

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
        # The target is the inner directory, whose basename is the package name.
        self.assertEqual(os.readlink(farm / "r" / "cran" / "rpkgA"), str(ra / "rpkgA"))
        self.assertTrue((farm / "r" / "bioconductor" / "rpkgB").is_symlink())
        self.assertFalse((farm / "r" / "github").exists())  # empty subtree skipped

    def test_published_farm_holds_no_dangling_link(self):
        """A published farm resolves every link that it holds.

        build_farm writes the farm at a staging path, and publish_farm renames it to
        the live name. Thus a link that names the farm by an absolute path keeps the
        staging path, and it dangles after the rename. Two distributions that both
        carry console scripts promote site-packages/bin to a real directory, which is
        the shape that the hoisted bin links have to survive.
        """
        store_dirs = []
        for name, script in (("alpha", "alpha-cli"), ("beta", "beta-cli")):
            store_dir = provision.STORE / f"{name}-1.0-00000000000000{name[0]}0"
            (store_dir / name).mkdir(parents=True)
            (store_dir / name / "__init__.py").write_text(f"x = '{name}'\n")
            (store_dir / "bin").mkdir()
            (store_dir / "bin" / script).write_text("#!/usr/bin/env python3\n")
            store_dirs.append(store_dir)

        staging = provision.FARMS / (provision.FARM_STAGING + "an1")
        staging.mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_farm(staging, store_dirs)
        farm = provision.FARMS / "an1"
        provision.publish_farm(staging, farm)

        # Both scripts are hoisted, thus the check below has something to resolve.
        self.assertTrue((farm / "python" / "bin" / "alpha-cli").is_symlink())
        self.assertTrue((farm / "python" / "bin" / "beta-cli").is_symlink())

        # os.walk does not follow a link, thus the sweep stays inside the farm and it
        # reports the link itself and never the tree behind it.
        dangling = []
        for parent, subdirs, files in os.walk(farm):
            for entry in sorted(subdirs + files):
                path = Path(parent) / entry
                if path.is_symlink() and not path.exists():
                    dangling.append(f"{path} -> {os.readlink(path)}")
        self.assertEqual(dangling, [], "the published farm holds a dangling link")


class BiocReleaseTests(StoreTestCase):
    """§6.4 — the Bioconductor releases come from the pak lock, not from a query to R.

    The lock holds the URL each package came from, so it is the one record that
    states which releases a farm holds. A farm can hold more than one release, thus
    the result is a list. Every entry below copies the shape of a real pak lock.
    """

    def _lock(self, *packages: dict) -> Path:
        """Write a pak lock file that holds `packages`, and give back its path."""
        path = self.root / "r-bulk.lock"
        path.write_text(json.dumps({
            "lockfile_version": 1,
            "os": "linux",
            "r_version": "4.5.1",
            "platform": "aarch64-unknown-linux-gnu-ubuntu-24.04",
            "packages": list(packages),
            "sysreqs": [],
        }))
        return path

    @staticmethod
    def _cran(name: str, version: str) -> dict:
        repo = "https://p3m.dev/cran/__linux__/noble/2026-06-23"
        return {
            "package": name, "version": version, "type": "standard", "repotype": "cran",
            "platform": "aarch64-unknown-linux-gnu-ubuntu-24.04",
            "sources": [f"{repo}/src/contrib/{name}_{version}.tar.gz"],
            "metadata": {"RemoteRepos": repo},
        }

    @staticmethod
    def _bioc(name: str, version: str, release: str) -> dict:
        repo = f"https://bioconductor.org/packages/{release}/bioc"
        return {
            "package": name, "version": version, "type": "bioc", "repotype": "bioc",
            "platform": "source",
            "sources": [f"{repo}/src/contrib/{name}_{version}.tar.gz"],
            "metadata": {"RemoteRepos": repo},
        }

    def test_cran_only_lock_names_no_release(self):
        """A lock with only CRAN packages names no Bioconductor release."""
        lock = self._lock(self._cran("jsonlite", "2.0.0"), self._cran("cli", "3.6.5"))
        self.assertEqual(provision.bioc_releases(lock), [])

    def test_one_release_is_deduplicated(self):
        """Two packages from one release give that release one time."""
        lock = self._lock(
            self._cran("jsonlite", "2.0.0"),
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            self._bioc("S4Vectors", "0.48.0", "3.23"),
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

    def test_two_releases_are_both_kept_and_sorted(self):
        """A farm can hold two releases at the same time, and both are recorded.

        The order is the order of the numbers. Release 3.9 comes before release 3.23,
        but as text it sorts after it.
        """
        lock = self._lock(
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            self._bioc("limma", "3.64.1", "3.22"),
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.22", "3.23"])

        lock = self._lock(
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            self._bioc("limma", "3.40.6", "3.9"),
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.9", "3.23"])

        # An annotation package comes from a different repo of the same release, and
        # it must not add a second entry.
        lock = self._lock(
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            {"package": "org.Hs.eg.db", "version": "3.23.0", "type": "bioc",
             "repotype": "bioc", "platform": "source",
             "sources": ["https://bioconductor.org/packages/3.23/data/annotation/"
                         "src/contrib/org.Hs.eg.db_3.23.0.tar.gz"],
             "metadata": {"RemoteRepos": "https://bioconductor.org/packages/3.23/data/annotation"}},
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

    def test_git_pin_contributes_no_release(self):
        """A package pinned to a git commit names no release, and none is invented.

        The URL carries the package name where a release URL carries the release, and
        the commit is not a release. The other packages in the lock still count.
        """
        lock = self._lock(
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            {"package": "DEP", "version": "1.31.0", "type": "git", "repotype": "bioc",
             "platform": "source",
             "sources": ["https://git.bioconductor.org/packages/DEP"],
             "metadata": {"RemoteRef": "RELEASE_3_22",
                          "RemoteSha": "0f2b1c9e4a7d6b3f8c5e2a1d9b4f7c0e3a6d8b25",
                          "RemoteUrl": "https://git.bioconductor.org/packages/DEP"}},
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

    def test_absent_lock_gives_empty_list(self):
        """A run that writes no lock gives an empty list and raises nothing.

        A Python-only run has no R lock at all, and an R run can end before pak writes
        one.
        """
        self.assertEqual(provision.bioc_releases(self.root / "no-such.lock"), [])
        self.assertEqual(provision.bioc_releases(self.root), [])  # a directory, not a file

    def test_damaged_entries_are_skipped(self):
        """A partial or damaged entry is skipped, and the good entries still count."""
        lock = self._lock(
            {"package": "nosources", "version": "1.0"},
            {"package": "nometadata", "version": "1.0", "sources": []},
            {"package": "junkurl", "version": "1.0", "sources": ["not a url at all"],
             "metadata": {"RemoteRepos": None}},
            {"package": "wrongtypes", "version": "1.0", "sources": "a string, not a list",
             "metadata": "a string, not a dict"},
            "a string where an object belongs",
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
        )
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

        # A lock that is not JSON, and a lock without a `packages` list, both give an
        # empty list rather than a raise: the releases are provenance, and provenance
        # that cannot be read must not lose the packages that are already installed.
        damaged = self.root / "damaged.lock"
        damaged.write_text("{not json at all")
        self.assertEqual(provision.bioc_releases(damaged), [])
        damaged.write_text(json.dumps({"lockfile_version": 1}))
        self.assertEqual(provision.bioc_releases(damaged), [])
        damaged.write_text(json.dumps([1, 2, 3]))
        self.assertEqual(provision.bioc_releases(damaged), [])


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

    def test_publish_writes_no_current_and_leaves_an_old_one_alone(self):
        """§4.4: the store carries no active-farm pointer.

        A publish writes no `current` at the store root. A store from an earlier
        release still carries the link, and the run leaves it exactly as it is, thus
        a rollback resolves the same farm as before.
        """
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"

        # A fresh store: the publish leaves no pointer at the root.
        self.assertEqual(self._run("demo", ["foo"]), 0)
        current = provision.LIBS / "current"
        self.assertFalse(current.is_symlink())
        self.assertFalse(current.exists())
        # The farm is complete without it.
        for record in self.RECORDS:
            self.assertTrue((farm / record).is_file(), f"{record} is missing")

        # A store from an earlier release carries the link. The next run neither
        # reads it nor moves it.
        (provision.FARMS / "other").mkdir()
        current.symlink_to("farms/other")
        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        self.assertEqual(self._run("demo", ["bar"]), 0)

        self.assertEqual(os.readlink(current), "farms/other")
        self.assertTrue((farm / "python" / "site-packages" / "bar").is_symlink())

    def test_rebuild_drops_stale_links_but_keeps_records(self):
        """A rebuilt track holds this run's closure and nothing else: a link from an
        earlier run goes with the subtree that this run makes again."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"
        self.assertEqual(self._run("demo", ["foo"]), 0)

        site = farm / "python" / "site-packages"
        first_target = os.readlink(site / "foo")
        self.assertTrue((site / "foo-1.0.dist-info").is_symlink())

        # The same spec resolves to a new version, which is the real shape of a
        # stale link: the 1.0 metadata directory has no place in the 2.0 closure.
        self.compile_text = "foo==2.0 \\\n    --hash=sha256:ccc\n"
        self.install_tree = {"foo/__init__.py": "x = 2\n",
                             "foo-2.0.dist-info/RECORD": "foo/__init__.py,,\n"}
        self.assertEqual(self._run("demo"), 0)

        self.assertTrue((site / "foo-2.0.dist-info").is_symlink())
        self.assertFalse((site / "foo-1.0.dist-info").is_symlink())
        self.assertNotEqual(os.readlink(site / "foo"), first_target)
        # The inventory must not advertise a package the farm no longer holds.
        self.assertNotIn("foo-1.0", (farm / "packages.txt").read_text())

        # The records stayed, and they describe this run.
        for record in self.RECORDS:
            self.assertTrue((farm / record).is_file(), f"{record} did not survive")
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["requested"], ["foo"])
        self.assertEqual(lock["resolved"], ["foo==2.0"])

    def test_warm_runs_through_the_supplied_bind_and_reaches_lock(self):
        """§4.3: the warm-up runs through /mnt/libs/current, which the invoker binds
        for the run, and the lock still carries its results.

        The unit test stands a symlink in for the bind, because a bind mount needs a
        privilege that a host test does not hold. Both put the farm at the one path
        the sandbox imports from.
        """
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"
        self.assertEqual(self._run("demo", ["foo"]), 0)

        # The invoker supplies the bind of the target farm for the warm run.
        (provision.LIBS / "current").symlink_to(farm)
        self.assertEqual(self._run("demo", warm="foo"), 0)

        self.assertEqual(len(self.warm_paths), 1)
        given, resolved = self.warm_paths[0]
        # Through the bind, never the farm's own path: the JIT cache key holds the
        # source path the sandbox will import from.
        self.assertEqual(given, str(provision.LIBS / "current" / "python" / "site-packages"))
        # And the bind resolved to this farm when the child ran.
        self.assertEqual(resolved, os.path.realpath(farm / "python" / "site-packages"))

        lock = json.loads((farm / "lock.json").read_text())
        self.assertTrue(lock["warm"]["foo"].startswith("ok"), lock["warm"])
        self.assertEqual(lock["warm"]["_numba_cache_entries"], "0")

    def test_a_warm_run_without_the_bind_reports_it(self):
        """§4.3: the bind is the job of the invoker. A run with no bind names the
        path, because the caches it writes are then keyed on a path that no sandbox
        imports from."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(provision._provision(self._args("demo", ["foo"], warm="foo")), 0)
        self.assertIn("does not resolve to", buf.getvalue())
        self.assertIn(str(provision.LIBS / "current"), buf.getvalue())

    def test_union_reresolve_over_prior_request(self):
        """§3.4: a re-run resolves the union of the prior request and the new specs.

        The first run requests foo. The second requests bar, and the resolver then
        runs over both, so the farm holds both and the lock records both."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"
        self.assertEqual(self._run("demo", ["foo"]), 0)
        self.assertEqual(json.loads((farm / "lock.json").read_text())["requested"], ["foo"])

        # Capture what the resolver receives on the second run, which proves the
        # re-run solves over the union and not over the new spec alone.
        captured: list[list[str]] = []
        orig = provision.resolve

        def spy(specs):
            captured.append(list(specs))
            return orig(specs)

        provision.resolve = spy
        try:
            # foo==1.0 is already in the store, so the second run reuses it; only bar
            # installs. The compile output lists both, as the real resolver would.
            self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
            self.install_tree = {"bar/__init__.py": "y = 2\n",
                                 "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
            self.assertEqual(self._run("demo", ["bar"]), 0)
        finally:
            provision.resolve = orig

        self.assertEqual(captured[-1], ["bar", "foo"])   # resolved over the union
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["requested"], ["bar", "foo"])
        site = farm / "python" / "site-packages"
        self.assertTrue((site / "foo").is_symlink())      # the earlier request stays
        self.assertTrue((site / "bar").is_symlink())      # the new request is added

    def test_warm_workload_recorded_in_lock(self):
        """§5.4: the lock records the warm workload — the module list and a content
        hash of the script — so an effectiveness check can replay exactly what ran."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        farm = provision.FARMS / "demo"

        script = provision.STORE / "warmup.py"
        script_bytes = b"import foo\nfoo\n"
        script.write_bytes(script_bytes)

        self.assertEqual(
            self._run("demo", ["foo"], warm="foo,bar", warm_script=str(script)), 0)

        lock = json.loads((farm / "lock.json").read_text())
        workload = lock["warm_workload"]
        self.assertEqual(workload["modules"], ["foo", "bar"])
        self.assertEqual(workload["script_sha256"], hashlib.sha256(script_bytes).hexdigest())
        # The path stays too, so the effectiveness check can run the script.
        self.assertEqual(lock["warm_script"], str(script))


class TrackPreservationTests(StoreTestCase):
    """§6.1-§6.6 — a run preserves each track that it does not rebuild.

    The packages of a farm survive a run in the content-addressed store, because
    only reclaim removes a directory from it. What a run used to destroy is the
    VIEW: the r/{cran,bioconductor,github} link trees. These tests drive the whole
    of ``_provision``, thus they cover the carry-forward, the records, and the
    atomic publish together.
    """

    FOO_1 = "foo==1.0 \\\n    --hash=sha256:aaa\n"
    FOO_1_TREE = {"foo/__init__.py": "x = 1\n",
                  "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}

    def _run(self, farm: str, specs: list[str] | None = None, **over) -> int:
        with contextlib.redirect_stdout(io.StringIO()):
            return provision._provision(self._args(farm, specs, **over))

    def _seed_r_track(self, farm: Path, *names: str) -> dict[str, Path]:
        """Give `farm` an r/cran subtree of links into the store, as an R run leaves it."""
        subdir = farm / "r" / "cran"
        subdir.mkdir(parents=True, exist_ok=True)
        store_dirs = {}
        for index, name in enumerate(names):
            store_dir = provision.STORE / f"{name.lower()}-1.0-00000000000000{index:02d}"
            (store_dir / "R").mkdir(parents=True)
            (store_dir / "R" / "code.R").write_text("f <- function() 1L\n")
            (subdir / name).symlink_to(str(store_dir))
            store_dirs[name] = store_dir
        (farm / "r-bulk.lock").write_text('{"packages": []}\n')
        return store_dirs

    def _python_and_r_farm(self, name: str = "demo") -> Path:
        """A published farm that carries a `python` track and an `r` track."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        self.assertEqual(self._run(name, ["foo"]), 0)
        farm = provision.FARMS / name
        self._seed_r_track(farm, "rpkgA", "rpkgB")
        return farm

    def _fake_provision_r(self, *names: str):
        """Stand in for ``provision_r``: farm the named R packages, install nothing.

        The real function needs pak, R, and pyyaml. The orchestration under test is
        which track ``_provision`` builds and which track it carries forward.
        """
        def run(farm: Path, manifest: Path) -> dict:
            packages = []
            for index, name in enumerate(names):
                store_dir = provision.STORE / f"{name.lower()}-2.0-0000000000000f{index:02d}"
                store_dir.mkdir(exist_ok=True)
                packages.append((name, store_dir))
            provision.build_r_farm(farm, {"cran": packages, "bioconductor": [], "github": []})
            return {"packages": {"cran": len(packages), "bioconductor": 0, "github": 0},
                    "r_version": "4.6.0", "bioc_releases": []}
        return run

    def test_adding_a_python_package_keeps_the_r_track(self):
        """§6.1: a run that adds one Python specification and builds no R track
        publishes a farm that still resolves every R package."""
        farm = self._python_and_r_farm()
        before = {name: os.readlink(farm / "r" / "cran" / name) for name in ("rpkgA", "rpkgB")}

        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        self.assertEqual(self._run("demo", ["bar"]), 0)

        # The R links resolve through the same three R paths, at the same targets.
        for name, target in before.items():
            link = farm / "r" / "cran" / name
            self.assertTrue(link.is_symlink(), f"{name} lost its link")
            self.assertEqual(os.readlink(link), target)
        # The Python track carries both specifications.
        site = farm / "python" / "site-packages"
        self.assertTrue((site / "foo").is_symlink())
        self.assertTrue((site / "bar").is_symlink())
        # The provenance of the preserved track travels with it.
        self.assertTrue((farm / "r-bulk.lock").is_file())
        # The lock separates the rebuilt track from the inherited one.
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["tracks"], {"built": ["python"], "preserved": ["r"]})

    def test_records_cover_the_preserved_track(self):
        """§6.2: the published meta.json names both tracks, and packages.txt lists
        the R packages that the farm still resolves."""
        farm = self._python_and_r_farm()

        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        self.assertEqual(self._run("demo"), 0)

        self.assertEqual(json.loads((farm / "meta.json").read_text())["tracks"],
                         ["python", "r"])
        inventory = (farm / "packages.txt").read_text()
        self.assertIn("rpkgA", inventory)
        self.assertIn("rpkgB", inventory)
        self.assertIn("foo", inventory)
        # The producer derives the fragment again from the preserved subtree.
        self.assertIn("rpkgA", (farm / "cran.packages.txt").read_text())

    def test_a_rebuilt_track_replaces_the_preserved_one(self):
        """§6.3: a run that builds the R track publishes the new track, not a merge
        of the new track and the previous one."""
        farm = self._python_and_r_farm()

        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        original = provision.provision_r
        provision.provision_r = self._fake_provision_r("rpkgC")
        try:
            self.assertEqual(self._run("demo", r_manifest="/tmp/manifest.yaml"), 0)
        finally:
            provision.provision_r = original

        cran = farm / "r" / "cran"
        self.assertEqual(sorted(p.name for p in cran.iterdir()), ["rpkgC"])
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["tracks"], {"built": ["python", "r"], "preserved": []})

    def test_the_r_block_of_the_lock_carries_forward(self):
        """A run that does not build R carries the old lock's r block forward, so
        the record still describes the R closure that the farm resolves. A blank r
        block would make the lock deny the preserved R track.
        """
        # First, build a farm that carries a python track and an r track, and whose
        # lock records a real r block.
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        original = provision.provision_r
        provision.provision_r = self._fake_provision_r("rpkgC")
        try:
            self.assertEqual(self._run("demo", ["foo"], r_manifest="/tmp/manifest.yaml"), 0)
        finally:
            provision.provision_r = original
        farm = provision.FARMS / "demo"
        r_block = json.loads((farm / "lock.json").read_text())["r"]
        self.assertEqual(r_block["packages"]["cran"], 1)

        # A second run adds a Python package and builds no R track.
        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        self.assertEqual(self._run("demo", ["bar"]), 0)

        # The R track is preserved, thus the lock still names the R closure that the
        # farm inherited, and the r block is the block of the first run.
        lock = json.loads((farm / "lock.json").read_text())
        self.assertEqual(lock["tracks"]["preserved"], ["r"])
        self.assertEqual(lock["r"], r_block)

    def test_preservation_installs_nothing_and_opens_no_network(self):
        """§6.4: the preserved-track path runs no installer and no resolver.

        Every external tool of the run is recorded, so the check is on the tools the
        run reached for, not on a count of calls.
        """
        farm = self._python_and_r_farm()

        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        self.calls.clear()
        self.assertEqual(self._run("demo"), 0)

        # No R installer, no R resolver, and no load check ran for the preserved track.
        for argv in self.calls:
            self.assertNotIn(argv[0], ("Rscript", "R"), f"the run reached for R: {argv}")
        # foo==1.0 is already in the store, thus the Python track reinstalls nothing.
        self.assertEqual([a for a in self.calls if a[0] == "uv" and "install" in a], [])
        self.assertTrue((farm / "r" / "cran" / "rpkgA").is_symlink())

    def test_a_stopped_run_leaves_a_farm_with_both_tracks(self):
        """§6.5: a run that stops before the publish leaves the farm path with one
        complete farm, thus no track is lost."""
        farm = self._python_and_r_farm()

        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + self.FOO_1
        self.install_tree = {"bar/__init__.py": "y = 2\n",
                             "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}
        original = provision.publish_farm

        def stop(staging, target):
            raise RuntimeError("the run stopped before the publish")

        provision.publish_farm = stop
        try:
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                provision._provision(self._args("demo", ["bar"]))
        finally:
            provision.publish_farm = original

        # The old farm is complete: both tracks, and every record.
        self.assertTrue((farm / "python" / "site-packages" / "foo").is_symlink())
        self.assertTrue((farm / "r" / "cran" / "rpkgA").is_symlink())
        self.assertTrue((farm / "r" / "cran" / "rpkgB").is_symlink())
        self.assertTrue((farm / "r-bulk.lock").is_file())
        for record in ("lock.json", "meta.json", "packages.txt"):
            self.assertTrue((farm / record).is_file(), f"{record} did not survive")

    def test_reclaim_spares_a_store_dir_of_a_preserved_track(self):
        """§6.6: reclaim spares each store directory that a preserved track
        references, because the preserved links live in the reachable farm."""
        farm = self._python_and_r_farm()
        r_dirs = {name: provision.STORE / os.readlink(farm / "r" / "cran" / name).split("/store/")[1]
                  for name in ("rpkgA", "rpkgB")}
        orphan = provision.STORE / "orphan-1.0-00000000000000ff"
        orphan.mkdir()

        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        self.assertEqual(self._run("demo"), 0)

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.reclaim(), 0)
        for name, store_dir in r_dirs.items():
            self.assertTrue(store_dir.is_dir(), f"reclaim removed {name}")
        self.assertFalse(orphan.exists())


class CarryTreeForwardTests(StoreTestCase):
    """``carry_tree_forward`` writes a track again as links, and it stops loudly.

    These tests run on the host, thus they cannot reproduce virtiofs. The defect
    appears only on a macOS directory that podman bind-mounts, where llistxattr on a
    valid link returns ENOENT. ``shutil.copytree`` calls ``copystat`` on each new
    link, ``copystat`` reads the extended attributes of the source link, and the
    whole carry-forward failed with the source path named as the absent one.

    The real proof is the container check: bind-mount a farm-shaped macOS directory
    into ``ghcr.io/inflexa-ai/sandbox-provisioner`` and carry a track forward inside
    it. What these tests hold is the contract that the fix depends on. The walk
    reaches neither ``copytree`` nor ``copystat``, thus no call reaches the metadata
    layer of the mount, and a failure names the entry and the cause.
    """

    def _farm_shaped_track(self) -> tuple[Path, dict[str, str]]:
        """A track with the shape of a real one, and the target text of each link.

        The R subtrees are one level below ``r``, and one link is dangling, because
        a store directory that reclaim removed leaves one. The bytecode cache is the
        one regular file that a track can hold, and the warm step writes it.
        """
        src = self.root / "old-farm" / "r"
        targets = {
            "cran/rpkgA": f"{provision.STORE}/rpkga-1.0-000000000000aa01/rpkgA",
            "cran/rpkgB": f"{provision.STORE}/rpkgb-1.0-000000000000bb02/rpkgB",
            "bioconductor/deep/rpkgC": f"{provision.STORE}/rpkgc-1.0-000000000000cc03/rpkgC",
        }
        for rel, target in targets.items():
            link = src / rel
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(target)
        # rpkgA resolves, rpkgB does not. Thus the walk carries a dangling link too.
        Path(targets["cran/rpkgA"]).mkdir(parents=True)
        Path(targets["bioconductor/deep/rpkgC"]).mkdir(parents=True)
        cache = src / "__pycache__"
        cache.mkdir()
        (cache / "mod.cpython-312.pyc").write_bytes(b"\x00bytecode\n")
        return src, targets

    def test_a_tree_of_links_carries_forward_verbatim(self):
        """Each link keeps its target text, the nesting keeps its depth, and the
        walk touches no metadata."""
        src, targets = self._farm_shaped_track()
        dst = self.root / "staging-farm" / "r"

        def refuse(*args, **kwargs):
            raise AssertionError("the carry-forward reached the metadata layer")

        original = (provision.shutil.copytree, provision.shutil.copystat)
        provision.shutil.copytree, provision.shutil.copystat = refuse, refuse
        try:
            provision.carry_tree_forward(src, dst)
        finally:
            provision.shutil.copytree, provision.shutil.copystat = original

        for rel, target in targets.items():
            link = dst / rel
            self.assertTrue(link.is_symlink(), f"{rel} is not a link")
            self.assertEqual(os.readlink(link), target, f"{rel} changed its target")
        # rpkgB has no store directory, thus the carried link stays dangling and it
        # never becomes a copy of anything.
        self.assertFalse((dst / "cran" / "rpkgB").exists())
        self.assertTrue((dst / "cran" / "rpkgB").is_symlink())
        # The one regular file goes across as bytes.
        self.assertEqual((dst / "__pycache__" / "mod.cpython-312.pyc").read_bytes(),
                         b"\x00bytecode\n")
        # The destination holds the shape of the source, and nothing more.
        self.assertEqual(sorted(p.name for p in dst.iterdir()),
                         ["__pycache__", "bioconductor", "cran"])
        self.assertTrue((dst / "bioconductor" / "deep").is_dir())
        # The source stays complete, thus a stop before the swap costs no track.
        self.assertEqual(sorted(p.name for p in src.iterdir()),
                         ["__pycache__", "bioconductor", "cran"])

    def test_a_link_that_cannot_be_written_stops_the_run(self):
        """A refused link stops the run, and the message names the entry.

        The fault of the mount is modeled here, because the host cannot produce it.
        The old message named the source path alone, and the source was present.
        """
        src, _ = self._farm_shaped_track()
        dst = self.root / "staging-farm" / "r"

        def refuse(target, link):
            raise OSError(errno.ENOENT, "No such file or directory", str(link))

        original = provision.os.symlink
        provision.os.symlink = refuse
        try:
            with self.assertRaises(SystemExit) as caught:
                provision.carry_tree_forward(src, dst)
        finally:
            provision.os.symlink = original

        # The walk reads each name in order, thus bioconductor comes before cran.
        message = str(caught.exception)
        self.assertIn(str(src / "bioconductor" / "deep" / "rpkgC"), message)
        self.assertIn(str(dst / "bioconductor" / "deep" / "rpkgC"), message)
        self.assertIn("No such file or directory", message)

    def test_a_destination_that_exists_stops_the_run(self):
        """A destination that a prior run left stops the walk, and the message names
        the directory. A merge into it would mix two farms."""
        src, _ = self._farm_shaped_track()
        dst = self.root / "staging-farm" / "r"
        dst.mkdir(parents=True)

        with self.assertRaises(SystemExit) as caught:
            provision.carry_tree_forward(src, dst)
        self.assertIn(str(dst), str(caught.exception))


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


class AcquisitionRunTests(StoreTestCase):
    """The run that names no farm: it writes the pool and the graph, and nothing else.

    `inflexa store add` runs this shape. The store carries no active farm, thus an
    acquisition has no farm to write: each analysis composes its own farm on the
    host, from the pool. A run that DOES name a farm keeps building it, because the
    catalog build is that caller.
    """

    FOO_1 = "foo==1.0 \\\n    --hash=sha256:aaa\n"
    FOO_1_TREE = {"foo/__init__.py": "x = 1\n",
                  "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}

    def _main(self, argv: list[str]) -> int:
        """Drive the whole entry point, thus the routing of the arguments is under test."""
        original = sys.argv
        sys.argv = ["provision", *argv]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return provision.main()
        finally:
            sys.argv = original

    def test_the_pool_and_the_graph_land_and_no_farm_is_built(self):
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)

        self.assertEqual(self._main(["foo"]), 0)

        stored = list(provision.STORE.glob("foo-1.0-*"))
        self.assertEqual(len(stored), 1, stored)
        nodes = json.loads((provision.LIBS / "deps.json").read_text())["nodes"]
        self.assertEqual(list(nodes), [stored[0].name])
        self.assertEqual(nodes[stored[0].name]["track"], "python")
        self.assertEqual(nodes[stored[0].name]["imports"], ["foo"])
        # No farm, and no farm record at the store root either.
        self.assertEqual(sorted(p.name for p in provision.FARMS.iterdir()), [])
        self.assertFalse((provision.LIBS / "packages.txt").exists())
        self.assertFalse((provision.LIBS / "lock.json").exists())
        # The staging tree of the run went with it.
        self.assertEqual(sorted(p.name for p in provision.STORE.glob(".staging*")), [])

    def test_a_second_acquisition_of_the_same_spec_reuses_the_store_dir(self):
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        self.assertEqual(self._main(["foo"]), 0)
        graph_before = (provision.LIBS / "deps.json").read_text()

        self.assertEqual(self._main(["foo"]), 0)

        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)
        # The node is byte-identical, because a store directory is write-once.
        self.assertEqual((provision.LIBS / "deps.json").read_text(), graph_before)

    def test_a_named_farm_still_builds_that_farm(self):
        """The catalog build passes --farm, thus that shape must keep working."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)

        self.assertEqual(self._main(["--farm", "catalog", "foo"]), 0)

        farm = provision.FARMS / "catalog"
        self.assertTrue((farm / "python" / "site-packages" / "foo").is_symlink())
        for record in ("lock.json", "meta.json", "packages.txt"):
            self.assertTrue((farm / record).is_file(), f"{record} is missing")

    def test_a_run_with_no_farm_and_no_spec_reports_the_usage(self):
        self.assertEqual(self._main([]), 2)
        self.assertFalse((provision.LIBS / "deps.json").exists())

    def test_an_r_manifest_needs_a_farm(self):
        """pak installs and load-checks through a farm, thus the R track keeps needing one."""
        self.assertEqual(self._main(["--r-manifest", "/manifest.yaml"]), 2)
        self.assertEqual(sorted(p.name for p in provision.FARMS.iterdir()), [])


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

    def test_remove_farm_refuses_under_a_lease_of_that_farm(self):
        """§4.2: the one job of a lease. The removal of the farm that a lease names
        refuses, and the removal of each other farm goes ahead."""
        (provision.FARMS / "keep").mkdir()
        (provision.FARMS / "gone").mkdir()
        provision.add_lease("s1", "keep")

        # A farm that no lease names can be removed.
        self.assertEqual(provision.remove_farm("gone"), 0)
        self.assertFalse((provision.FARMS / "gone").exists())

        # The farm the lease names is refused — a live sandbox reads it now.
        with self.assertRaises(SystemExit) as cm:
            provision.remove_farm("keep")
        self.assertIn("sandbox lease(s) hold it", str(cm.exception))
        self.assertIn("s1", str(cm.exception))
        self.assertTrue((provision.FARMS / "keep").exists())

        # Once the sandbox exits, the host drops the lease and the removal goes ahead.
        provision.drop_lease("s1")
        self.assertEqual(provision.remove_farm("keep"), 0)

        # An unknown farm is a soft failure (exit code 2), not a raise.
        self.assertEqual(provision.remove_farm("nonexistent"), 2)


class ParallelAcquisitionTests(StoreTestCase):
    """§5.4-§5.6 — acquisition runs are parallel, and reclaim is the one exclusive writer.

    Each concurrent run is a forked child, thus two runs write into one store at the
    same moment, as two provisioner containers do. A child inherits the fake
    ``subprocess.run`` of the test, so it installs no real package, and it leaves
    through ``os._exit``, so it runs no teardown of the test.
    """

    FOO_1 = "foo==1.0 \\\n    --hash=sha256:aaa\n"
    FOO_1_TREE = {"foo/__init__.py": "x = 1\n",
                  "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}
    BAR_2 = "bar==2.0 \\\n    --hash=sha256:bbb\n"
    BAR_2_TREE = {"bar/__init__.py": "y = 2\n",
                  "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}

    def _fork_run(self, farm: str, specs: list[str], compile_text: str,
                  install_tree: dict[str, str], gate: Path) -> int:
        """Start one acquisition run in a child process, and give back its pid."""
        pid = os.fork()
        if pid:
            return pid
        code = 1
        try:
            self.compile_text = compile_text
            self.install_tree = dict(install_tree)
            # Wait for the parent, thus the two children overlap.
            for _ in range(3000):
                if gate.exists():
                    break
                time.sleep(0.001)
            with contextlib.redirect_stdout(io.StringIO()):
                with provision.store_lock_shared():
                    code = provision._provision(self._args(farm, specs))
        except BaseException:                              # noqa: BLE001 (a child reports and exits)
            (self.root / f"{farm}.err").write_text(traceback.format_exc())
            code = 9
        finally:
            os._exit(code)

    def _run_both(self, first: tuple, second: tuple) -> None:
        """Run two acquisition runs at the same time, and make sure both report 0."""
        gate = self.root / "go"
        pids = {self._fork_run(*first, gate): first[0],
                self._fork_run(*second, gate): second[0]}
        gate.write_text("go\n")
        for pid, farm in pids.items():
            _, status = os.waitpid(pid, 0)
            report = self.root / f"{farm}.err"
            detail = report.read_text() if report.is_file() else ""
            self.assertEqual(os.waitstatus_to_exitcode(status), 0,
                             f"the run of farm {farm} did not finish:\n{detail}")

    def test_two_runs_for_two_packages_both_complete(self):
        """§5.4: two concurrent runs for two packages both complete, and the pool
        holds the store directory of each."""
        self._run_both(("alpha", ["foo"], self.FOO_1, self.FOO_1_TREE),
                       ("beta", ["bar"], self.BAR_2, self.BAR_2_TREE))

        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)
        self.assertEqual(len(list(provision.STORE.glob("bar-2.0-*"))), 1)
        self.assertTrue((provision.FARMS / "alpha" / "python" / "site-packages" / "foo").is_symlink())
        self.assertTrue((provision.FARMS / "beta" / "python" / "site-packages" / "bar").is_symlink())
        # The commit of each run reached the shared graph.
        nodes = json.loads((provision.LIBS / "deps.json").read_text())["nodes"]
        self.assertEqual(len(nodes), 2)

    def test_two_runs_for_one_package_converge_on_one_store_dir(self):
        """§5.5: two concurrent runs that produce the same distribution converge on
        one store directory, and both report success."""
        self._run_both(("alpha", ["foo"], self.FOO_1, self.FOO_1_TREE),
                       ("beta", ["foo"], self.FOO_1, self.FOO_1_TREE))

        stored = list(provision.STORE.glob("foo-1.0-*"))
        self.assertEqual(len(stored), 1, stored)
        for farm in ("alpha", "beta"):
            link = provision.FARMS / farm / "python" / "site-packages" / "foo"
            self.assertTrue(link.is_symlink())
            self.assertEqual(os.readlink(link), f"{stored[0]}/foo")
        # No staging tree of either run stayed behind.
        self.assertEqual(sorted(p.name for p in provision.STORE.glob(".staging*")), [])

    def test_a_publish_that_loses_the_race_keeps_the_published_copy(self):
        """§5.5: the store directory is content-addressed, thus a run that reaches
        the publish second keeps the copy that the first run published.

        The fake chmod stands in for the parallel run: it publishes the same content
        between the check for the directory and the rename of this run.
        """
        self.install_tree = dict(self.FOO_1_TREE)
        winner: dict[str, Path] = {}
        outer = provision.subprocess.run

        def race(cmd, *args, **kwargs):
            argv = list(cmd)
            if argv[0] == "chmod" and not winner:
                staging = Path(argv[-1])
                digest = provision.tree_hash(staging)[:16]
                final = provision.STORE / f"foo-1.0-{digest}"
                self._write_tree(final, self.FOO_1_TREE)
                (final / provision.PIN_MARKER).write_text("foo==1.0\n")
                winner["path"] = final
            return outer(cmd, *args, **kwargs)

        provision.subprocess.run = race
        try:
            path, is_new = provision.ensure_stored("foo==1.0", ["sha256:aaa"])
        finally:
            provision.subprocess.run = outer

        self.assertEqual(path, winner["path"])
        self.assertFalse(is_new)
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)
        self.assertFalse((provision.STORE / ".staging" / "foo").exists())

    def test_a_crashed_run_leaves_only_reclaim_food(self):
        """§5.6: a run that dies before its commit leaves store directories that no
        farm references, and reclaim removes them. The graph does not change."""
        self.compile_text = self.FOO_1
        self.install_tree = dict(self.FOO_1_TREE)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision._provision(self._args("alpha", ["foo"])), 0)
        graph_before = (provision.LIBS / "deps.json").read_text()
        inventory_before = (provision.FARMS / "alpha" / "packages.txt").read_text()

        # The second run writes its pool directory and then dies before the commit.
        self.compile_text = self.BAR_2
        self.install_tree = dict(self.BAR_2_TREE)
        original = provision.build_farm

        def die(staging, store_dirs):
            raise RuntimeError("the run died before its commit")

        provision.build_farm = die
        try:
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                provision._provision(self._args("beta", ["bar"]))
        finally:
            provision.build_farm = original

        orphans = list(provision.STORE.glob("bar-2.0-*"))
        self.assertEqual(len(orphans), 1)                     # the pool write happened
        self.assertFalse((provision.FARMS / "beta").exists())  # no farm references it
        self.assertEqual((provision.LIBS / "deps.json").read_text(), graph_before)
        self.assertEqual((provision.FARMS / "alpha" / "packages.txt").read_text(),
                         inventory_before)

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.reclaim(), 0)
        self.assertFalse(orphans[0].exists())                       # reclaim ate it
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)


class PublishFarmTests(StoreTestCase):
    """§4.5 — a farm is published by an atomic swap, so it is never half-built.

    On the host these run the two-step fallback, because RENAME_EXCHANGE is Linux-only;
    the container checks exercise the atomic path.
    """

    def _dir_with(self, path: Path, content: str) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        (path / "meta.json").write_text(content)
        return path

    def test_publish_to_fresh_name(self):
        """A first run has no farm yet, so a single rename publishes the staging."""
        staging = self._dir_with(provision.FARMS / (provision.FARM_STAGING + "an1"), "new\n")
        farm = provision.FARMS / "an1"
        provision.publish_farm(staging, farm)
        self.assertTrue(farm.is_dir())
        self.assertEqual((farm / "meta.json").read_text(), "new\n")
        self.assertFalse(staging.exists())

    def test_swap_replaces_existing_farm(self):
        """A re-run swaps the new farm in and drops the old one, leaving no debris."""
        farm = self._dir_with(provision.FARMS / "an1", "old\n")
        staging = self._dir_with(provision.FARMS / (provision.FARM_STAGING + "an1"), "new\n")
        provision.publish_farm(staging, farm)
        self.assertEqual((farm / "meta.json").read_text(), "new\n")
        self.assertFalse(staging.exists())
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "an1")).exists())


class FarmSwapRecoveryTests(StoreTestCase):
    """§9.5 — repair recovers an interrupted farm swap and clears its debris.

    The reachable farm is always the old complete farm or the new complete farm, so a
    crash never leaves a farm with links and no records for the harness to mount.
    """

    def _dir_with(self, path: Path, content: str) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        (path / "meta.json").write_text(content)
        return path

    def test_repair_restores_farm_after_interrupted_swap(self):
        """The two-step fallback died between the renames: the farm is missing, the old
        farm is at the superseded name, the new farm at the staging name. Repair
        restores the old complete farm — the run did not finish — and clears the rest."""
        self._dir_with(provision.FARMS / (provision.FARM_SUPERSEDED + "demo"), "old\n")
        self._dir_with(provision.FARMS / (provision.FARM_STAGING + "demo"), "new\n")
        self.assertFalse((provision.FARMS / "demo").exists())

        self.assertEqual(provision.repair_staging(), 0)

        farm = provision.FARMS / "demo"
        self.assertTrue(farm.is_dir())
        self.assertEqual((farm / "meta.json").read_text(), "old\n")
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "demo")).exists())
        self.assertFalse((provision.FARMS / (provision.FARM_STAGING + "demo")).exists())

    def test_repair_drops_superseded_and_staging_debris(self):
        """The swap completed — the farm is the new one — but the process died before
        it removed the old farm and the staging copy. Both are debris; the farm stays."""
        self._dir_with(provision.FARMS / "demo", "new\n")
        self._dir_with(provision.FARMS / (provision.FARM_SUPERSEDED + "demo"), "old\n")
        self._dir_with(provision.FARMS / (provision.FARM_STAGING + "demo"), "leftover\n")

        self.assertEqual(provision.repair_staging(), 0)

        farm = provision.FARMS / "demo"
        self.assertEqual((farm / "meta.json").read_text(), "new\n")
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "demo")).exists())
        self.assertFalse((provision.FARMS / (provision.FARM_STAGING + "demo")).exists())


class RLoadCheckTests(StoreTestCase):
    """§6.6 — the R load check loads each farmed package through the farm.

    ``provision.subprocess.run`` is replaced with a local fake per test, so no real R
    runs; the check's structure and its failure path are what the tests assert. The
    base ``tearDown`` restores the original ``subprocess.run``.
    """

    def _stored(self, *packages: tuple[str, bool]) -> dict[str, list[tuple[str, Path]]]:
        """Build a farm with the given R packages; a compiled one gets a libs/ dir."""
        (provision.FARMS / "rf" / "r" / "cran").mkdir(parents=True)
        pkgs = []
        for name, compiled in packages:
            store_dir = provision.STORE / f"{name.lower()}-1.0-000000000000000a"
            (store_dir / name).mkdir(parents=True)
            if compiled:
                (store_dir / name / "libs").mkdir()
            pkgs.append((name, store_dir))
        return {"cran": pkgs, "bioconductor": [], "github": []}

    def test_load_check_runs_library_per_package_and_compiled_probe(self):
        """One R invocation per farmed package names that package with library(); only
        a package with compiled code reads its registered routines."""
        stored = self._stored(("pkgA", False), ("pkgB", True))

        calls: list[list[str]] = []

        def fake(cmd, *a, **k):
            calls.append(list(cmd))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        provision.subprocess.run = fake
        with contextlib.redirect_stdout(io.StringIO()):
            provision.check_r_loads(provision.FARMS / "rf", stored)   # no raise

        self.assertEqual(len(calls), 2)
        self.assertTrue(all(c[0] == "Rscript" for c in calls))
        self.assertIn("library('pkgA'", calls[0][-1])
        self.assertIn("library('pkgB'", calls[1][-1])
        # The pure-R package does not touch compiled code; the compiled one does.
        self.assertNotIn("getDLLRegisteredRoutines", calls[0][-1])
        self.assertIn("getDLLRegisteredRoutines", calls[1][-1])

    def test_load_check_names_the_package_that_fails(self):
        """A package that does not load names itself and stops the run."""
        stored = self._stored(("pkgA", False))

        def fake(cmd, *a, **k):
            return SimpleNamespace(
                returncode=1, stdout="",
                stderr="Error: package or namespace load failed for 'pkgA'")

        provision.subprocess.run = fake
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            provision.check_r_loads(provision.FARMS / "rf", stored)
        self.assertIn("pkgA", str(cm.exception))
        self.assertIn("does not load", str(cm.exception))

    def test_load_check_skips_when_no_r_package(self):
        """A farm with no R package runs no R at all."""
        def fake(cmd, *a, **k):
            raise AssertionError("check_r_loads must not run R with no R package")

        provision.subprocess.run = fake
        provision.check_r_loads(provision.FARMS / "rf",
                                {"cran": [], "bioconductor": [], "github": []})


class MarkerTests(unittest.TestCase):
    """§6.1 — the marker of a requirement decides the edge.

    `packaging` reads a marker, thus these tests pin the USE of it and never
    packaging itself: the environment that the emitter builds, the empty `extra`,
    and the two failures that KEEP an edge rather than drop it.
    """

    def setUp(self):
        self.env = dict(emit_deps.marker_environment(),
                        sys_platform="linux", platform_machine="x86_64",
                        python_version="3.12", python_full_version="3.12.4",
                        os_name="posix")

    def edge(self, requirement: str):
        return emit_deps.edge_name(requirement, self.env)

    def test_the_environment_names_each_variable_of_pep_508(self):
        """A variable that the environment does not carry makes packaging raise, thus
        the edge would survive for the wrong reason and the gate would report it."""
        env = emit_deps.marker_environment()
        for key in ("os_name", "sys_platform", "platform_machine", "platform_release",
                    "platform_system", "platform_version", "python_version",
                    "python_full_version", "implementation_name", "implementation_version",
                    "platform_python_implementation", "extra"):
            self.assertIn(key, env)

    def test_no_extra_is_active(self):
        """§6.1: the emitter records the mandatory closure, thus `extra` is empty."""
        self.assertEqual(emit_deps.marker_environment()["extra"], "")
        self.assertIsNone(self.edge('pytest; extra == "test"'))

    def test_a_false_marker_drops_the_edge_and_a_true_marker_keeps_it(self):
        self.assertIsNone(self.edge('colorama; sys_platform == "win32"'))
        self.assertEqual(self.edge('numpy>=1.23; python_version >= "3.9"'), "numpy")
        self.assertEqual(self.edge("typing-extensions"), "typing-extensions")

    def test_a_version_compares_by_its_numbers_and_not_by_its_text(self):
        # A text comparison puts "3.10" before "3.9".
        self.assertEqual(self.edge('numpy; python_version > "3.9"'), "numpy")
        self.assertIsNone(self.edge('numpy; python_version < "3.9"'))

    def test_a_marker_that_does_not_parse_keeps_the_edge(self):
        """A dropped edge would leave the closure short with no report. A kept edge
        that names no node stops the build and names the edge."""
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            name = self.edge('mystery; no_such_variable == "1"')
        self.assertEqual(name, "mystery")
        self.assertIn("WARNING", buf.getvalue())

    def test_a_version_that_does_not_read_keeps_the_edge(self):
        """`platform_release` carries a kernel release such as `7.0.9-205.fc44.aarch64`,
        which is no version of PEP 440. packaging 24.0, which the image carries,
        raises InvalidVersion for a comparison against it, and packaging 26.0 gives
        False instead. Thus the raise is forced here: the test pins the handler of the
        emitter, and it does not pin the behavior of one version of packaging."""

        class Raising:
            def __init__(self, _text): pass
            def evaluate(self, _env): raise emit_deps.InvalidVersion("Invalid version: '7.0.9-205.fc44.aarch64'")

        with unittest.mock.patch.object(emit_deps, "Marker", Raising):
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                name = emit_deps.edge_name('oldpkg; platform_release > "5.0"', self.env)
        self.assertEqual(name, "oldpkg")
        self.assertIn("WARNING", buf.getvalue())


class DependencyGraphTests(StoreTestCase):
    """§6 — deps.json: the node schema, the dropped edges, the gate, and the append."""

    def _python_store_dir(self, name: str, version: str, requires: list[str],
                          scripts: list[str] | None = None) -> Path:
        """A store directory of one Python distribution, as uv leaves it."""
        store_dir = provision.STORE / f"{provision.canon(name)}-{version}-0000000000000000"
        (store_dir / name).mkdir(parents=True)
        (store_dir / name / "__init__.py").write_text("x = 1\n")
        info = store_dir / f"{name}-{version}.dist-info"
        info.mkdir()
        metadata = [f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"]
        metadata += [f"Requires-Dist: {req}\n" for req in requires]
        (info / "METADATA").write_text("".join(metadata))
        if scripts:
            (info / "entry_points.txt").write_text(
                "[console_scripts]\n" + "".join(f"{s} = {name}:main\n" for s in scripts))
        return store_dir

    def _r_store_dir(self, name: str, version: str) -> Path:
        """A store directory of one R package, which nests the package one level down."""
        store_dir = provision.STORE / f"{name.lower()}-{version}-0000000000000000"
        inner = store_dir / name
        (inner / "R").mkdir(parents=True)
        (inner / "DESCRIPTION").write_text(f"Package: {name}\nVersion: {version}\n")
        return store_dir

    def _farm_of(self, farm_name: str, store_dirs: list[Path]) -> Path:
        farm = provision.FARMS / farm_name
        provision.build_farm(farm, store_dirs)
        return farm

    def test_a_python_node_carries_the_track_imports_entry_points_and_edges(self):
        """§6.1: the node schema, keyed by the store-directory name."""
        beta = self._python_store_dir("beta", "2.0", [])
        alpha = self._python_store_dir("alpha", "1.0", ["beta>=1.0"], scripts=["alpha-cli"])
        farm = self._farm_of("an1", [alpha, beta])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_for_farm(provision.LIBS, farm)

        self.assertEqual(graph["version"], emit_deps.GRAPH_VERSION)
        node = graph["nodes"][alpha.name]
        self.assertEqual(node["track"], "python")
        self.assertEqual(node["imports"], ["alpha"])
        self.assertEqual(node["entry_points"], ["alpha-cli"])
        # The edge names the node exactly, and it carries no version range.
        self.assertEqual(node["edges"], [beta.name])
        self.assertEqual(graph["nodes"][beta.name]["edges"], [])
        # The graph is at the store root.
        self.assertTrue((provision.LIBS / "deps.json").is_file())

    def test_an_edge_into_an_image_owned_package_drops(self):
        """§6.3: the fixed list beside the emitter names what the image owns."""
        self.assertIn("setuptools", emit_deps.load_base_packages()["python"])
        alpha = self._python_store_dir("alpha", "1.0", ["setuptools", "pip>=23"])
        farm = self._farm_of("an1", [alpha])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_for_farm(provision.LIBS, farm)
        self.assertEqual(graph["nodes"][alpha.name]["edges"], [])

    def test_a_dangling_edge_fails_the_build_and_names_the_edge(self):
        """§6.5: an edge that names no node stops the build, and the failure carries
        the edge."""
        alpha = self._python_store_dir("alpha", "1.0", ["nowhere"])
        farm = self._farm_of("an1", [alpha])

        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            emit_deps.append_for_farm(provision.LIBS, farm)
        self.assertIn(f"{alpha.name} -> nowhere", str(cm.exception))
        # The refusal writes no graph.
        self.assertFalse((provision.LIBS / "deps.json").exists())

    def test_an_r_node_carries_its_inner_directory_and_its_dcf_edges(self):
        """§6.2: the R edges come from Depends and Imports, which one Rscript call
        reads with read.dcf."""
        rcpp = self._r_store_dir("Rcpp", "1.0.13")
        pkg = self._r_store_dir("myRpkg", "1.2.3")
        farm = provision.FARMS / "an1"
        provision.build_r_farm(farm, {"cran": [("Rcpp", rcpp), ("myRpkg", pkg)],
                                      "bioconductor": [], "github": []})

        seen: list[list[str]] = []

        def fake(cmd, *args, **kwargs):
            argv = list(cmd)
            seen.append(argv)
            self.assertEqual(argv[0], "Rscript")
            self.assertIn("read.dcf", argv[-1])
            fields = {str(pkg / "myRpkg"): "R (>= 4.0), stats, Rcpp (>= 1.0.0), MASS",
                      str(rcpp / "Rcpp"): "methods, utils"}
            lines = "".join(f"{path}\t{value}\n"
                            for path, value in fields.items()
                            if path in kwargs["input"].splitlines())
            return SimpleNamespace(returncode=0, stdout=lines, stderr="")

        provision.subprocess.run = fake
        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_for_farm(provision.LIBS, farm)

        self.assertEqual(len(seen), 1)                 # one call for the whole closure
        node = graph["nodes"][pkg.name]
        self.assertEqual(node["track"], "r")
        self.assertEqual(node["r_dir"], "myRpkg")
        self.assertEqual(node["imports"], ["myRpkg"])
        self.assertEqual(node["entry_points"], [])
        # R, stats, and MASS belong to the image; only the store package stays.
        self.assertEqual(node["edges"], [rcpp.name])

    def test_a_linkingto_package_gives_no_edge(self):
        """§6.2: LinkingTo is a build-time field. It names the headers of a source
        build, and R never loads such a package at run time. pak omits it from a
        binary install, thus the pool holds no node for it and an edge to it would
        always dangle."""
        # The field list of the Rscript expression is the whole of the exclusion.
        self.assertIn('c("Depends", "Imports")', emit_deps.R_READ_DCF)
        self.assertNotIn("LinkingTo", emit_deps.R_READ_DCF)

        rcpp = self._r_store_dir("Rcpp", "1.0.13")
        pkg = self._r_store_dir("myRpkg", "1.2.3")
        # StanHeaders is a LinkingTo name only, and no store directory holds it.
        (pkg / "myRpkg" / "DESCRIPTION").write_text(
            "Package: myRpkg\nVersion: 1.2.3\n"
            "Imports: Rcpp (>= 1.0.0)\n"
            "LinkingTo: Rcpp, StanHeaders\n")
        farm = provision.FARMS / "an1"
        provision.build_r_farm(farm, {"cran": [("Rcpp", rcpp), ("myRpkg", pkg)],
                                      "bioconductor": [], "github": []})

        def fake(cmd, *args, **kwargs):
            """Read each DESCRIPTION, and give back the requested fields only.

            This stands in for read.dcf. It honors the field list of the caller,
            thus a request for LinkingTo would put StanHeaders into the answer.
            """
            head = list(cmd)[-1].split(";", 1)[0]
            wanted = [part for i, part in enumerate(head.split('"')) if i % 2 == 1]
            lines = []
            for path in kwargs["input"].splitlines():
                text = (Path(path) / "DESCRIPTION").read_text()
                values = [line.split(":", 1)[1].strip()
                          for line in text.splitlines()
                          if line.split(":", 1)[0] in wanted]
                lines.append("{}\t{}\n".format(path, ",".join(values)))
            return SimpleNamespace(returncode=0, stdout="".join(lines), stderr="")

        provision.subprocess.run = fake
        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_for_farm(provision.LIBS, farm)

        # Rcpp is an Imports name, thus its edge stays. StanHeaders is a LinkingTo
        # name, thus no edge names it and the gate passes.
        self.assertEqual(graph["nodes"][pkg.name]["edges"], [rcpp.name])

    def test_the_standalone_emitter_covers_every_farm(self):
        """§6.4: the emitter runs standalone, and it reads every farm of the store."""
        alpha = self._python_store_dir("alpha", "1.0", [])
        beta = self._python_store_dir("beta", "2.0", [])
        self._farm_of("an1", [alpha])
        self._farm_of("an2", [beta])
        # A staging farm from an interrupted swap is not a farm.
        (provision.FARMS / (provision.FARM_STAGING + "an3")).mkdir()

        argv = sys.argv
        sys.argv = ["emit_deps.py", "--store-root", str(provision.LIBS)]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(emit_deps.main(), 0)
        finally:
            sys.argv = argv

        nodes = json.loads((provision.LIBS / "deps.json").read_text())["nodes"]
        self.assertEqual(sorted(nodes), sorted([alpha.name, beta.name]))

    def test_an_append_keeps_every_earlier_node_byte_identical(self):
        """§6.6: an acquisition run adds its nodes, and each earlier node stays as
        it is, byte for byte."""
        compile_text = "foo==1.0 \\\n    --hash=sha256:aaa\n"
        self.compile_text = compile_text
        self.install_tree = {
            "foo/__init__.py": "x = 1\n",
            "foo-1.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: foo\nVersion: 1.0\n",
        }
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision._provision(self._args("alpha", ["foo"])), 0)

        graph_path = provision.LIBS / "deps.json"
        before_text = graph_path.read_text()
        before = json.loads(before_text)["nodes"]
        self.assertEqual(len(before), 1)

        # A second acquisition run adds a distribution that depends on the first.
        self.compile_text = "bar==2.0 \\\n    --hash=sha256:bbb\n" + compile_text
        self.install_tree = {
            "bar/__init__.py": "y = 2\n",
            "bar-2.0.dist-info/METADATA":
                "Metadata-Version: 2.1\nName: bar\nVersion: 2.0\nRequires-Dist: foo\n",
        }
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision._provision(self._args("beta", ["bar"])), 0)

        after_text = graph_path.read_text()
        after = json.loads(after_text)["nodes"]
        self.assertEqual(len(after), 2)
        for key, node in before.items():
            self.assertEqual(after[key], node)
            # The block of the earlier node is the same text, not merely the same
            # value: an append rewrites the file, thus the bytes are the assertion.
            self.assertIn(self._node_block(before_text, key), after_text)
        # The new node names the earlier one exactly.
        added = [key for key in after if key not in before]
        self.assertEqual(after[added[0]]["edges"], list(before))

    @staticmethod
    def _node_block(text: str, key: str) -> str:
        """The text of one node of deps.json, from its key to its closing brace."""
        start = text.index(f'"{key}": {{')
        depth = 0
        for at in range(start, len(text)):
            if text[at] == "{":
                depth += 1
            elif text[at] == "}":
                depth -= 1
                if depth == 0:
                    return text[start:at + 1]
        raise AssertionError(f"the node {key} has no closing brace")


if __name__ == "__main__":
    unittest.main()
