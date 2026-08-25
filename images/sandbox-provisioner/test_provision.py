#!/usr/bin/env python3
"""Unit tests for the store-side logic of ``provision.py``.

These cover the host-verifiable slice of the rebuilt provisioner. Each test
drives the real Python logic of ``provision.py``; every external tool the
code shells out to (``uv``, ``chmod``, ``Rscript``) is monkeypatched at
``provision.subprocess.run``, so the suite runs with only the standard
library — no ``uv``, no ``docker``, no third-party packages, no yaml (the
manifest parse is monkeypatched where a command needs one).

``ImageOwnedPackageTests`` is the one exception. It reads the installed set
of the sandbox image, thus it starts one container. It skips when the host
cannot reach the image.

The container-level paths — a real acquire against the index, the both-hit
probe through pak, reclaim against a real volume — live in
``scripts/package-store-check-provisioner.sh``, which drives the built image.

Run with either::

    python3 -m unittest -v images/sandbox-provisioner/test_provision.py
    cd images/sandbox-provisioner && python3 -m unittest -v test_provision
    python3 images/sandbox-provisioner/test_provision.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

# provision.py computes LIBS/STORE/FARMS/FARM_BIND/SANDBOX_MOUNT at IMPORT TIME
# from LIB_ROOT, so a temp root must exist before the import; every test then
# reassigns those module globals to its own hermetic temp store (see
# StoreTestCase.setUp), so no test ever writes to this import-time root.
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
    external tool (uv / chmod / Rscript) is ever invoked. LIBS is kept EQUAL
    to SANDBOX_MOUNT so the mount-path guard of the farm build passes.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="prov-test-"))
        provision.LIBS = self.root
        provision.STORE = self.root / "store"
        provision.FARMS = self.root / "farms"
        provision.FARM_BIND = self.root / "farm"
        provision.SANDBOX_MOUNT = self.root
        provision.RUN_TOKEN = ""
        provision.STORE.mkdir(parents=True, exist_ok=True)
        provision.FARMS.mkdir(parents=True, exist_ok=True)

        # Canned outputs the fake subprocess.run produces for the tool it
        # stands in for; a test overrides these before exercising the path.
        self.compile_text = ""
        # Per-requirement canned resolve output: the fake reads the
        # requirements.in content and takes the matching entry, thus one test
        # can give two specs two different resolves. The plain
        # ``compile_text`` serves when no entry matches.
        self.compile_by_input: dict[str, str] = {}
        # Per-requirement failure: the entry holds the stderr of the refusal.
        self.compile_failures: dict[str, str] = {}
        self.install_tree: dict[str, str] = {}
        self.uv_rc = 0
        self.uv_stderr = ""
        # One entry per warm child: the PYTHONPATH it was given, and that path
        # resolved AT THAT MOMENT — what proves the bind resolved for the child.
        self.warm_paths: list[tuple[str, str]] = []
        # Script path -> the stderr of a warm child that fails.
        self.warm_failures: dict[str, str] = {}
        # Script path -> the cache events of that child, as (event, path)
        # pairs, reported only when NUMBA_DEBUG_CACHE is set.
        self.cache_events: dict[str, list[tuple[str, str]]] = {}
        # The argv of every external tool the run shelled out to.
        self.calls: list[list[str]] = []

        self._orig_run = provision.subprocess.run
        provision.subprocess.run = self._fake_run

    def tearDown(self):
        provision.subprocess.run = self._orig_run
        shutil.rmtree(self.root, ignore_errors=True)

    # -- monkeypatch + helpers ------------------------------------------------
    def _fake_run(self, cmd, *args, **kwargs):
        """Stand in for the external tools provision.py shells out to."""
        argv = list(cmd)
        self.calls.append(argv)
        prog = argv[0]
        if prog == "chmod":
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == "uv" and "compile" in argv:
            req_text = Path(argv[-3]).read_text().strip()
            if req_text in self.compile_failures:
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr=self.compile_failures[req_text])
            if self.uv_rc:
                return SimpleNamespace(returncode=self.uv_rc, stdout="", stderr=self.uv_stderr)
            text = self.compile_by_input.get(req_text, self.compile_text)
            Path(argv[argv.index("-o") + 1]).write_text(text)
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == "uv" and "install" in argv:
            if self.uv_rc:
                return SimpleNamespace(returncode=self.uv_rc, stdout="", stderr=self.uv_stderr)
            self._write_tree(Path(argv[argv.index("--target") + 1]), self.install_tree)
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if prog == provision.PYTHON:
            if argv[1:2] == ["-c"] and "platform" in argv[2]:
                return SimpleNamespace(returncode=0, stdout="3.12.0\n", stderr="")
            ppath = (kwargs.get("env") or {}).get("PYTHONPATH", "")
            self.warm_paths.append((ppath, os.path.realpath(ppath)))
            target = argv[-1]
            if target in self.warm_failures:
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr=self.warm_failures[target])
            events = self.cache_events.get(target, []) \
                if (kwargs.get("env") or {}).get("NUMBA_DEBUG_CACHE") else []
            out = "".join(f"[cache] data {event} '{path}'\n" for event, path in events)
            return SimpleNamespace(returncode=0, stdout=out, stderr="")
        raise AssertionError(f"test triggered an unexpected subprocess: {argv!r}")

    @staticmethod
    def _write_tree(root: Path, tree: dict[str, str]) -> None:
        root.mkdir(parents=True, exist_ok=True)
        for rel, content in tree.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

    @staticmethod
    def _make_r_pkg(where: Path, name: str, version: str) -> Path:
        where.mkdir(parents=True, exist_ok=True)
        (where / "DESCRIPTION").write_text(f"Package: {name}\nVersion: {version}\nTitle: t\n")
        (where / "R").mkdir(exist_ok=True)
        (where / "R" / "code.R").write_text("f <- function() 1L\n")
        return where


FOO_1 = "foo==1.0 \\\n    --hash=sha256:aaa\n"
FOO_1_TREE = {"foo/__init__.py": "x = 1\n",
              "foo-1.0.dist-info/RECORD": "foo/__init__.py,,\n"}
BAR_2 = "bar==2.0 \\\n    --hash=sha256:bbb\n"
BAR_2_TREE = {"bar/__init__.py": "y = 2\n",
              "bar-2.0.dist-info/RECORD": "bar/__init__.py,,\n"}


class ContentAddressingTests(StoreTestCase):
    """Content addressing, reuse by pin marker, the full-hash marker, and the
    hashless refusal."""

    def test_ensure_stored_content_address_and_reuse(self):
        self.install_tree = dict(FOO_1_TREE)
        path, is_new = provision.ensure_stored("foo==1.0", ["sha256:abc"])
        self.assertTrue(is_new)
        self.assertEqual(path.parent, provision.STORE)
        self.assertRegex(path.name, r"^foo-1\.0-[0-9a-f]{16}$")
        marker = path / provision.PIN_MARKER
        self.assertTrue(marker.is_file())
        self.assertEqual(marker.read_text().strip(), "foo==1.0")
        # The full-hash marker rides beside the pin: the farm lock carries the
        # full sha256 of each package, and this marker saves a pool re-hash.
        recorded = (path / provision.HASH_MARKER).read_text().strip()
        self.assertEqual(recorded, provision.tree_hash(path))
        self.assertEqual(recorded[:16], path.name.rsplit("-", 1)[-1])
        self.assertEqual(provision.stored_full_hash(path), recorded)

        # Second store of the same pin reuses (found via the PIN_MARKER).
        path2, is_new2 = provision.ensure_stored("foo==1.0", ["sha256:abc"])
        self.assertEqual(path2, path)
        self.assertFalse(is_new2)

        # A pin that reached here without a source hash is refused.
        before = set(provision.STORE.iterdir())
        with self.assertRaises(SystemExit) as cm:
            provision.ensure_stored("bar==2.0", [])
        self.assertIn("without a source hash", str(cm.exception))
        self.assertEqual(set(provision.STORE.iterdir()), before)

    def test_store_r_package_content_address_and_reuse(self):
        staging = provision.STORE / ".staging-r" / "cran"
        pkg1 = self._make_r_pkg(staging / "myRpkg", "myRpkg", "1.2.3")
        final, is_new = provision.store_r_package(pkg1)
        self.assertTrue(is_new)
        self.assertEqual(final.parent, provision.STORE)
        self.assertRegex(final.name, r"^myrpkg-1\.2\.3-[0-9a-f]{16}$")
        # The package nests inside the store directory under its real name,
        # thus a package that rebuilds its path as libname/packagename
        # resolves itself.
        self.assertTrue((final / "myRpkg" / "DESCRIPTION").is_file())
        self.assertEqual((final / "myRpkg" / provision.PIN_MARKER).read_text().strip(),
                         "myRpkg==1.2.3")
        self.assertFalse(pkg1.exists())  # published out of staging by rename
        # The full hash reads from the nested marker too.
        self.assertEqual(provision.stored_full_hash(final),
                         (final / "myRpkg" / provision.HASH_MARKER).read_text().strip())

        pkg2 = self._make_r_pkg(staging / "myRpkg-again", "myRpkg", "1.2.3")
        final2, is_new2 = provision.store_r_package(pkg2)
        self.assertEqual(final2, final)
        self.assertFalse(is_new2)

    def test_store_r_package_records_linking_to(self):
        """LinkingTo records as build metadata beside the pin, with the bare
        names only. The marker never joins the content address."""
        staging = provision.STORE / ".staging-r" / "cran"
        staging.mkdir(parents=True)
        pkg = staging / "cpkg"
        (pkg / "R").mkdir(parents=True)
        (pkg / "R" / "code.R").write_text("f <- function() 1L\n")
        (pkg / "DESCRIPTION").write_text(
            "Package: cpkg\nVersion: 1.0\nTitle: t\n"
            "LinkingTo: Rcpp (>= 1.0.0), RcppArmadillo,\n    BH\n"
            "Imports: methods\n")

        final, is_new = provision.store_r_package(pkg)
        self.assertTrue(is_new)
        record = json.loads((final / "cpkg" / provision.R_LINKING_MARKER).read_text())
        self.assertEqual(record, ["Rcpp", "RcppArmadillo", "BH"])
        # The markers stay out of the address: the recorded hash equals a
        # fresh hash of the published tree.
        self.assertEqual(provision.tree_hash(final),
                         (final / "cpkg" / provision.HASH_MARKER).read_text().strip())

        plain = self._make_r_pkg(staging / "plainpkg", "plainpkg", "2.0")
        final_plain, _ = provision.store_r_package(plain)
        self.assertEqual(json.loads(
            (final_plain / "plainpkg" / provision.R_LINKING_MARKER).read_text()), [])


class RepairTests(StoreTestCase):
    """The staging repair clears abandoned trees, and it is idempotent."""

    def test_repair_clears_staging_and_is_idempotent(self):
        (provision.STORE / ".staging" / "foo").mkdir(parents=True)
        (provision.STORE / ".staging" / "foo" / "junk").write_text("partial install\n")
        (provision.STORE / ".staging-r" / "cran" / "bar").mkdir(parents=True)

        with contextlib.redirect_stdout(io.StringIO()):
            provision.repair_staging()
        self.assertFalse((provision.STORE / ".staging").exists())
        self.assertFalse((provision.STORE / ".staging-r").exists())
        self.assertTrue(provision.STORE.exists())

        provision.repair_staging()  # idempotent


class StoreLockTests(StoreTestCase):
    """One lock file, two modes, and the automatic repair at the way in.

    Two open file descriptions on the same lock file conflict under flock
    even within one process, which models two concurrent runs.
    """

    def test_two_acquisition_runs_share_the_lock(self):
        with provision.store_lock(shared=True):
            with provision.store_lock(shared=True):
                pass

    def test_reclaim_refuses_under_an_acquisition_run(self):
        with provision.store_lock(shared=True):
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
                with provision.store_lock(shared=False, wait=False):
                    pass
            self.assertIn("acquisition run holds the store lock", str(cm.exception))

        # Released now: the exclusive mode takes the lock cleanly.
        with provision.store_lock(shared=False, wait=False):
            pass

    def test_an_acquisition_run_refuses_under_reclaim(self):
        with provision.store_lock(shared=False, wait=False):
            with self.assertRaises(SystemExit) as cm:
                with provision.store_lock(shared=True):
                    pass
            self.assertIn("reclaim holds the store lock", str(cm.exception))

    def test_the_commit_mutex_is_a_second_lock_file(self):
        with provision.store_lock(shared=True), provision.commit_lock():
            self.assertTrue((provision.LIBS / ".commit.lock").is_file())
            self.assertTrue((provision.LIBS / ".provision.lock").is_file())

    def test_the_lone_holder_repairs_staging_debris_on_the_way_in(self):
        """The repair runs when the run is the only holder: every staging tree
        present is then debris of a crashed run, never the work of a live one."""
        (provision.STORE / ".staging-dead" / "junk").mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            with provision.store_lock(shared=True):
                self.assertFalse((provision.STORE / ".staging-dead").exists())

    def test_a_second_holder_does_not_repair(self):
        """With another run in flight, the exclusive probe fails, thus the
        debris stays for the next run that enters alone. A live run's staging
        is never deleted from under it."""
        with contextlib.redirect_stdout(io.StringIO()):
            with provision.store_lock(shared=True):
                (provision.STORE / ".staging-live" / "work").mkdir(parents=True)
                with provision.store_lock(shared=True):
                    self.assertTrue((provision.STORE / ".staging-live").exists())


class ReclaimTests(StoreTestCase):
    """Reclaim removes the unreferenced directories, and the graph obeys."""

    def test_reclaim_prunes_the_graph_nodes_of_gone_directories(self):
        keep, drop, ghost = "keep-1.0-aaaa", "drop-2.0-bbbb", "ghost-3.0-cccc"
        (provision.STORE / keep).mkdir()
        (provision.STORE / drop).mkdir()
        farm = provision.FARMS / "f1"
        farm.mkdir(parents=True)
        os.symlink(f"{provision.LIBS}/store/{keep}/keep", farm / "keep-link")
        # `ghost` has a node and no directory: the pre-dangling shape this
        # sweep heals, because it keys on the disk and not on the removals.
        graph = {
            "version": 1,
            "nodes": {
                keep: {"name": "keep", "version": "1.0", "track": "python", "order": "0001", "imports": [], "entry_points": [], "edges": [], "r_dir": None},
                drop: {"name": "drop", "version": "2.0", "track": "python", "order": "0002", "imports": [], "entry_points": [], "edges": [], "r_dir": None},
                ghost: {"name": "ghost", "version": "3.0", "track": "python", "order": "0003", "imports": [], "entry_points": [], "edges": [], "r_dir": None},
            },
            "by_name": {"python": {"keep": [keep], "drop": [drop], "ghost": [ghost]}},
        }
        (provision.LIBS / "deps.json").write_text(json.dumps(graph))

        with contextlib.redirect_stdout(io.StringIO()):
            provision.cmd_reclaim(None)

        self.assertTrue((provision.STORE / keep).is_dir())
        self.assertFalse((provision.STORE / drop).exists())
        after = json.loads((provision.LIBS / "deps.json").read_text())
        self.assertEqual(sorted(after["nodes"]), [keep])
        self.assertEqual(after["by_name"]["python"], {"keep": [keep]})

    def test_reclaim_with_a_clean_graph_rewrites_nothing(self):
        keep = "keep-1.0-aaaa"
        (provision.STORE / keep).mkdir()
        farm = provision.FARMS / "f1"
        farm.mkdir(parents=True)
        os.symlink(f"{provision.LIBS}/store/{keep}/keep", farm / "keep-link")
        graph = {"version": 1, "nodes": {keep: {"name": "keep"}}, "by_name": {"python": {"keep": [keep]}}}
        path = provision.LIBS / "deps.json"
        path.write_text(json.dumps(graph))
        before = path.stat().st_mtime_ns

        with contextlib.redirect_stdout(io.StringIO()):
            provision.cmd_reclaim(None)

        self.assertEqual(path.stat().st_mtime_ns, before)


class FarmAssemblyTests(StoreTestCase):
    """The farm assembly invariants for the Python and R tracks."""

    def test_build_python_track_invariants(self):
        store_dir = provision.STORE / "demo-1.0-000000000000000f"
        (store_dir / "demo").mkdir(parents=True)
        (store_dir / "demo" / "__init__.py").write_text("VERSION = '1.0'\n")
        (store_dir / "demo-1.0.dist-info").mkdir()
        (store_dir / "demo-1.0.dist-info" / "METADATA").write_text("Name: demo\n")

        farm = provision.FARMS / "an1"
        with contextlib.redirect_stdout(io.StringIO()):
            conflicts = provision.build_python_track(farm, [store_dir])
        self.assertEqual(conflicts, [])

        site = farm / "python" / "site-packages"
        link = site / "demo"
        self.assertTrue(link.is_symlink())
        target = os.readlink(link)
        self.assertTrue(os.path.isabs(target))
        self.assertIn("/store/", target)
        self.assertTrue((site / "demo-1.0.dist-info").is_symlink())

        # conda, r/ and node/ are NOT created: the image owns those tracks,
        # and an empty r/ would advertise an empty track.
        self.assertFalse((farm / "conda").exists())
        self.assertFalse((farm / "r").exists())
        self.assertFalse((farm / "node").exists())
        self.assertFalse((farm / "python" / "bin").exists())

        # Mount-path guard: a store rooted elsewhere would bake a path the
        # sandbox cannot resolve.
        saved = provision.SANDBOX_MOUNT
        provision.SANDBOX_MOUNT = self.root / "elsewhere"
        try:
            with self.assertRaises(SystemExit) as cm:
                provision.build_python_track(provision.FARMS / "an2", [store_dir])
            self.assertIn("refusing to build a farm", str(cm.exception))
        finally:
            provision.SANDBOX_MOUNT = saved

    def _pkg(self, store_dir_name, module, extra_top=None):
        d = provision.STORE / store_dir_name
        (d / module).mkdir(parents=True)
        (d / module / "__init__.py").write_text(f"# {module}\n")
        if extra_top is not None:
            (d / extra_top).mkdir(parents=True)
            (d / extra_top / "__init__.py").write_text("# a shared top-level package\n")
            (d / extra_top / f"{module}_case.py").write_text("# case\n")
        return d

    def test_two_distributions_that_share_a_top_level_package_merge(self):
        a = self._pkg("spectrum-like-0.5.0-00000000000ab001", "speclike", extra_top="tests")
        b = self._pkg("airr-like-2.0.0-00000000000ab002", "airrlike", extra_top="tests")

        farm = provision.FARMS / "an-merge"
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(farm, [a, b])

        site = farm / "python" / "site-packages"
        self.assertTrue((site / "tests").is_dir())
        self.assertFalse((site / "tests").is_symlink())
        self.assertTrue((site / "tests" / "speclike_case.py").is_symlink())
        self.assertTrue((site / "tests" / "airrlike_case.py").is_symlink())

    def test_two_versions_of_one_distribution_refuse(self):
        a = self._pkg("demo-1.0-00000000000ab010", "demo")
        b = self._pkg("demo-2.0-00000000000ab011", "demo")

        with self.assertRaises(SystemExit) as cm:
            provision.build_python_track(provision.FARMS / "an-collide", [a, b])
        self.assertIn("two versions of demo", str(cm.exception))

    def test_a_merge_conflict_records_as_a_structured_entry(self):
        """A kept-first collision enters the record as {entry, action}, which
        is the shape the `merge_conflicts` field of the farm lock carries."""
        a = self._pkg("alpha-1.0-00000000000ab030", "alpha")
        (a / "shared.txt").write_text("alpha's file\n")
        b = self._pkg("beta-1.0-00000000000ab031", "beta")
        (b / "shared.txt").write_text("beta's file\n")

        with contextlib.redirect_stdout(io.StringIO()):
            conflicts = provision.build_python_track(provision.FARMS / "an-kept", [a, b])
        self.assertEqual(conflicts, [{"entry": "shared.txt", "action": "kept-first"}])

    def test_a_farm_under_a_hyphenated_root_still_merges(self):
        a = self._pkg("alpha-1.0-00000000000ab020", "alpha", extra_top="tests")
        b = self._pkg("beta-1.0-00000000000ab021", "beta", extra_top="tests")

        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(provision.FARMS / "an-hyphen", [a, b])
        self.assertTrue((provision.FARMS / "an-hyphen" / "python" / "site-packages" / "tests").is_dir())

    def test_build_r_track_skips_empty_subtree(self):
        ra = provision.STORE / "rpkga-1.0-000000000000aaaa"
        rb = provision.STORE / "rpkgb-2.0-000000000000bbbb"
        ra.mkdir()
        rb.mkdir()

        farm = provision.FARMS / "rf"
        provision.build_r_track(farm, {
            "cran": [("rpkgA", ra)],
            "bioconductor": [("rpkgB", rb)],
            "github": [],
        })
        self.assertTrue((farm / "r" / "cran" / "rpkgA").is_symlink())
        self.assertEqual(os.readlink(farm / "r" / "cran" / "rpkgA"), str(ra / "rpkgA"))
        self.assertTrue((farm / "r" / "bioconductor" / "rpkgB").is_symlink())
        self.assertFalse((farm / "r" / "github").exists())

    def test_published_farm_holds_no_dangling_link(self):
        """A hoisted console script links RELATIVELY, because the farm
        publishes by a rename and an absolute link would keep the staging path
        and dangle after the swap."""
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
            provision.build_python_track(staging, store_dirs)
        farm = provision.FARMS / "an1"
        provision.publish_farm(staging, farm)

        self.assertTrue((farm / "python" / "bin" / "alpha-cli").is_symlink())
        self.assertTrue((farm / "python" / "bin" / "beta-cli").is_symlink())
        self.assertFalse(os.path.isabs(os.readlink(farm / "python" / "bin" / "alpha-cli")))

        dangling = []
        for parent, subdirs, files in os.walk(farm):
            for entry in sorted(subdirs + files):
                path = Path(parent) / entry
                if path.is_symlink() and not path.exists():
                    dangling.append(f"{path} -> {os.readlink(path)}")
        self.assertEqual(dangling, [], "the published farm holds a dangling link")


class PublishFarmTests(StoreTestCase):
    """A farm publishes by an atomic swap, so it is never half-built.

    On the host these run the two-step fallback, because RENAME_EXCHANGE is
    Linux-only; the container checks exercise the atomic path.
    """

    def _dir_with(self, path: Path, content: str) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        (path / "inflexa.lock").write_text(content)
        return path

    def test_publish_to_fresh_name(self):
        staging = self._dir_with(provision.FARMS / (provision.FARM_STAGING + "an1"), "new\n")
        farm = provision.FARMS / "an1"
        provision.publish_farm(staging, farm)
        self.assertTrue(farm.is_dir())
        self.assertEqual((farm / "inflexa.lock").read_text(), "new\n")
        self.assertFalse(staging.exists())

    def test_swap_replaces_existing_farm(self):
        farm = self._dir_with(provision.FARMS / "an1", "old\n")
        staging = self._dir_with(provision.FARMS / (provision.FARM_STAGING + "an1"), "new\n")
        provision.publish_farm(staging, farm)
        self.assertEqual((farm / "inflexa.lock").read_text(), "new\n")
        self.assertFalse(staging.exists())
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "an1")).exists())


class FarmSwapRecoveryTests(StoreTestCase):
    """The repair recovers an interrupted farm swap and clears its debris."""

    def _dir_with(self, path: Path, content: str) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        (path / "inflexa.lock").write_text(content)
        return path

    def test_repair_restores_farm_after_interrupted_swap(self):
        self._dir_with(provision.FARMS / (provision.FARM_SUPERSEDED + "demo"), "old\n")
        self._dir_with(provision.FARMS / (provision.FARM_STAGING + "demo"), "new\n")
        self.assertFalse((provision.FARMS / "demo").exists())

        with contextlib.redirect_stdout(io.StringIO()):
            provision.repair_staging()

        farm = provision.FARMS / "demo"
        self.assertTrue(farm.is_dir())
        self.assertEqual((farm / "inflexa.lock").read_text(), "old\n")
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "demo")).exists())
        self.assertFalse((provision.FARMS / (provision.FARM_STAGING + "demo")).exists())

    def test_repair_drops_superseded_and_staging_debris(self):
        self._dir_with(provision.FARMS / "demo", "new\n")
        self._dir_with(provision.FARMS / (provision.FARM_SUPERSEDED + "demo"), "old\n")
        self._dir_with(provision.FARMS / (provision.FARM_STAGING + "demo"), "leftover\n")

        with contextlib.redirect_stdout(io.StringIO()):
            provision.repair_staging()

        self.assertEqual((provision.FARMS / "demo" / "inflexa.lock").read_text(), "new\n")
        self.assertFalse((provision.FARMS / (provision.FARM_SUPERSEDED + "demo")).exists())
        self.assertFalse((provision.FARMS / (provision.FARM_STAGING + "demo")).exists())


class BiocReleaseTests(StoreTestCase):
    """The Bioconductor releases come from the pak lock, never from a query to
    R. The lock now arrives as a parsed dict, because the build embeds it into
    the farm lock as provenance."""

    @staticmethod
    def _lock(*packages) -> dict:
        return {"lockfile_version": 1, "packages": list(packages)}

    @staticmethod
    def _cran(name: str, version: str) -> dict:
        repo = "https://p3m.dev/cran/__linux__/noble/2026-06-23"
        return {"package": name, "version": version,
                "sources": [f"{repo}/src/contrib/{name}_{version}.tar.gz"],
                "metadata": {"RemoteRepos": repo}}

    @staticmethod
    def _bioc(name: str, version: str, release: str) -> dict:
        repo = f"https://bioconductor.org/packages/{release}/bioc"
        return {"package": name, "version": version,
                "sources": [f"{repo}/src/contrib/{name}_{version}.tar.gz"],
                "metadata": {"RemoteRepos": repo}}

    def test_cran_only_lock_names_no_release(self):
        lock = self._lock(self._cran("jsonlite", "2.0.0"), self._cran("cli", "3.6.5"))
        self.assertEqual(provision.bioc_releases(lock), [])

    def test_one_release_is_deduplicated(self):
        lock = self._lock(self._cran("jsonlite", "2.0.0"),
                          self._bioc("BiocGenerics", "0.58.1", "3.23"),
                          self._bioc("S4Vectors", "0.48.0", "3.23"))
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

    def test_two_releases_are_both_kept_and_sorted_numerically(self):
        lock = self._lock(self._bioc("BiocGenerics", "0.58.1", "3.23"),
                          self._bioc("limma", "3.40.6", "3.9"))
        # Release 3.9 comes before 3.23, but as text it sorts after it.
        self.assertEqual(provision.bioc_releases(lock), ["3.9", "3.23"])

    def test_git_pin_contributes_no_release(self):
        lock = self._lock(
            self._bioc("BiocGenerics", "0.58.1", "3.23"),
            {"package": "DEP", "version": "1.31.0",
             "sources": ["https://git.bioconductor.org/packages/DEP"],
             "metadata": {"RemoteSha": "0f2b1c9e"}})
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])

    def test_damaged_entries_are_skipped(self):
        lock = self._lock(
            {"package": "nosources", "version": "1.0"},
            {"package": "wrongtypes", "version": "1.0", "sources": "a string",
             "metadata": "a string"},
            "a string where an object belongs",
            self._bioc("BiocGenerics", "0.58.1", "3.23"))
        self.assertEqual(provision.bioc_releases(lock), ["3.23"])
        # A lock that is not a dict, and one with no packages list, both give
        # an empty list: provenance that cannot read must not lose packages.
        self.assertEqual(provision.bioc_releases({}), [])
        self.assertEqual(provision.bioc_releases({"packages": "not a list"}), [])


class SpecParsingTests(StoreTestCase):
    """The acquire spec format, the location refusals, and the manifest shapes."""

    def test_parse_spec_forms(self):
        self.assertEqual(provision.parse_spec("python:numpy==1.26.4"),
                         {"raw": "python:numpy==1.26.4", "name": "numpy",
                          "version": "1.26.4", "ecosystem": "python"})
        self.assertEqual(provision.parse_spec("r:limma"),
                         {"raw": "r:limma", "name": "limma", "version": None,
                          "ecosystem": "r"})
        self.assertEqual(provision.parse_spec("igraph")["ecosystem"], None)

    def test_reject_off_index(self):
        # Naming a package is permitted.
        for good in ("numpy", "python:scipy==1.11.4", "r:DESeq2"):
            self.assertIsNone(provision.reject_off_index(provision.parse_spec(good)))
        # Naming a location — URL, local path, or artifact filename — refuses.
        for bad in ("git+https://github.com/x/y", "./dist/pkg", "~/pkg",
                    "pkg-1.0.tar.gz", "pkg-1.0.zip"):
            self.assertIsNotNone(provision.reject_off_index(provision.parse_spec(bad)), bad)
        # A slash names the github or git form, and those tracks are
        # catalog-only.
        reason = provision.reject_off_index(provision.parse_spec("owner/repo"))
        self.assertIn("catalog-only", reason)

    def test_manifest_python_specs_reads_both_entry_forms(self):
        manifest = {"python": {"pip": {
            "common": ["numpy", '"jax<0.10"'.strip('"'),
                       {"name": "scanpy", "reason": "r", "warm": "warm/scanpy.py"}],
            provision.arch(): ["archonly==1.0"],
        }}}
        entries = provision.manifest_python_specs(manifest)
        by_name = {e["name"]: e for e in entries}
        self.assertEqual(by_name["numpy"]["constraint"], "")
        self.assertEqual(by_name["jax"]["constraint"], "<0.10")
        self.assertEqual(by_name["scanpy"]["warm"], "warm/scanpy.py")
        self.assertEqual(by_name["archonly"]["constraint"], "==1.0")


class SupplyChainTests(StoreTestCase):
    """The resolver parses hashes, sorts the pins, and refuses an off-host
    artifact. A failed tool reports its own stderr."""

    def test_resolve_parses_hashes_and_rejects_off_host(self):
        self.compile_text = (
            "# resolved via uv pip compile\n"
            "scipy==1.11.4 \\\n"
            "    --hash=sha256:ccc\n"
            "numpy==1.26.4 \\\n"
            "    --hash=sha256:aaa \\\n"
            "    --hash=sha256:bbb\n"
        )
        with contextlib.redirect_stdout(io.StringIO()):
            result = provision.resolve(["numpy", "scipy"])
        self.assertEqual(result, {
            "numpy==1.26.4": ["sha256:aaa", "sha256:bbb"],
            "scipy==1.11.4": ["sha256:ccc"],
        })
        self.assertEqual(list(result), ["numpy==1.26.4", "scipy==1.11.4"])

        self.compile_text = (
            "good==1.0 \\\n"
            "    --hash=sha256:x\n"
            "evil @ https://example.com/evil-1.0-py3-none-any.whl\n"
        )
        with contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(provision.ResolveError) as cm:
            provision.resolve(["good", "evil"])
        self.assertIn("unexpected host", str(cm.exception))

    def test_failed_resolve_reports_uv_stderr(self):
        self.uv_rc = 2
        self.uv_stderr = "error: Failed to fetch https://pypi.org/simple/numpy/"
        with contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(provision.ResolveError) as cm:
            provision.resolve(["numpy"])
        msg = str(cm.exception)
        self.assertIn("could not resolve numpy", msg)
        self.assertIn("exit 2", msg)
        self.assertIn(self.uv_stderr, msg)

    def test_failed_install_reports_uv_stderr(self):
        self.uv_rc = 1
        self.uv_stderr = "error: Hash mismatch for foo==1.0"
        with contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(provision.ResolveError) as cm:
            provision.ensure_stored("foo==1.0", ["sha256:aaa"])
        msg = str(cm.exception)
        self.assertIn("could not install foo==1.0", msg)
        self.assertIn(self.uv_stderr, msg)


class CommittedLockTests(StoreTestCase):
    """The `npm install` model: the manifest first, the committed lock second."""

    ENTRIES = [{"name": "alpha", "constraint": "", "warm": None},
               {"name": "beta", "constraint": ">=2", "warm": None}]

    def _committed(self) -> dict:
        return {"schema": 1,
                "entries": {"alpha": "", "beta": ">=2"},
                "roots": {"alpha": "alpha==1.0", "beta": "beta==2.5"},
                "pins": {"alpha==1.0": ["sha256:a"], "beta==2.5": ["sha256:b"]}}

    def test_an_unchanged_entry_rides_as_a_constraint(self):
        captured: list[tuple[list[str], str | None]] = []

        def spy(specs, constraints=None):
            captured.append((list(specs),
                             Path(constraints).read_text() if constraints else None))
            return {"alpha==1.0": ["sha256:a"], "beta==2.5": ["sha256:b"]}

        with unittest.mock.patch.object(provision, "resolve", spy), \
                contextlib.redirect_stdout(io.StringIO()):
            pins = provision.resolve_manifest_python(self.ENTRIES, self._committed())

        self.assertEqual(list(pins), ["alpha==1.0", "beta==2.5"])
        specs, constraints = captured[0]
        self.assertEqual(specs, ["alpha", "beta>=2"])
        # Both constraints match the committed record, thus both root pins ride.
        self.assertIn("alpha==1.0", constraints)
        self.assertIn("beta==2.5", constraints)

    def test_a_changed_entry_resolves_fresh(self):
        changed = [{"name": "alpha", "constraint": "", "warm": None},
                   {"name": "beta", "constraint": ">=3", "warm": None}]
        captured: list[str | None] = []

        def spy(specs, constraints=None):
            captured.append(Path(constraints).read_text() if constraints else None)
            return {"alpha==1.0": ["sha256:a"], "beta==3.1": ["sha256:c"]}

        with unittest.mock.patch.object(provision, "resolve", spy), \
                contextlib.redirect_stdout(io.StringIO()):
            provision.resolve_manifest_python(changed, self._committed())

        # The changed beta rides free; the unchanged alpha keeps its pin.
        self.assertIn("alpha==1.0", captured[0])
        self.assertNotIn("beta==2.5", captured[0])

    def test_a_conflicting_lock_falls_back_to_a_fresh_resolve(self):
        calls: list[str | None] = []

        def spy(specs, constraints=None):
            calls.append(constraints and "constrained" or "fresh")
            if constraints is not None:
                raise provision.ResolveError("the pins conflict")
            return {"alpha==1.1": ["sha256:d"], "beta==2.6": ["sha256:e"]}

        with unittest.mock.patch.object(provision, "resolve", spy), \
                contextlib.redirect_stdout(io.StringIO()):
            pins = provision.resolve_manifest_python(self.ENTRIES, self._committed())

        self.assertEqual(calls, ["constrained", "fresh"])
        self.assertEqual(list(pins), ["alpha==1.1", "beta==2.6"])

    def test_committed_lock_of_records_the_roots_and_the_pins(self):
        pins = {"alpha==1.0": ["sha256:a"], "dep==0.9": ["sha256:z"]}
        lock = provision.committed_lock_of(
            [{"name": "Alpha", "constraint": "", "warm": None}], pins)
        self.assertEqual(lock["schema"], 1)
        self.assertEqual(lock["entries"], {"alpha": ""})
        self.assertEqual(lock["roots"], {"alpha": "alpha==1.0"})
        self.assertEqual(lock["pins"], pins)


class BuildRunTests(StoreTestCase):
    """A whole `build` run: the one metadata file, the lock-last publish, and
    no legacy record anywhere."""

    MANIFEST = {"python": {"pip": {"common": ["foo"]}}}

    def _build(self) -> int:
        args = SimpleNamespace(manifest=str(self.root / "manifest.yaml"),
                               lock=None, farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=dict(self.MANIFEST)), \
                contextlib.redirect_stdout(io.StringIO()):
            return provision.cmd_build(args)

    def test_the_farm_carries_one_metadata_file(self):
        self.compile_text = FOO_1
        self.install_tree = dict(FOO_1_TREE)
        self.assertEqual(self._build(), 0)

        farm = provision.FARMS / "catalog"
        lock = json.loads((farm / "inflexa.lock").read_text())
        self.assertEqual(lock["schema"], 1)
        self.assertIn(lock["arch"], ("amd64", "arm64"))
        self.assertEqual(len(lock["packages"]), 1)
        entry = lock["packages"][0]
        self.assertEqual(entry["name"], "foo")
        self.assertEqual(entry["version"], "1.0")
        self.assertEqual(entry["track"], "python")
        self.assertTrue(entry["requested"])          # a direct manifest ask
        self.assertRegex(entry["hash"], r"^[0-9a-f]{64}$")
        self.assertEqual(lock["languages"]["python"]["index"], provision.INDEX_URL)

        # The legacy markers are not part of the farm contract, and the store
        # root carries no pointer.
        for stale in ("packages.txt", "meta.json", "lock.json"):
            self.assertFalse((farm / stale).exists(), stale)
        self.assertFalse((provision.LIBS / "current").exists())
        # The graph appended for the published farm.
        nodes = json.loads((provision.LIBS / "deps.json").read_text())["nodes"]
        self.assertEqual(len(nodes), 1)

    def test_a_transitive_dependency_records_requested_false(self):
        self.compile_text = FOO_1 + BAR_2   # bar resolves as a dependency
        self.install_tree = {**FOO_1_TREE, **BAR_2_TREE}
        self.assertEqual(self._build(), 0)

        lock = json.loads((provision.FARMS / "catalog" / "inflexa.lock").read_text())
        requested = {p["name"]: p["requested"] for p in lock["packages"]}
        self.assertEqual(requested, {"foo": True, "bar": False})

    def test_a_crash_before_the_lock_write_leaves_no_accepted_farm(self):
        """The lock writes LAST inside the staging, thus a crash before it
        leaves a staging with no `inflexa.lock` — a directory the mount gate
        refuses — and no published farm."""
        self.compile_text = FOO_1
        self.install_tree = dict(FOO_1_TREE)

        def die(farm, lock):
            raise RuntimeError("the run died before the lock write")

        args = SimpleNamespace(manifest=str(self.root / "manifest.yaml"),
                               lock=None, farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=dict(self.MANIFEST)), \
                unittest.mock.patch.object(provision, "write_farm_lock", die), \
                contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(RuntimeError):
            provision.cmd_build(args)

        self.assertFalse((provision.FARMS / "catalog").exists())
        staging = provision.FARMS / (provision.FARM_STAGING + "catalog")
        self.assertTrue(staging.is_dir())
        self.assertFalse((staging / "inflexa.lock").exists())

    def test_the_committed_lock_writes_back(self):
        self.compile_text = FOO_1
        self.install_tree = dict(FOO_1_TREE)
        lock_path = self.root / "lock.json"
        args = SimpleNamespace(manifest=str(self.root / "manifest.yaml"),
                               lock=str(lock_path), farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=dict(self.MANIFEST)), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_build(args), 0)

        committed = json.loads(lock_path.read_text())
        self.assertEqual(committed["roots"], {"foo": "foo==1.0"})
        self.assertEqual(committed["pins"], {"foo==1.0": ["sha256:aaa"]})


class PrepareRunTests(StoreTestCase):
    """The preparation run: the farm bind, the per-package records, and the
    failure of a broken workload."""

    def _built_catalog(self) -> Path:
        self.compile_text = FOO_1
        self.install_tree = dict(FOO_1_TREE)
        args = SimpleNamespace(manifest=str(self.root / "pkgstore" / "manifest.yaml"),
                               lock=None, farm="catalog")
        manifest = {"python": {"pip": {"common": [
            {"name": "foo", "reason": "r", "warm": "warm/foo.py"}]}}}
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=manifest), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_build(args), 0)
        # The warm script sits beside the manifest, as in the repository.
        script = self.root / "pkgstore" / "warm" / "foo.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("import foo\n")
        self.manifest = manifest
        self.script = script
        return provision.FARMS / "catalog"

    def _prepare(self) -> int:
        args = SimpleNamespace(manifest=str(self.root / "pkgstore" / "manifest.yaml"),
                               farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=self.manifest), \
                contextlib.redirect_stdout(io.StringIO()):
            return provision.cmd_prepare(args)

    def test_the_per_package_record_reaches_the_lock(self):
        """The record holds the loaded-only entries, keyed per package, with
        the manifest-relative script path and its hash. The unit test stands a
        symlink in for the bind, because a bind mount needs a privilege that a
        host test does not hold."""
        farm = self._built_catalog()
        provision.FARM_BIND.symlink_to(farm)
        cache = farm / "numba-cache"
        self.cache_events = {str(self.script): [
            ("loaded from", f"{cache}/foo_a1/foo.kernel-12.py311.1.nbc"),
            ("saved to", f"{cache}/foo_a1/foo.unpicklable-40.py311.7.nbc"),
        ]}

        self.assertEqual(self._prepare(), 0)

        lock = json.loads((farm / "inflexa.lock").read_text())
        record = lock["warm"]["foo"]
        self.assertEqual(record["script"], "warm/foo.py")
        self.assertRegex(record["script_sha256"], r"^[0-9a-f]{64}$")
        # The loaded entry enters the record; the write-only one stays out.
        self.assertEqual(record["cache_entries"], ["foo_a1/foo.kernel-12.py311.1.nbc"])
        # Two passes ran, both through the bind path.
        self.assertEqual(len(self.warm_paths), 2)
        for given, resolved in self.warm_paths:
            self.assertEqual(given, str(provision.FARM_BIND / "python" / "site-packages"))
            self.assertEqual(resolved, os.path.realpath(farm / "python" / "site-packages"))

    def test_a_prepare_without_the_bind_fails_and_names_the_mount(self):
        farm = self._built_catalog()

        args = SimpleNamespace(manifest=str(self.root / "pkgstore" / "manifest.yaml"),
                               farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=self.manifest), \
                contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(SystemExit) as cm:
            provision.cmd_prepare(args)

        message = str(cm.exception)
        self.assertIn("cannot resolve the farm", message)
        self.assertIn(str(provision.FARM_BIND), message)
        self.assertIn(str(farm), message)
        self.assertEqual(self.warm_paths, [])
        self.assertNotIn("warm", json.loads((farm / "inflexa.lock").read_text()))

    def test_a_failing_warm_script_stops_the_run(self):
        farm = self._built_catalog()
        provision.FARM_BIND.symlink_to(farm)
        self.warm_failures = {str(self.script): "RuntimeError: the workload did not finish"}

        args = SimpleNamespace(manifest=str(self.root / "pkgstore" / "manifest.yaml"),
                               farm="catalog")
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=self.manifest), \
                contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(SystemExit) as cm:
            provision.cmd_prepare(args)

        message = str(cm.exception)
        self.assertIn(str(self.script), message)
        self.assertIn("exited non-zero", message)
        self.assertIn("RuntimeError", message)


class AcquireRunTests(StoreTestCase):
    """The acquire run: the pool and the report land, and deps.json never
    changes. The probes are monkeypatched, because a unit test opens no
    network; the container rig drives the real ones."""

    def _acquire(self, specs: list[str]) -> tuple[int, dict]:
        report = self.root / "report.json"
        args = SimpleNamespace(report=str(report), specs=specs)
        with contextlib.redirect_stdout(io.StringIO()):
            code = provision.cmd_acquire(args)
        return code, json.loads(report.read_text())

    def test_the_pool_and_the_staged_nodes_land_and_the_graph_stays(self):
        self.compile_by_input = {"foo": FOO_1}
        self.install_tree = dict(FOO_1_TREE)

        code, report = self._acquire(["python:foo"])

        self.assertEqual(code, 0)
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)
        self.assertEqual([o["outcome"] for o in report["outcomes"]], ["acquired"])
        self.assertEqual(len(report["nodes"]), 1)
        node = next(iter(report["nodes"].values()))
        self.assertEqual(node["imports"], ["foo"])
        # The two-phase contract: no advertised state before the host commit.
        self.assertFalse((provision.LIBS / "deps.json").exists())
        self.assertEqual(sorted(p.name for p in provision.FARMS.iterdir()), [])
        self.assertEqual(sorted(p.name for p in provision.STORE.glob(".staging*")), [])

    def test_one_bad_spec_drops_out_and_the_rest_still_lands(self):
        self.compile_by_input = {"foo": FOO_1}
        self.compile_failures = {"nosuch": "error: no version of nosuch"}
        self.install_tree = dict(FOO_1_TREE)

        code, report = self._acquire(["python:foo", "python:nosuch"])

        self.assertEqual(code, 0)
        outcomes = {o["spec"]: o for o in report["outcomes"]}
        self.assertEqual(outcomes["python:foo"]["outcome"], "acquired")
        self.assertEqual(outcomes["python:nosuch"]["outcome"], "refused")
        self.assertIn("no version of nosuch", outcomes["python:nosuch"]["reason"])
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)

    def test_a_location_spec_refuses_at_the_boundary(self):
        code, report = self._acquire(["python:./dist/pkg-1.0.whl"])
        self.assertEqual(code, 0)
        self.assertEqual(report["outcomes"][0]["outcome"], "refused")
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_an_unqualified_name_that_both_ecosystems_satisfy_stops(self):
        with unittest.mock.patch.object(provision, "python_index_holds",
                                        return_value=True), \
                unittest.mock.patch.object(provision, "r_repos_hold",
                                           return_value={"igraph": True}):
            code, report = self._acquire(["igraph"])

        self.assertEqual(code, 0)
        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "both_hit")
        self.assertEqual([c["ecosystem"] for c in outcome["candidates"]],
                         ["python", "r"])
        # Nothing installed: the host asks the user first.
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_an_unqualified_single_hit_takes_that_ecosystem(self):
        self.compile_by_input = {"foo": FOO_1}
        self.install_tree = dict(FOO_1_TREE)
        with unittest.mock.patch.object(provision, "python_index_holds",
                                        return_value=True), \
                unittest.mock.patch.object(provision, "r_repos_hold",
                                           return_value={"foo": False}):
            code, report = self._acquire(["foo"])

        self.assertEqual(code, 0)
        self.assertEqual(report["outcomes"][0]["outcome"], "acquired")
        self.assertEqual(report["outcomes"][0]["ecosystem"], "python")


class ParallelAcquisitionTests(StoreTestCase):
    """Acquisition runs are parallel. Each concurrent run is a forked child,
    thus two runs write into one store at the same moment. A child inherits
    the fake ``subprocess.run`` of the test, and it leaves through
    ``os._exit``, so it runs no teardown of the test."""

    def _fork_spec(self, spec: str, compile_text: str,
                   install_tree: dict[str, str], gate: Path) -> int:
        pid = os.fork()
        if pid:
            return pid
        code = 1
        try:
            self.compile_text = compile_text
            self.install_tree = dict(install_tree)
            # Each run stages under its own token and clears its staging after
            # the batch — the same discipline cmd_acquire applies.
            provision.RUN_TOKEN = f"{os.getpid()}-test"
            for _ in range(3000):
                if gate.exists():
                    break
                time.sleep(0.001)
            with contextlib.redirect_stdout(io.StringIO()):
                with provision.store_lock(shared=True):
                    outcome = provision.acquire_python_spec(provision.parse_spec(spec))
                    shutil.rmtree(provision.staging_dir("python"), ignore_errors=True)
                    code = 0 if outcome["outcome"] == "acquired" else 3
        except BaseException:                              # noqa: BLE001 (a child reports and exits)
            (self.root / "child.err").write_text(traceback.format_exc())
            code = 9
        finally:
            os._exit(code)

    def test_two_runs_for_one_package_converge_on_one_store_dir(self):
        gate = self.root / "go"
        pids = [self._fork_spec("python:foo", FOO_1, FOO_1_TREE, gate),
                self._fork_spec("python:foo", FOO_1, FOO_1_TREE, gate)]
        gate.write_text("go\n")
        for pid in pids:
            _, status = os.waitpid(pid, 0)
            report = self.root / "child.err"
            detail = report.read_text() if report.is_file() else ""
            self.assertEqual(os.waitstatus_to_exitcode(status), 0,
                             f"a run did not finish:\n{detail}")

        stored = list(provision.STORE.glob("foo-1.0-*"))
        self.assertEqual(len(stored), 1, stored)
        self.assertEqual(sorted(p.name for p in provision.STORE.glob(".staging*")), [])

    def test_a_publish_that_loses_the_race_keeps_the_published_copy(self):
        """The fake chmod stands in for the parallel run: it publishes the
        same content between the check for the directory and the rename."""
        self.install_tree = dict(FOO_1_TREE)
        winner: dict[str, Path] = {}
        outer = provision.subprocess.run

        def race(cmd, *args, **kwargs):
            argv = list(cmd)
            if argv[0] == "chmod" and not winner:
                staging = Path(argv[-1])
                digest = provision.tree_hash(staging)[:16]
                final = provision.STORE / f"foo-1.0-{digest}"
                self._write_tree(final, FOO_1_TREE)
                (final / provision.PIN_MARKER).write_text("foo==1.0\n")
                winner["path"] = final
            return outer(cmd, *args, **kwargs)

        provision.subprocess.run = race
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                path, is_new = provision.ensure_stored("foo==1.0", ["sha256:aaa"])
        finally:
            provision.subprocess.run = outer

        self.assertEqual(path, winner["path"])
        self.assertFalse(is_new)
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 1)
        self.assertFalse((provision.STORE / ".staging" / "foo").exists())

    def test_a_crashed_run_leaves_only_reclaim_food(self):
        """A run that dies after its pool write leaves store directories that
        no farm references, and reclaim removes them."""
        self.compile_by_input = {"bar": BAR_2}
        self.install_tree = dict(BAR_2_TREE)
        with contextlib.redirect_stdout(io.StringIO()):
            outcome = provision.acquire_python_spec(provision.parse_spec("python:bar"))
        self.assertEqual(outcome["outcome"], "acquired")
        # The run died before its report: nothing advertises the bytes.
        self.assertFalse((provision.LIBS / "deps.json").exists())

        with contextlib.redirect_stdout(io.StringIO()):
            provision.cmd_reclaim(SimpleNamespace())
        self.assertEqual(list(provision.STORE.glob("bar-2.0-*")), [])


class ReclaimTests(StoreTestCase):
    """Reclamation is exclusive and lease-free; remove-farm never touches the
    pool."""

    def test_reclaim_keeps_referenced_drops_orphan(self):
        a = provision.STORE / "keepa-1.0-000000000000000a"
        b = provision.STORE / "dropb-1.0-000000000000000b"
        for d in (a, b):
            (d / "mod").mkdir(parents=True)
            (d / "mod" / "__init__.py").write_text("pass\n")
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(provision.FARMS / "an1", [a])

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_reclaim(SimpleNamespace()), 0)
        self.assertTrue(a.exists())
        self.assertFalse(b.exists())

    def test_remove_farm_removes_the_farm_and_never_the_pool(self):
        """No lease guards a removal: the host gates its own delete flow on
        live work, and that gate is the one guard."""
        a = provision.STORE / "keepa-1.0-000000000000000a"
        (a / "mod").mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(provision.FARMS / "gone", [a])

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_remove_farm(SimpleNamespace(name="gone")), 0)
        self.assertFalse((provision.FARMS / "gone").exists())
        self.assertTrue(a.exists())

        # An unknown farm is a soft failure (exit code 2), not a raise.
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_remove_farm(SimpleNamespace(name="nonexistent")), 2)


class MarkerTests(unittest.TestCase):
    """The marker of a requirement decides the edge. These pin the USE of
    `packaging`: the environment the emitter builds, the empty `extra`, and
    the two failures that KEEP an edge rather than drop it."""

    def setUp(self):
        self.env = dict(emit_deps.marker_environment(),
                        sys_platform="linux", platform_machine="x86_64",
                        python_version="3.12", python_full_version="3.12.4",
                        os_name="posix")

    def edge(self, requirement: str):
        return emit_deps.edge_name(requirement, self.env)

    def test_the_environment_names_each_variable_of_pep_508(self):
        env = emit_deps.marker_environment()
        for key in ("os_name", "sys_platform", "platform_machine", "platform_release",
                    "platform_system", "platform_version", "python_version",
                    "python_full_version", "implementation_name", "implementation_version",
                    "platform_python_implementation", "extra"):
            self.assertIn(key, env)

    def test_no_extra_is_active(self):
        self.assertEqual(emit_deps.marker_environment()["extra"], "")
        self.assertIsNone(self.edge('pytest; extra == "test"'))

    def test_a_false_marker_drops_the_edge_and_a_true_marker_keeps_it(self):
        self.assertIsNone(self.edge('colorama; sys_platform == "win32"'))
        self.assertEqual(self.edge('numpy>=1.23; python_version >= "3.9"'), "numpy")
        self.assertEqual(self.edge("typing-extensions"), "typing-extensions")

    def test_a_marker_that_does_not_parse_keeps_the_edge(self):
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            name = self.edge('mystery; no_such_variable == "1"')
        self.assertEqual(name, "mystery")
        self.assertIn("WARNING", buf.getvalue())

    def test_a_version_that_does_not_read_keeps_the_edge(self):
        class Raising:
            def __init__(self, _text): pass
            def evaluate(self, _env): raise emit_deps.InvalidVersion("Invalid version")

        with unittest.mock.patch.object(emit_deps, "Marker", Raising):
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                name = emit_deps.edge_name('oldpkg; platform_release > "5.0"', self.env)
        self.assertEqual(name, "oldpkg")
        self.assertIn("WARNING", buf.getvalue())


class DependencyGraphTests(StoreTestCase):
    """deps.json: the node schema, the dropped edges, the gate, the append,
    and the order strings."""

    def _python_store_dir(self, name: str, version: str, requires: list[str],
                          scripts: list[str] | None = None) -> Path:
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
        store_dir = provision.STORE / f"{name.lower()}-{version}-0000000000000000"
        inner = store_dir / name
        (inner / "R").mkdir(parents=True)
        (inner / "DESCRIPTION").write_text(f"Package: {name}\nVersion: {version}\n")
        return store_dir

    def _farm_of(self, farm_name: str, store_dirs: list[Path]) -> Path:
        farm = provision.FARMS / farm_name
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(farm, store_dirs)
        return farm

    def test_a_python_node_carries_the_track_imports_entry_points_and_edges(self):
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
        self.assertEqual(node["edges"], [beta.name])
        # Each node carries its order string, thus a host commit re-sorts a
        # name with a plain string comparison.
        self.assertEqual(node["order"], emit_deps.order_string("python", "1.0"))
        self.assertTrue((provision.LIBS / "deps.json").is_file())

    def test_an_edge_into_an_image_owned_package_drops(self):
        self.assertIn("setuptools", emit_deps.load_base_packages()["python"])
        alpha = self._python_store_dir("alpha", "1.0", ["setuptools", "pip>=23"])
        farm = self._farm_of("an1", [alpha])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_for_farm(provision.LIBS, farm)
        self.assertEqual(graph["nodes"][alpha.name]["edges"], [])

    def test_a_dangling_edge_fails_the_build_and_names_the_edge(self):
        alpha = self._python_store_dir("alpha", "1.0", ["nowhere"])
        farm = self._farm_of("an1", [alpha])

        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            emit_deps.append_for_farm(provision.LIBS, farm)
        self.assertIn(f"{alpha.name} -> nowhere", str(cm.exception))
        self.assertFalse((provision.LIBS / "deps.json").exists())

    def test_an_r_node_carries_its_inner_directory_and_its_dcf_edges(self):
        rcpp = self._r_store_dir("Rcpp", "1.0.13")
        pkg = self._r_store_dir("myRpkg", "1.2.3")
        farm = provision.FARMS / "an1"
        provision.build_r_track(farm, {"cran": [("Rcpp", rcpp), ("myRpkg", pkg)],
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
        # R, stats, and MASS belong to the image; only the store package stays.
        self.assertEqual(node["edges"], [rcpp.name])

    def test_a_linkingto_package_gives_no_edge(self):
        self.assertIn('c("Depends", "Imports")', emit_deps.R_READ_DCF)
        self.assertNotIn("LinkingTo", emit_deps.R_READ_DCF)

    def test_an_append_keeps_every_earlier_node_byte_identical(self):
        alpha = self._python_store_dir("alpha", "1.0", [])
        with contextlib.redirect_stdout(io.StringIO()):
            emit_deps.append_store_dirs(provision.LIBS, [alpha])

        graph_path = provision.LIBS / "deps.json"
        before_text = graph_path.read_text()
        before = json.loads(before_text)["nodes"]
        self.assertEqual(len(before), 1)

        beta = self._python_store_dir("beta", "2.0", ["alpha"])
        with contextlib.redirect_stdout(io.StringIO()):
            emit_deps.append_store_dirs(provision.LIBS, [alpha, beta])

        after_text = graph_path.read_text()
        after = json.loads(after_text)["nodes"]
        self.assertEqual(len(after), 2)
        for key, node in before.items():
            self.assertEqual(after[key], node)
            self.assertIn(self._node_block(before_text, key), after_text)
        self.assertEqual(after[beta.name]["edges"], [alpha.name])

    @staticmethod
    def _node_block(text: str, key: str) -> str:
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

    # --- The version order ---------------------------------------------------

    def test_three_versions_of_one_name_order_newest_first(self):
        old = self._python_store_dir("alpha", "1.9.0", [])
        mid = self._python_store_dir("alpha", "1.10.3", [])
        new = self._python_store_dir("alpha", "2.0", [])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [old, mid, new])

        self.assertEqual(graph["by_name"]["python"]["alpha"],
                         [new.name, mid.name, old.name])
        self.assertEqual(graph["nodes"][mid.name]["version"], "1.10.3")

    def test_a_release_heads_the_name_and_a_pre_release_follows_it(self):
        release = self._python_store_dir("alpha", "2.0", [])
        pre = self._python_store_dir("alpha", "2.1rc1", [])
        lone = self._python_store_dir("beta", "3.0b1", [])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [release, pre, lone])

        self.assertEqual(graph["by_name"]["python"]["alpha"], [release.name, pre.name])
        self.assertEqual(graph["by_name"]["python"]["beta"], [lone.name])

    def test_the_r_order_reads_the_dotted_decimal_rule(self):
        old = self._r_store_dir("myRpkg", "0.99.0-3")
        mid = self._r_store_dir("myRpkg", "0.99.0-10")
        new = self._r_store_dir("myRpkg", "1.2.3")

        def fake(cmd, *args, **kwargs):
            lines = "".join(f"{path}\t\n" for path in kwargs["input"].splitlines())
            return SimpleNamespace(returncode=0, stdout=lines, stderr="")

        provision.subprocess.run = fake
        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [old, mid, new])

        self.assertEqual(graph["by_name"]["r"]["myrpkg"],
                         [new.name, mid.name, old.name])

    def test_the_order_string_sorts_as_plain_text(self):
        """The one place where the version rules live. A host commit sorts a
        name by comparing these strings, thus no second copy of the rules
        exists on a host."""
        ranked = sorted(["1.9.0", "1.10.3", "2.0.0rc1", "2.0.0"],
                        key=lambda v: emit_deps.order_string("python", v), reverse=True)
        self.assertEqual(ranked, ["2.0.0", "1.10.3", "1.9.0", "2.0.0rc1"])
        ranked_r = sorted(["1.2-3", "1.10.0", "0.99.0-10"],
                          key=lambda v: emit_deps.order_string("r", v), reverse=True)
        self.assertEqual(ranked_r, ["1.10.0", "1.2-3", "0.99.0-10"])

    def test_a_graph_of_another_schema_version_stops_the_run(self):
        graph_path = provision.LIBS / "deps.json"
        other = json.dumps({"version": emit_deps.GRAPH_VERSION + 1, "nodes": {}}) + "\n"
        graph_path.write_text(other)
        alpha = self._python_store_dir("alpha", "1.0", [])

        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            emit_deps.append_store_dirs(provision.LIBS, [alpha])

        self.assertIn(str(emit_deps.GRAPH_VERSION + 1), str(cm.exception))
        self.assertEqual(graph_path.read_text(), other)


# --- The image-owned package list ---------------------------------------------
# base-packages.json is a hand-kept claim about the sandbox image. The
# comparison below holds it to that image.

SANDBOX_IMAGE = os.environ.get("SANDBOX_IMAGE", "ghcr.io/inflexa-ai/sandbox-base:latest")

IMAGE_INVENTORY = r'''
import json
import subprocess
from importlib.metadata import distributions
from pathlib import Path

python = sorted({d.metadata["Name"] for d in distributions() if d.metadata["Name"]})

libs = subprocess.run(["Rscript", "-e", 'cat(.libPaths(), sep="\n")'],
                      capture_output=True, text=True, check=True)
r = set()
for lib in libs.stdout.split():
    path = Path(lib)
    if path.is_dir():
        r |= {d.name for d in path.iterdir() if (d / "DESCRIPTION").is_file()}

r.add("R")

print(json.dumps({"python": python, "r": sorted(r)}))
'''


def container_engine() -> str | None:
    named = os.environ.get("CTR")
    for engine in ([named] if named else ["podman", "docker"]):
        if engine and shutil.which(engine):
            return engine
    return None


def image_owned_sets(inventory: dict[str, list[str]]) -> dict[str, set[str]]:
    return {"python": {emit_deps.canon(name) for name in inventory["python"]},
            "r": set(inventory["r"])}


def image_owned_report(listed: dict[str, set[str]], installed: dict[str, set[str]],
                       image: str) -> str:
    """The empty string when the image owns each listed name, else the report.

    A name that the image does not own drops a real edge. The closure then
    runs short, and the import fails inside the sandbox with no explanation.
    """
    absent = sorted((track, name)
                    for track, names in listed.items()
                    for name in names
                    if name not in installed[track])
    if not absent:
        return ""
    lines = "\n".join(f"  {track}: {name}" for track, name in absent)
    return (f"the image-owned package list names {len(absent)} package(s) that "
            f"{image} does not own:\n{lines}\n"
            + emit_deps.REVEALED_NAME_RULE)


class ImageOwnedPackageTests(unittest.TestCase):
    """base-packages.json against the installed set of the sandbox image."""

    def test_a_stale_name_fails_and_names_the_package(self):
        listed = {"python": {"pip", "nowhere"}, "r": {"base", "Nothing"}}
        installed = {"python": {"pip"}, "r": {"base"}}

        report = image_owned_report(listed, installed, "an-image")

        self.assertIn("python: nowhere", report)
        self.assertIn("r: Nothing", report)
        self.assertIn("images/package-store/manifest.yaml", report)
        self.assertIn(emit_deps.BASE_PACKAGES_FILE.name, report)

    def test_a_list_that_matches_the_image_passes(self):
        listed = {"python": {"pip", "ruff"}, "r": {"base", "MASS"}}
        installed = {"python": {"pip", "ruff", "wheel"}, "r": {"base", "MASS", "utils"}}
        self.assertEqual(image_owned_report(listed, installed, "an-image"), "")

    def test_the_recorded_list_matches_the_sandbox_image(self):
        engine = container_engine()
        if engine is None:
            raise unittest.SkipTest(
                "no container engine on this host; install podman or docker, or set CTR")
        found = subprocess.run([engine, "image", "inspect", SANDBOX_IMAGE],
                               capture_output=True, text=True)
        if found.returncode != 0:
            raise unittest.SkipTest(
                f"{engine} cannot reach the image {SANDBOX_IMAGE}: "
                f"{found.stderr.strip()[-200:] or '(the engine wrote nothing)'}")

        read = subprocess.run(
            [engine, "run", "--rm", "-i", "--network", "none",
             "--entrypoint", "python3", SANDBOX_IMAGE, "-"],
            input=IMAGE_INVENTORY, capture_output=True, text=True, timeout=300)
        self.assertEqual(read.returncode, 0,
                         f"the image inventory failed:\n{read.stderr.strip()[-600:]}")
        inventory = json.loads(read.stdout)
        self.assertTrue(inventory["python"], f"{SANDBOX_IMAGE} reported no distribution")
        self.assertTrue(inventory["r"], f"{SANDBOX_IMAGE} reported no R package")

        report = image_owned_report(emit_deps.load_base_packages(),
                                    image_owned_sets(inventory), SANDBOX_IMAGE)
        if report:
            self.fail(report)


if __name__ == "__main__":
    unittest.main()
