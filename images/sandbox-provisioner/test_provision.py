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
from unittest import mock
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
import package_identity  # noqa: E402  (import after LIB_ROOT/sys.path are set up)
import provision  # noqa: E402  (import after LIB_ROOT/sys.path are set up)


# The shared conformance fixture, which the cli suite reads too. It lives in
# the repository and not in the provisioner image, thus a case that needs it
# skips outside a checkout.
_FIXTURE = (Path(os.path.abspath(__file__)).resolve().parent
            / ".." / ".." / "harness" / "src" / "sandbox" / "__fixtures__"
            / "package-identity.json")


def _fixture_cases() -> dict | None:
    try:
        return json.loads(_FIXTURE.read_text())
    except (OSError, ValueError):
        return None


FIXTURE_CASES = _fixture_cases()

FIXTURE_SKIP_REASON = (f"the conformance fixture {_FIXTURE.name} is not at "
                       f"{_FIXTURE}; it lives in the repository, not in the "
                       "provisioner image")


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
        # The apt pin of `acquire-source` writes real files, thus every test
        # runs it against a fixture root: an os-release that names the suite,
        # the live sources the pin replaces, and none of the host's `/etc`.
        self.apt_root = self.root / "aptroot"
        self.apt_sources = self.apt_root / "etc" / "apt" / "sources.list.d"
        self.apt_sources.mkdir(parents=True)
        (self.apt_root / "etc" / "os-release").write_text(
            'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
        (self.apt_root / "etc" / "apt" / "sources.list").write_text(
            "deb http://archive.ubuntu.com/ubuntu noble main\n")
        (self.apt_sources / "ubuntu.sources").write_text(
            "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\n"
            "Suites: noble noble-updates\nComponents: main universe\n")
        self._apt_env = unittest.mock.patch.dict(
            os.environ, {"INFLEXA_APT_CONF_ROOT": str(self.apt_root)})
        self._apt_env.start()

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
        # Canned outputs of the source-build probes: the `--version` first line
        # of each build tool, the R and pak runtime versions, and the resolved
        # dpkg version of an apt package.
        self.tool_versions = {
            "gcc": "gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0\n",
            "g++": "g++ (Ubuntu 13.2.0-23ubuntu4) 13.2.0\n",
            "gfortran": "GNU Fortran (Ubuntu 13.2.0-23ubuntu4) 13.2.0\n",
            "cmake": "cmake version 3.28.3\n",
            "uv": "uv 0.12.5\n",
        }
        self.r_version = "4.6.0\n"
        self.pak_version = "1.1.0\n"
        self.dpkg_versions: dict[str, str] = {}
        # The pak lock a resolve of a source tree answers, keyed by the ref.
        self.pak_locks: dict[str, dict] = {}
        # The Depends/Imports fields emit_deps reads, keyed by the inner path.
        self.dcf_fields: dict[str, str] = {}
        # The tree a source-root wheel install lands (uv install with a wheel
        # path and no `-r` file); `install_tree` serves the `-r` installs.
        self.root_install_tree: dict[str, str] = {}

        # The apt installs of the run: the failure text per command, keyed by
        # the second word of the command (`update`, `install`).
        self.apt_failures: dict[str, str] = {}
        # Per-pin failure of the hash-pinned install: a pin text found in the
        # requirement fragment fails with its stderr.
        self.install_failures: dict[str, str] = {}
        # What the unprivileged launch looked like at the moment it ran.
        self.script_runs: list[dict] = []

        # A normal user can neither chmod the parent of the store nor chown to
        # uid 1000, thus the two system-path steps of the clean run record
        # their call instead of making it.
        self._system_patches = [
            unittest.mock.patch.object(
                provision, "hide_store_parent",
                side_effect=lambda parent: self.calls.append(["hide-store-parent", str(parent)])),
            unittest.mock.patch.object(
                provision, "give_to_build_user",
                side_effect=lambda path: self.calls.append(["give-to-build-user", str(path)])),
        ]
        for patch in self._system_patches:
            patch.start()
        # The read-only view of the store root, at a path that differs from it.
        self.view_holder = Path(tempfile.mkdtemp(prefix="prov-view-"))
        self.view = self.view_holder / "libs-ro"
        self.view.symlink_to(self.root)

        self._orig_run = provision.subprocess.run
        provision.subprocess.run = self._fake_run

    def tearDown(self):
        self._apt_env.stop()
        for patch in self._system_patches:
            patch.stop()
        shutil.rmtree(self.view_holder, ignore_errors=True)
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
        if prog == "setpriv":
            inner = argv[argv.index("--") + 1:]
            if inner[0] == "kill":
                # The sweep of the build user: no process is left to signal.
                return SimpleNamespace(returncode=1, stdout="", stderr="")
            self._record_script_run(argv, kwargs)
            return self._fake_run(inner, *args, **kwargs)
        if prog == "apt-get":
            failure = self.apt_failures.get(argv[1])
            if failure is not None:
                kwargs["stdout"].write(failure.encode())
                return SimpleNamespace(returncode=100)
            return SimpleNamespace(returncode=0)
        if prog == "bash":
            # The approved build script runs for real: it only copies fixture
            # trees around the temp store.
            return self._orig_run(cmd, *args, **kwargs)
        if prog in self.tool_versions and "--version" in argv:
            return SimpleNamespace(returncode=0, stdout=self.tool_versions[prog], stderr="")
        if prog == "Rscript":
            return self._fake_rscript(argv, kwargs)
        if prog == "dpkg-query":
            return SimpleNamespace(returncode=0,
                                   stdout=self.dpkg_versions.get(argv[-1], "1.2.3-1build2"),
                                   stderr="")
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
            if "-r" in argv:
                fragment = Path(argv[argv.index("-r") + 1]).read_text()
                for pin, stderr in self.install_failures.items():
                    if pin in fragment:
                        return SimpleNamespace(returncode=1, stdout="", stderr=stderr)
            if self.uv_rc:
                return SimpleNamespace(returncode=self.uv_rc, stdout="", stderr=self.uv_stderr)
            tree = self.root_install_tree if "-r" not in argv else self.install_tree
            self._write_tree(Path(argv[argv.index("--target") + 1]), tree)
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

    def _record_script_run(self, argv: list[str], kwargs: dict) -> None:
        copy = Path(argv[-1])
        self.script_runs.append({
            "argv": argv,
            "cwd": kwargs.get("cwd"),
            "env": kwargs.get("env") or {},
            "stdout": kwargs.get("stdout"),
            "capture_output": kwargs.get("capture_output"),
            "copy_text": copy.read_text(),
            "copy_mode": copy.stat().st_mode & 0o777,
            "copy_dir_mode": copy.parent.stat().st_mode & 0o777,
        })

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

    def _fake_rscript(self, argv: list[str], kwargs: dict) -> SimpleNamespace:
        """The R helpers: the emitter's read.dcf read, the acquire_r.R modes,
        and the two version probes of the build record."""
        if "read.dcf" in argv[-1]:
            asked = (kwargs.get("input") or "").splitlines()
            lines = "".join(f"{path}\t{self.dcf_fields.get(Path(path).name, '')}\n"
                            for path in asked)
            return SimpleNamespace(returncode=0, stdout=lines, stderr="")
        if len(argv) > 2 and argv[1].endswith("acquire_r.R"):
            mode = argv[2]
            if mode == "resolve":
                ref, lock_out = argv[3], Path(argv[4])
                if ref not in self.pak_locks:
                    return SimpleNamespace(returncode=1, stdout="",
                                           stderr=f"pak cannot resolve {ref}")
                lock_out.write_text(json.dumps(self.pak_locks[ref]) + "\n")
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if mode == "install":
                lock = json.loads(Path(argv[3]).read_text())
                lib = Path(argv[4])
                lib.mkdir(parents=True, exist_ok=True)
                for entry in lock.get("packages", []):
                    self._make_r_pkg(lib / entry["package"], entry["package"], entry["version"])
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr=f"unknown mode {mode}")
        if "getRversion" in " ".join(argv):
            return SimpleNamespace(returncode=0, stdout=self.r_version, stderr="")
        if "packageVersion" in " ".join(argv):
            return SimpleNamespace(returncode=0, stdout=self.pak_version, stderr="")
        raise AssertionError(f"test triggered an unexpected Rscript call: {argv!r}")


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
            "version": 2,
            "nodes": {
                keep: {"name": "keep", "version": "1.0", "track": "python", "order": "0001", "imports": [], "entry_points": [], "edges": []},
                drop: {"name": "drop", "version": "2.0", "track": "python", "order": "0002", "imports": [], "entry_points": [], "edges": []},
                ghost: {"name": "ghost", "version": "3.0", "track": "python", "order": "0003", "imports": [], "entry_points": [], "edges": []},
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
        graph = {"version": 2, "nodes": {keep: {"name": "keep"}}, "by_name": {"python": {"keep": [keep]}}}
        path = provision.LIBS / "deps.json"
        path.write_text(json.dumps(graph))
        before = path.stat().st_mtime_ns

        with contextlib.redirect_stdout(io.StringIO()):
            provision.cmd_reclaim(None)

        self.assertEqual(path.stat().st_mtime_ns, before)


class DebrisTests(StoreTestCase):
    """`reclaim --debris` frees only the tier that nothing references, and it
    never touches the graph."""

    def test_debris_removes_only_the_unadvertised_tier_and_the_stale_reports(self):
        linked, advertised, debris = "linked-1.0-aaaa", "adver-2.0-bbbb", "orphan-3.0-cccc"
        for d in (linked, advertised, debris):
            (provision.STORE / d).mkdir()
        farm = provision.FARMS / "f1"
        farm.mkdir(parents=True)
        os.symlink(f"{provision.LIBS}/store/{linked}/pkg", farm / "pkg-link")
        # `advertised` has a graph node and no farm link: a pre-fetched package,
        # and the debris pass must keep it.
        graph = {"version": 2, "nodes": {advertised: {"name": "adver"}}, "by_name": {"python": {"adver": [advertised]}}}
        path = provision.LIBS / "deps.json"
        path.write_text(json.dumps(graph))
        before = path.stat().st_mtime_ns
        download = provision.LIBS / ".inflexa-download"
        download.mkdir()
        (download / "acquire-4242-x.json").write_text("{}")
        (download / "catalog.tmp").write_text("")

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_reclaim(SimpleNamespace(debris=True)), 0)

        self.assertTrue((provision.STORE / linked).is_dir())
        self.assertTrue((provision.STORE / advertised).is_dir())
        self.assertFalse((provision.STORE / debris).exists())
        self.assertFalse((download / "acquire-4242-x.json").exists())
        self.assertTrue((download / "catalog.tmp").exists())
        self.assertEqual(path.stat().st_mtime_ns, before)

    def test_debris_removes_a_stale_source_report(self):
        download = provision.LIBS / ".inflexa-download"
        download.mkdir()
        (download / "source-4242-0a1b2c.json").write_text("{}")
        (download / "catalog.tmp").write_text("")

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_reclaim(SimpleNamespace(debris=True)), 0)

        self.assertFalse((download / "source-4242-0a1b2c.json").exists())
        self.assertTrue((download / "catalog.tmp").exists())

    def test_debris_prunes_no_dangling_node(self):
        # A node whose directory is gone is the full reclaim's work: the debris
        # pass narrows to removals, thus the graph file stays byte-identical.
        ghost = "ghost-1.0-dddd"
        graph = {"version": 2, "nodes": {ghost: {"name": "ghost"}}, "by_name": {"python": {"ghost": [ghost]}}}
        path = provision.LIBS / "deps.json"
        path.write_text(json.dumps(graph))
        before = path.stat().st_mtime_ns

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_reclaim(SimpleNamespace(debris=True)), 0)

        self.assertEqual(path.stat().st_mtime_ns, before)
        self.assertEqual(json.loads(path.read_text())["nodes"], {ghost: {"name": "ghost"}})


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
    """The acquire spec grammar, the location refusals, and the manifest shapes."""

    def test_a_spec_parses_through_the_twin(self):
        self.assertEqual(package_identity.parse_query("python:numpy==1.26.4"),
                         package_identity.PackageQuery("numpy", "python", "1.26.4"))
        self.assertEqual(package_identity.parse_query("r:limma"),
                         package_identity.PackageQuery("limma", "r", None))
        self.assertIsNone(package_identity.parse_query("igraph").track)
        # The dotted R spelling survives the parse, because `library()` is
        # case-sensitive and the dot is part of the name.
        self.assertEqual(package_identity.parse_query("r:GO.db==3.21.0"),
                         package_identity.PackageQuery("GO.db", "r", "3.21.0"))

    def test_the_refusal_of_an_off_index_spec(self):
        # Naming a package is permitted.
        for good in ("numpy", "python:scipy==1.11.4", "r:DESeq2"):
            package_identity.parse_query(good)
        # Naming a location — a URL or a local path — refuses at the parse.
        for bad in ("git+https://github.com/x/y", "./dist/pkg", "~/pkg"):
            with self.assertRaises(package_identity.QueryError, msg=bad) as caught:
                package_identity.parse_query(bad)
            self.assertTrue(provision.refusal_reason(caught.exception), bad)
        # A slash names the github or git form, and those tracks are
        # catalog-only.
        with self.assertRaises(package_identity.QueryError) as caught:
            package_identity.parse_query("owner/repo")
        self.assertIn("catalog-only", provision.refusal_reason(caught.exception))
        # An artifact file is a legal NAME by the grammar. The index policy of
        # the provisioner refuses it, because a file name carries no hash.
        for artifact in ("pkg-1.0.tar.gz", "pkg-1.0.zip", "pkg-1.0.whl"):
            reason = provision.reject_off_index(package_identity.parse_query(artifact))
            self.assertIn("artifact file", reason or "", artifact)

    def _location_reason(self, entry: str) -> str:
        with self.assertRaises(package_identity.QueryError, msg=entry) as caught:
            package_identity.parse_query(entry)
        self.assertEqual(caught.exception.type, "location", entry)
        return provision.refusal_reason(caught.exception)

    def test_the_refusal_classifies_the_body_after_the_prefix(self):
        # `parse_query` refuses a location before it reads the prefix, thus the
        # entry still carries `python:`. A classification over the whole entry
        # reads the colon form as `owner/repo` and gives the git-track reason
        # for a local path.
        for path in ("python:./vendor/pkg", "r:~/pkg", "python:/mnt/libs/pkg"):
            self.assertIn("not a package request", self._location_reason(path), path)

    def test_a_url_refuses_as_a_location_whatever_its_suffix(self):
        # A URL carries a scheme. The artifact rule reads the suffix alone,
        # thus it claimed every wheel URL before the scheme was tested.
        for url in ("https://x/y.whl", "https://x/y.tar.gz", "git+https://github.com/x/y"):
            self.assertIn("not a package request", self._location_reason(url), url)

    def test_a_repository_form_still_names_the_catalog_only_tracks(self):
        self.assertIn("catalog-only", self._location_reason("owner/repo"))
        self.assertIn("artifact file", self._location_reason("dist/pkg-1.0.whl"))
        self.assertIsNone(provision.reject_off_index(package_identity.parse_query("numpy")))

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

    def test_the_resolve_rides_the_pool_pins_as_constraints(self):
        """An add reuses a held pin whenever its ranges permit it. The
        compile call must carry a constraints file with the shelf-head
        pins, or a blind resolve mints a needless second pin."""
        graph = {"version": 2,
                 "nodes": {"jinja2-3.0.3-aaaa": {"name": "jinja2",
                                                 "version": "3.0.3",
                                                 "track": "python"}},
                 "by_name": {"python": {"jinja2": ["jinja2-3.0.3-aaaa"]}}}
        (provision.LIBS / "deps.json").write_text(json.dumps(graph))
        self.compile_by_input = {"foo": FOO_1}
        self.install_tree = dict(FOO_1_TREE)

        code, report = self._acquire(["python:foo"])

        self.assertEqual(code, 0)
        self.assertEqual(report["outcomes"][0]["outcome"], "acquired")
        compiles = [argv for argv in self.calls
                    if argv[0] == "uv" and "compile" in argv]
        self.assertTrue(compiles)
        argv = compiles[0]
        self.assertIn("--constraint", argv)
        constraints = Path(argv[argv.index("--constraint") + 1]).read_text()
        self.assertIn("jinja2==3.0.3", constraints)

    def test_a_conflicting_constraint_set_drops_and_the_resolve_runs_fresh(self):
        """A true conflict must not refuse the add. The constrained resolve
        fails, the constraints drop, and the pin lands — the committed-lock
        pattern of the catalog build."""
        graph = {"version": 2,
                 "nodes": {"jinja2-3.0.3-aaaa": {"name": "jinja2",
                                                 "version": "3.0.3",
                                                 "track": "python"}},
                 "by_name": {"python": {"jinja2": ["jinja2-3.0.3-aaaa"]}}}
        (provision.LIBS / "deps.json").write_text(json.dumps(graph))
        self.compile_by_input = {"foo": FOO_1}
        self.install_tree = dict(FOO_1_TREE)
        inner = provision.subprocess.run

        def constrained_fails(cmd, *args, **kwargs):
            argv = list(cmd)
            if argv[0] == "uv" and "compile" in argv and "--constraint" in argv:
                self.calls.append(argv)
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr="jinja2 versions are in conflict")
            return inner(cmd, *args, **kwargs)
        provision.subprocess.run = constrained_fails

        code, report = self._acquire(["python:foo"])

        self.assertEqual(code, 0)
        self.assertEqual(report["outcomes"][0]["outcome"], "acquired")
        compiles = [argv for argv in self.calls
                    if argv[0] == "uv" and "compile" in argv]
        self.assertEqual(len(compiles), 2)
        self.assertIn("--constraint", compiles[0])
        self.assertNotIn("--constraint", compiles[1])

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
        # The candidates are the two IDENTITIES, thus the host quotes one of
        # them back at the user and never re-derives a name.
        self.assertEqual(outcome["candidates"], ["python:igraph", "r:igraph"])
        # Nothing installed: the host asks the user first.
        self.assertEqual(list(provision.STORE.iterdir()), [])

    @unittest.skipIf(FIXTURE_CASES is None, FIXTURE_SKIP_REASON)
    def test_the_emitted_both_hit_equals_the_shared_fixture(self):
        # The cli reads the same case through its own report schema. One wire
        # shape binds the two sides, thus a change here fails there.
        with unittest.mock.patch.object(provision, "python_index_holds",
                                        return_value=True), \
                unittest.mock.patch.object(provision, "r_repos_hold",
                                           return_value={"igraph": True}):
            _code, report = self._acquire(["igraph"])

        self.assertEqual(report["outcomes"][0], FIXTURE_CASES["both_hit_report"])

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
                    outcome = provision.acquire_python_spec(
                        package_identity.parse_query(spec), spec)
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
            outcome = provision.acquire_python_spec(
                package_identity.parse_query("python:bar"), "python:bar")
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

    def test_reclaim_keeps_a_graph_advertised_directory_with_no_farm_link(self):
        """A locally acquired package holds no farm link until a run links
        it, and an edge of a surviving node must keep its target. Thus a
        graph node protects a directory exactly as a farm link does, and
        only the tier that nothing references leaves the pool."""
        advertised = provision.STORE / "adver-2.0-bbbb"
        orphan = provision.STORE / "orphan-3.0-cccc"
        for d in (advertised, orphan):
            (d / "mod").mkdir(parents=True)
        graph = {"version": 2, "nodes": {advertised.name: {"name": "adver"}},
                 "by_name": {"python": {"adver": [advertised.name]}}}
        (provision.LIBS / "deps.json").write_text(json.dumps(graph))

        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_reclaim(SimpleNamespace()), 0)

        self.assertTrue(advertised.is_dir())
        self.assertFalse(orphan.exists())

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
        address = package_identity.address(package_identity.python_identity(name))
        store_dir = provision.STORE / f"{address}-{version}-0000000000000000"
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
        # The DIRECTORY carries the address, exactly as the store does:
        # `GO.db` addresses as `go-db`. The DESCRIPTION carries the identity.
        address = package_identity.address(package_identity.r_identity(name))
        store_dir = provision.STORE / f"{address}-{version}-0000000000000000"
        inner = store_dir / name
        (inner / "R").mkdir(parents=True)
        (inner / "DESCRIPTION").write_text(f"Package: {name}\nVersion: {version}\n")
        return store_dir

    @staticmethod
    def _stub_r_dcf() -> None:
        """Stand in for the one Rscript read.dcf call, with no fields."""
        def fake(cmd, *args, **kwargs):
            lines = "".join(f"{path}\t\n" for path in kwargs["input"].splitlines())
            return SimpleNamespace(returncode=0, stdout=lines, stderr="")

        provision.subprocess.run = fake

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

    def test_an_r_node_carries_its_identity_name_and_its_dcf_edges(self):
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
        self.assertNotIn("r_dir", node)
        self.assertEqual(node["name"], "myRpkg")
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

        # The R shelf keys the DESCRIPTION spelling, thus the key is `myRpkg`
        # and never the folded directory name.
        self.assertEqual(graph["by_name"]["r"]["myRpkg"],
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

    # --- The identity rule of each track -------------------------------------

    def test_an_r_node_keeps_its_description_spelling(self):
        """The Python `decoupler` and the R `decoupleR` fold onto one name.
        The R node keys the DESCRIPTION spelling, thus the two tracks key
        apart and a lookup of either name reaches one track."""
        pkg = self._r_store_dir("decoupleR", "2.17.0")
        self._stub_r_dcf()

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [pkg])

        self.assertEqual(pkg.name, "decoupler-2.17.0-0000000000000000")
        node = graph["nodes"][pkg.name]
        self.assertEqual(node["name"], "decoupleR")
        self.assertNotIn("r_dir", node)
        self.assertIn("decoupleR", graph["by_name"]["r"])
        self.assertNotIn("decoupler", graph["by_name"]["r"])

    def test_a_python_node_keeps_the_pep_503_form(self):
        alpha = self._python_store_dir("Decoupler", "2.2.0", [])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [alpha])

        self.assertEqual(graph["nodes"][alpha.name]["name"], "decoupler")
        self.assertIn("decoupler", graph["by_name"]["python"])

    def test_a_go_db_directory_addresses_with_a_hyphen(self):
        """The directory carries the ADDRESS and the DESCRIPTION carries the
        identity. The version strips against the address, thus a dotted R name
        still reads its version, and the inner directory keeps the dot."""
        pkg = self._r_store_dir("GO.db", "3.21.0")
        self._stub_r_dcf()

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [pkg])

        identity = package_identity.r_identity("GO.db")
        self.assertEqual(package_identity.address(identity), "go-db")
        self.assertEqual(package_identity.key(identity), "r:GO.db")
        self.assertEqual(pkg.name, "go-db-3.21.0-0000000000000000")
        self.assertTrue((pkg / "GO.db" / "DESCRIPTION").is_file())
        node = graph["nodes"][pkg.name]
        self.assertEqual(node["version"], "3.21.0")
        self.assertEqual(node["name"], "GO.db")
        self.assertIn("GO.db", graph["by_name"]["r"])

    def test_a_two_spelling_pair_does_not_stop_the_build(self):
        """`biomaRt` and `biomart` are the legitimate state of the two tracks
        after the fix. The gate must pass them."""
        nodes = {"biomart-2.64.0-aaaa": {"track": "r", "name": "biomaRt",
                                         "version": "2.64.0", "edges": []},
                 "biomart-0.9.2-bbbb": {"track": "python", "name": "biomart",
                                        "version": "0.9.2", "edges": []}}

        with contextlib.redirect_stdout(io.StringIO()) as buf:
            emit_deps.gate(nodes)

        self.assertNotIn("biomaRt", buf.getvalue())

    def test_a_same_spelling_both_track_name_is_reported(self):
        nodes = {"igraph-2.1.4-aaaa": {"track": "r", "name": "igraph",
                                       "version": "2.1.4", "edges": []},
                 "igraph-0.11.9-bbbb": {"track": "python", "name": "igraph",
                                        "version": "0.11.9", "edges": []}}

        with contextlib.redirect_stdout(io.StringIO()) as buf:
            emit_deps.gate(nodes)

        self.assertIn("igraph", buf.getvalue())
        self.assertIn("python:<name>", buf.getvalue())

    def test_the_graph_carries_version_2(self):
        alpha = self._python_store_dir("alpha", "1.0", [])

        with contextlib.redirect_stdout(io.StringIO()):
            graph = emit_deps.append_store_dirs(provision.LIBS, [alpha])

        self.assertEqual(graph["version"], 2)
        self.assertEqual(json.loads((provision.LIBS / "deps.json").read_text())["version"], 2)
        # Version 2 holds one name per node. `r_dir` was a second copy of it.
        self.assertTrue(all("r_dir" not in node for node in graph["nodes"].values()))

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
    return {"python": {package_identity.python_identity(name).name for name in inventory["python"]},
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


class ImportNameTests(unittest.TestCase):
    """import_names feeds the load check, thus junk entries must not pass.

    A wheel can record an unimportable entry beside its modules: a `-stubs`
    directory, a stray `site-packages`, a path with a slash. The load check
    imports each recorded name, and one junk name fails a usable package.
    """

    class _Dist:
        def __init__(self, top_level):
            self._top = top_level

        def read_text(self, name):
            if name == "top_level.txt":
                return self._top
            raise OSError(name)

    def test_recorded_junk_names_are_filtered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "wrapt").mkdir()
            (root / "wrapt-stubs").mkdir()
            dist = self._Dist("wrapt\nwrapt-stubs\nsite-packages\nnvidia/cusparselt\n")
            self.assertEqual(emit_deps.import_names(root, dist), ["wrapt"])

    def test_recorded_names_off_the_disk_fall_to_the_walk(self):
        # biom-format records build/ci/images/wheelhouse and ships only
        # biom/. A record whose whole claim misses the disk must not stand.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "biom").mkdir()
            dist = self._Dist("build\nci\nimages\nwheelhouse\n")
            self.assertEqual(emit_deps.import_names(root, dist), ["biom"])

    def test_walked_junk_names_are_filtered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "good_pkg").mkdir()
            (root / "bad-stubs").mkdir()
            (root / "mod.py").write_text("")
            self.assertEqual(emit_deps.import_names(root, self._Dist(None)),
                             ["good_pkg", "mod"])


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


class BuildGithubTokenGateTests(StoreTestCase):
    """A github manifest refuses without the token, before any track runs."""

    def test_a_github_manifest_without_the_token_refuses_early(self):
        args = SimpleNamespace(manifest=str(self.root / "m.yaml"),
                               lock=None, farm="catalog")
        manifest = {"r": {"github": ["owner/widget"]}}
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=manifest), \
                unittest.mock.patch.dict(os.environ), \
                contextlib.redirect_stdout(io.StringIO()):
            os.environ.pop("GITHUB_PAT", None)
            with self.assertRaises(SystemExit) as ctx:
                provision.cmd_build(args)
        self.assertIn("GITHUB_PAT", str(ctx.exception))
        self.assertIn("60", str(ctx.exception))
        # The refusal is early: no track ran, and no farm published.
        self.assertEqual(self.calls, [])
        self.assertFalse((provision.FARMS / "catalog").exists())


class BuildGithubPakTests(StoreTestCase):
    """The github stage installs through pak, the same resolver as the bulk."""

    def test_the_github_install_runs_through_pak(self):
        recorded: list[list[str]] = []

        def record(cmd, *args, **kwargs):
            recorded.append(list(cmd))
            return SimpleNamespace(returncode=0, stdout="4.6.0", stderr="")

        args = SimpleNamespace(manifest=str(self.root / "m.yaml"),
                               lock=None, farm="catalog")
        manifest = {"r": {"github": ["owner/widget"]}}
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=manifest), \
                unittest.mock.patch.object(provision.subprocess, "run", record), \
                unittest.mock.patch.dict(os.environ, {"GITHUB_PAT": "t"}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_build(args), 0)

        installs = [argv for argv in recorded
                    if argv[:1] == ["R"] and any("owner/widget" in a for a in argv)]
        self.assertEqual(len(installs), 1)
        expr = next(a for a in installs[0] if "owner/widget" in a)
        self.assertIn("pak::pkg_install('owner/widget'", expr)
        self.assertNotIn("remotes::install_github", expr)

    def test_a_failed_github_install_runs_a_second_attempt(self):
        # A pinned CDN edge can sour mid-run, thus one retry heals a transient
        # download fault from the pak cache.
        recorded: list[list[str]] = []

        def record(cmd, *args, **kwargs):
            argv = list(cmd)
            recorded.append(argv)
            rc = 1 if argv[:1] == ["R"] else 0
            return SimpleNamespace(returncode=rc, stdout="4.6.0", stderr="")

        args = SimpleNamespace(manifest=str(self.root / "m.yaml"),
                               lock=None, farm="catalog")
        manifest = {"r": {"github": ["owner/widget"]}}
        with unittest.mock.patch.object(provision, "load_manifest",
                                        return_value=manifest), \
                unittest.mock.patch.object(provision.subprocess, "run", record), \
                unittest.mock.patch.dict(os.environ, {"GITHUB_PAT": "t"}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_build(args), 0)

        installs = [argv for argv in recorded
                    if argv[:1] == ["R"] and any("owner/widget" in a for a in argv)]
        self.assertEqual(len(installs), 2)


class REntryRequestedTests(unittest.TestCase):
    """The requested flag of a farm-lock entry, per track vocabulary."""

    R_NAMES = {"cran": ["ggplot2"], "bioconductor": ["limma"], "git": [],
               "github": ["mojaveazure/seurat-disk", "kharchenkolab/numbat"]}

    def test_a_github_package_matches_its_repo_tail(self):
        self.assertTrue(provision.r_entry_requested("SeuratDisk", self.R_NAMES))
        self.assertTrue(provision.r_entry_requested("numbat", self.R_NAMES))

    def test_a_bulk_name_matches_exactly(self):
        self.assertTrue(provision.r_entry_requested("ggplot2", self.R_NAMES))
        self.assertTrue(provision.r_entry_requested("limma", self.R_NAMES))

    def test_a_transitive_dependency_is_not_requested(self):
        self.assertFalse(provision.r_entry_requested("GenomicRanges", self.R_NAMES))


class CarryHeldREntriesTests(StoreTestCase):
    """The pool fallback: a failed install keeps the held farm entry."""

    def _held(self, key: str, inner: str) -> Path:
        d = provision.STORE / key
        (d / inner).mkdir(parents=True)
        return d

    @staticmethod
    def _entry(name: str, track: str, store_dir: str, requested: bool) -> dict:
        return {"name": name, "version": "1.0", "track": track,
                "store_dir": store_dir, "requested": requested}

    NO_R = {"cran": [], "bioconductor": [], "github": []}
    NO_WANT = {"cran": [], "bioconductor": [], "git": [], "github": []}

    def test_a_failed_github_install_keeps_the_held_pin(self):
        held = self._held("projectils-3.0.0-00000000000000aa", "ProjecTILs")
        old = {"packages": [self._entry("ProjecTILs", "github", held.name, True)]}
        wanted = {**self.NO_WANT, "github": ["carmonalab/ProjecTILs"]}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R), wanted,
                                              {"nodes": {}})

        self.assertEqual(kept, [("github", "ProjecTILs", held, True)])

    def test_a_bulk_failure_keeps_the_reachable_dependency(self):
        root = self._held("flowcore-1.0-00000000000000bb", "flowCore")
        dep = self._held("cytolib-1.0-00000000000000cc", "cytolib")
        old = {"packages": [
            self._entry("flowCore", "bioconductor", root.name, True),
            self._entry("cytolib", "bioconductor", dep.name, False),
        ]}
        wanted = {**self.NO_WANT, "bioconductor": ["flowCore"]}
        graph = {"nodes": {root.name: {"edges": [dep.name]},
                           dep.name: {"edges": []}}}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R), wanted, graph)

        self.assertEqual(sorted(kept), sorted([
            ("bioconductor", "flowCore", root, True),
            ("bioconductor", "cytolib", dep, False),
        ]))

    def test_a_removed_manifest_entry_does_not_carry(self):
        held = self._held("widget-1.0-00000000000000dd", "widget")
        old = {"packages": [self._entry("widget", "github", held.name, True)]}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R),
                                              dict(self.NO_WANT), {"nodes": {}})

        self.assertEqual(kept, [])

    def test_an_unreachable_dependency_does_not_carry(self):
        dep = self._held("cytolib-1.0-00000000000000ee", "cytolib")
        old = {"packages": [self._entry("cytolib", "bioconductor", dep.name, False)]}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R),
                                              dict(self.NO_WANT), {"nodes": {}})

        self.assertEqual(kept, [])

    def test_a_staged_name_wins_over_the_held_copy(self):
        held = self._held("numbat-1.0-00000000000000ff", "numbat")
        fresh = self._held("numbat-1.1-00000000000000f0", "numbat")
        old = {"packages": [self._entry("numbat", "github", held.name, True)]}
        stored = {**self.NO_R, "github": [("numbat", fresh)]}
        wanted = {**self.NO_WANT, "github": ["kharchenkolab/numbat"]}

        kept = provision.carry_held_r_entries(old, stored, wanted, {"nodes": {}})

        self.assertEqual(kept, [])

    def test_a_stale_false_flag_still_carries_a_wanted_github_entry(self):
        # Locks from before the requested-flag repair mark every github entry
        # as a dependency. The manifest match promotes such an entry, thus the
        # fallback works across the transition.
        held = self._held("seuratdisk-0.0.9-00000000000000a1", "SeuratDisk")
        old = {"packages": [self._entry("SeuratDisk", "github", held.name, False)]}
        wanted = {**self.NO_WANT, "github": ["mojaveazure/seurat-disk"]}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R), wanted, {"nodes": {}})

        self.assertEqual(kept, [("github", "SeuratDisk", held, True)])

    def test_a_reclaimed_store_directory_does_not_carry(self):
        old = {"packages": [self._entry("gone", "cran", "gone-1.0-0000000000000000", True)]}
        wanted = {**self.NO_WANT, "cran": ["gone"]}

        kept = provision.carry_held_r_entries(old, dict(self.NO_R), wanted,
                                              {"nodes": {}})

        self.assertEqual(kept, [])



class StageRSubtreesTests(StoreTestCase):
    """One store directory gives one lock entry and one farm link, whatever
    the number of subtrees that pak installed it into."""

    R_NAMES = {"cran": ["dplyr"], "bioconductor": [], "git": [],
               "github": ["AlmogAngel/xCell2"]}

    def test_a_reinstalled_dependency_records_once_under_the_bulk(self):
        stage_root = provision.STORE / ".staging-r"
        # pak installs the github closure again: dplyr and abind land in the
        # github library beside the bulk copies. dplyr is the same version,
        # thus the same bytes; abind is a newer version, thus a new address.
        self._make_r_pkg(stage_root / "r" / "cran" / "dplyr", "dplyr", "1.2.1")
        self._make_r_pkg(stage_root / "r" / "cran" / "abind", "abind", "1.4-8")
        self._make_r_pkg(stage_root / "r" / "github" / "dplyr", "dplyr", "1.2.1")
        self._make_r_pkg(stage_root / "r" / "github" / "abind", "abind", "1.5-0")
        self._make_r_pkg(stage_root / "r" / "github" / "xCell2", "xCell2", "1.2.3")

        stored, packages = provision.stage_r_subtrees(stage_root, self.R_NAMES)

        self.assertEqual([name for name, _ in stored["cran"]], ["abind", "dplyr"])
        self.assertEqual(stored["bioconductor"], [])
        self.assertEqual([name for name, _ in stored["github"]], ["abind", "xCell2"])
        self.assertEqual([(e["track"], e["name"], e["version"], e["requested"]) for e in packages],
                         [("cran", "abind", "1.4-8", False),
                          ("cran", "dplyr", "1.2.1", True),
                          ("github", "abind", "1.5-0", False),
                          ("github", "xCell2", "1.2.3", True)])
        dirs = [e["store_dir"] for e in packages]
        self.assertEqual(len(dirs), len(set(dirs)))
        # The github copy of dplyr went to the store and came back as the
        # bulk directory, thus the pool holds one dplyr.
        self.assertEqual(sum(1 for d in provision.STORE.iterdir() if d.name.startswith("dplyr-")), 1)

    def test_an_absent_subtree_records_nothing(self):
        stage_root = provision.STORE / ".staging-r"
        self._make_r_pkg(stage_root / "r" / "bioconductor" / "limma", "limma", "3.68.5")

        stored, packages = provision.stage_r_subtrees(stage_root, self.R_NAMES)

        self.assertEqual({sub: [name for name, _ in pkgs] for sub, pkgs in stored.items()},
                         {"cran": [], "bioconductor": ["limma"], "github": []})
        self.assertEqual([e["name"] for e in packages], ["limma"])


class SourcePinQualifierTests(StoreTestCase):
    """The qualifier rides the pin marker alone; the directory name keeps the
    bare version, and the marker match is exact in both directions."""

    SHA = "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e"

    @staticmethod
    def _held(name: str, version: str, marker: str, tag: str = "0" * 16) -> Path:
        store_dir = provision.STORE / f"{name}-{version}-{tag}"
        (store_dir / name).mkdir(parents=True)
        (store_dir / name / "DESCRIPTION").write_text(
            f"Package: {name}\nVersion: {version}\n")
        (store_dir / name / provision.PIN_MARKER).write_text(marker + "\n")
        return store_dir

    def test_an_index_pin_never_matches_a_source_build(self):
        self._held("foo", "1.0", f"foo==1.0@git:{self.SHA}")

        self.assertIsNone(provision.find_stored("foo==1.0", "python"))
        self.assertEqual(provision.find_stored(f"foo==1.0@git:{self.SHA}", "python").name,
                         "foo-1.0-0000000000000000")

    def test_a_source_pin_never_matches_an_index_build(self):
        self._held("foo", "1.0", "foo==1.0")

        self.assertEqual(provision.find_stored("foo==1.0", "python").name,
                         "foo-1.0-0000000000000000")
        self.assertIsNone(provision.find_stored(f"foo==1.0@git:{self.SHA}", "python"))

    def test_two_qualifiers_of_one_version_globe_together_and_match_apart(self):
        # The directory keeps the bare version, thus the glob of either
        # qualified pin reaches both directories and the marker text decides.
        self._held("foo", "1.0", f"foo==1.0@git:{self.SHA}", tag="a" * 16)
        self._held("foo", "1.0", "foo==1.0@tree:9b1deb4d3b7d4bad", tag="b" * 16)

        git = provision.find_stored(f"foo==1.0@git:{self.SHA}", "python")
        tree = provision.find_stored("foo==1.0@tree:9b1deb4d3b7d4bad", "python")
        self.assertNotEqual(git, tree)
        self.assertEqual(len(list(provision.STORE.glob("foo-1.0-*"))), 2)


class AcquireSourceRunTests(StoreTestCase):
    """The acquire-source run: the script contract, the dependency resolve,
    the qualified pin, the staged nodes, and the report. The build script runs
    for real over fixture trees; every tool it would call is the fake above."""

    SHA = "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e"

    def _snapshot(self, name: str = "src") -> Path:
        snapshot = self.root / "snapshot" / name
        snapshot.mkdir(parents=True)
        return snapshot

    def _r_source(self, imports: str = "Rcpp, utils", built_name: str | None = None,
                  name: str = "SeedMatchR", version: str = "2.0.0") -> Path:
        snapshot = self._snapshot("r")
        pkg = self._make_r_pkg(snapshot / "built" / (built_name or name), name, version)
        (pkg / "DESCRIPTION").write_text(
            f"Package: {name}\nVersion: {version}\nTitle: t\nImports: {imports}\n")
        # The root DESCRIPTION is the tree pak resolves, and the mark the run
        # reads to know the R track before the script runs.
        (snapshot / "DESCRIPTION").write_text(
            f"Package: {name}\nVersion: {version}\nTitle: t\nImports: {imports}\n")
        self.dcf_fields = {name: imports}
        self.pak_locks[str(snapshot)] = {
            "packages": [{"package": "Rcpp", "version": "1.0.13"},
                         {"package": name, "version": version}]}
        return snapshot

    def _script(self, text: str) -> Path:
        script = self.root / "build.sh"
        script.write_text(text)
        return script

    def _copy_script(self, snapshot: Path, out: Path, *names: str) -> Path:
        lines = ["#!/bin/sh", "set -e", f'mkdir -p "{out}"']
        lines += [f'cp -a "{snapshot}/built/{n}" "{out}/{n}"' for n in names]
        return self._script("\n".join(lines) + "\n")

    def _acquire_source(self, snapshot: Path, script: Path, out: Path, **kw) -> tuple[int, dict]:
        report = self.root / "report.json"
        args = SimpleNamespace(
            report=str(report), snapshot=str(snapshot), script=str(script), output=str(out),
            git_url=kw.get("git_url"), commit=kw.get("commit"),
            apt_snapshot_date=kw.get("apt_snapshot_date"),
            apt_package=kw.get("apt_package", []),
            package_dir=kw.get("package_dir"), lib_view=str(self.view))
        with contextlib.redirect_stdout(io.StringIO()):
            code = provision.cmd_acquire_source(args)
        return code, json.loads(report.read_text())

    def _git_source(self, snapshot: Path, script: Path, out: Path, **kw) -> dict:
        kw.setdefault("apt_package", ["libcurl4-openssl-dev"])
        _code, report = self._acquire_source(
            snapshot, script, out,
            git_url="https://github.com/tacazares/SeedMatchR", commit=self.SHA,
            apt_snapshot_date="20260901T093000Z", **kw)
        return report
    # --- the clean paths -----------------------------------------------------

    def test_the_clean_r_path_stores_the_root_and_resolves_its_dependencies(self):
        snapshot = self._r_source()
        out = self.root / "out"
        report = self._git_source(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        pin = f"SeedMatchR==2.0.0@git:{self.SHA}"
        outcome = report["outcomes"][0]
        self.assertEqual(outcome["pin"], pin)
        # The directory keeps the BARE version: emit_deps reads the node
        # version from the directory name, and the qualifier lives on the pin.
        self.assertRegex(outcome["store_dir"], r"^seedmatchr-2\.0\.0-[0-9a-f]{16}$")
        root = provision.STORE / outcome["store_dir"]
        self.assertEqual((root / "SeedMatchR" / provision.PIN_MARKER).read_text().strip(), pin)
        # The dependency resolved through the pak lockfile of the snapshot and
        # stored as an index package: its marker carries no qualifier.
        rcpp = next(iter(provision.STORE.glob("rcpp-1.0.13-*")))
        self.assertEqual((rcpp / "Rcpp" / provision.PIN_MARKER).read_text().strip(),
                         "Rcpp==1.0.13")
        # The staged nodes cover the root and the dependency, and the root's
        # edge lands on the dependency (utils belongs to the image).
        root_node = report["nodes"][root.name]
        self.assertEqual(root_node["edges"], [rcpp.name])
        self.assertEqual(sorted(report["nodes"]), sorted([root.name, rcpp.name]))
        self.assertEqual(sorted(outcome["installed"]), sorted([pin, "Rcpp==1.0.13"]))
        # The two-phase contract: no advertised state before the host commit.
        self.assertFalse((provision.LIBS / "deps.json").exists())
        self.assertEqual(sorted(p.name for p in provision.STORE.glob(".staging*")), [])

    def test_the_clean_python_path_resolves_the_wheel_requirements_hash_pinned(self):
        snapshot = self._snapshot("py")
        built = snapshot / "built"
        built.mkdir()
        (built / "demo-1.0-py3-none-any.whl").write_bytes(b"PK\x03\x04not a real wheel\n")
        self.root_install_tree = {
            "demo/__init__.py": "x = 1\n",
            "demo-1.0.dist-info/METADATA":
                "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\nRequires-Dist: foo\n",
            "demo-1.0.dist-info/RECORD": "demo/__init__.py,,\n"}
        self.compile_by_input = {"foo": FOO_1}
        self.install_tree = dict(FOO_1_TREE)
        out = self.root / "out"

        _code, report = self._acquire_source(
            snapshot, self._copy_script(snapshot, out, "demo-1.0-py3-none-any.whl"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "source")
        # A folder source qualifies its pin with the tree hash of the snapshot.
        tree = provision.tree_hash(snapshot)
        self.assertEqual(outcome["pin"], f"demo==1.0@tree:{tree[:16]}")
        self.assertRegex(outcome["store_dir"], r"^demo-1\.0-[0-9a-f]{16}$")
        root = provision.STORE / outcome["store_dir"]
        self.assertEqual((root / provision.PIN_MARKER).read_text().strip(), outcome["pin"])
        # The dependency installed through the hash-pinned index path.
        dep = next(iter(provision.STORE.glob("foo-1.0-*")))
        installs = [argv for argv in self.calls
                    if argv[0] == "uv" and "install" in argv and "-r" in argv]
        self.assertTrue(installs)
        self.assertIn("--require-hashes", installs[0])
        self.assertEqual(report["nodes"][root.name]["edges"], [dep.name])

    def test_the_run_pins_apt_to_the_dated_snapshot_before_the_script(self):
        snapshot = self._r_source()
        out = self.root / "out"
        pinned = self.apt_sources / provision.APT_SOURCES_FILE
        # The script refuses to run unless the pin already landed, thus the
        # pass proves the order, not only the file.
        script = self._script(
            f'#!/bin/sh\nset -e\ntest -f "{pinned}"\n'
            f'mkdir -p "{out}"\ncp -a "{snapshot}/built/SeedMatchR" "{out}/SeedMatchR"\n')

        report = self._git_source(snapshot, script, out)

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        text = pinned.read_text()
        self.assertIn(f"URIs: {provision.SNAPSHOT_ARCHIVE}/20260901T093000Z/", text)
        self.assertIn("Suites: noble noble-updates noble-backports noble-security", text)
        self.assertIn("Check-Valid-Until: no", text)
        # The live-archive sources the image shipped are gone, thus a plain
        # `apt-get update` obeys the pin alone.
        self.assertEqual(list(self.apt_sources.iterdir()), [pinned])
        self.assertFalse((self.apt_root / "etc" / "apt" / "sources.list").exists())

    def test_the_r_dependencies_install_before_the_script_and_the_record_reads_after_it(self):
        snapshot = self._r_source()
        out = self.root / "out"

        report = self._git_source(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        argvs = [argv for argv in self.calls if argv[0] in ("Rscript", "bash", "dpkg-query")]
        dep_install = next(i for i, argv in enumerate(argvs)
                           if argv[0] == "Rscript" and "install" in argv)
        script_at = next(i for i, argv in enumerate(argvs) if argv[0] == "bash")
        record_at = next(i for i, argv in enumerate(argvs) if argv[0] == "dpkg-query")
        self.assertLess(dep_install, script_at,
                        "the imports of the snapshot tree install before the script runs")
        self.assertLess(script_at, record_at,
                        "the build record reads dpkg only after the script installed")

    def test_the_script_runs_with_the_staged_r_library_alive_on_its_library_path(self):
        snapshot = self._r_source()
        out = self.root / "out"
        seen = self.root / "r-libs-user"
        # The script itself is the probe: it records the library path it ran
        # under, and it fails unless Rcpp is loadable in that library while
        # the script still runs.
        script = self._script(
            "#!/bin/sh\nset -e\n"
            f'printf \'%s\' "$R_LIBS_USER" > "{seen}"\n'
            'test -f "$R_LIBS_USER/Rcpp/DESCRIPTION"\n'
            f'mkdir -p "{out}"\ncp -a "{snapshot}/built/SeedMatchR" "{out}/SeedMatchR"\n')

        first = self._git_source(snapshot, script, out)["outcomes"][0]

        self.assertEqual(first["outcome"], "source")
        staging = provision.staging_dir("r") / "source"
        self.assertEqual(seen.read_text(), str(self.view / staging.relative_to(self.root)),
                         "the script environment carries the staged library path in the read-only view")
        # The run removed the library only after the script and the record.
        self.assertFalse(staging.exists())

        # The second run holds Rcpp in the pool, thus no fresh install happens:
        # the staged library carries it as a link to the store package, and the
        # script still finds its imports.
        second = self._git_source(snapshot, script, out)["outcomes"][0]

        self.assertEqual(second["outcome"], "source")
        staging = provision.staging_dir("r") / "source"
        self.assertEqual(seen.read_text(), str(self.view / staging.relative_to(self.root)))
        self.assertFalse(staging.exists())

    def test_the_index_build_of_the_root_name_joins_no_stage(self):
        snapshot = self._r_source()
        held = provision.STORE / "seedmatchr-2.0.0-1111111111111111"
        (held / "SeedMatchR").mkdir(parents=True)
        (held / "SeedMatchR" / "DESCRIPTION").write_text("Package: SeedMatchR\nVersion: 2.0.0\n")
        (held / "SeedMatchR" / provision.PIN_MARKER).write_text("SeedMatchR==2.0.0\n")
        out = self.root / "out"

        report = self._git_source(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "source")
        self.assertNotIn(held.name, outcome["store_dirs"])
        pins = set(outcome["installed"]) | set(outcome["reused"])
        self.assertNotIn("SeedMatchR==2.0.0", pins,
                         "the index build of the root's own name must join no stage")

    # --- the refusals ---------------------------------------------------------

    def test_a_script_that_builds_nothing_refuses_and_names_the_artifact(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script(f'#!/bin/sh\nset -e\nmkdir -p "{out}"\n')

        report = self._git_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("no artifact", outcome["reason"])
        self.assertEqual(report["nodes"], {})
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_a_script_that_installs_dependencies_refuses_the_extra_artifacts(self):
        snapshot = self._r_source()
        self._make_r_pkg(snapshot / "built" / "Rcpp", "Rcpp", "1.0.13")
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR", "Rcpp"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("more than the one root artifact", outcome["reason"])
        self.assertIn("SeedMatchR", outcome["reason"])
        self.assertIn("Rcpp", outcome["reason"])

    def test_a_dangling_edge_refuses_and_names_the_edge(self):
        snapshot = self._r_source(imports="nowheremuch")
        self.pak_locks[str(snapshot)] = {
            "packages": [{"package": "SeedMatchR", "version": "2.0.0"}]}
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("nowheremuch", outcome["reason"])
        self.assertIn("->", outcome["reason"])
        self.assertEqual(report["nodes"], {})
        self.assertFalse((provision.LIBS / "deps.json").exists())
        # The root reached the pool before the graph check: the refusal frees
        # it beside the dependency closure.
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_a_failing_script_refuses_with_its_own_output(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script('#!/bin/sh\necho "cc: error: no such source file" >&2\nexit 3\n')

        report = self._git_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("exited non-zero", outcome["reason"])
        self.assertIn("no such source file", outcome["reason"])
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_a_build_script_past_the_budget_refuses_and_frees_the_pool(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script("#!/bin/sh\nwhile true; do :; done\n")

        real_run = provision.subprocess.run

        def run_past_budget(cmd, *args, **kwargs):
            if cmd[0] == "setpriv":
                raise subprocess.TimeoutExpired(cmd="setpriv", timeout=provision.BUILD_SCRIPT_TIMEOUT_SECONDS)
            return real_run(cmd, *args, **kwargs)

        with mock.patch.object(provision.subprocess, "run", side_effect=run_past_budget):
            report = self._git_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn(str(provision.BUILD_SCRIPT_TIMEOUT_SECONDS), outcome["reason"])
        self.assertEqual(list(provision.STORE.iterdir()), [])

    def test_an_artifact_that_is_neither_track_refuses(self):
        snapshot = self._snapshot("junk")
        (snapshot / "built").mkdir()
        (snapshot / "built" / "README").write_text("not a package\n")
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "README"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("neither an installed R package", outcome["reason"])

    # --- the unprivileged run --------------------------------------------------

    def test_the_script_runs_through_setpriv_from_a_root_owned_copy(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._copy_script(snapshot, out, "SeedMatchR")

        report = self._git_source(snapshot, script, out)

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        [run] = self.script_runs
        argv = run["argv"]
        self.assertEqual(
            argv[:-1],
            ["setpriv", "--reuid=1000", "--regid=1000", "--init-groups",
             "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", "bash"])
        # The copy is a different file from the mounted script, with the same
        # bytes, and neither it nor its directory is writable by another user.
        self.assertNotEqual(argv[-1], str(script))
        self.assertEqual(run["copy_text"], script.read_text())
        self.assertEqual(run["copy_mode"], 0o755)
        self.assertEqual(run["copy_dir_mode"], 0o755)
        self.assertFalse(Path(argv[-1]).exists(), "the run removes the copy")
        self.assertEqual(run["cwd"], str(snapshot))
        self.assertEqual(run["env"]["HOME"], "/home/inflexa-build")

    KILL_SWEEP = ["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups",
                  "--", "kill", "-s", "KILL", "--", "-1"]

    def test_the_build_user_is_swept_right_after_the_script_and_before_root_reads_the_output(self):
        snapshot = self._r_source()
        out = self.root / "out"

        self._git_source(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        script_at = next(i for i, argv in enumerate(self.calls)
                         if argv[0] == "bash" and "--" not in argv)
        sweeps = [i for i, argv in enumerate(self.calls) if argv == self.KILL_SWEEP]
        self.assertEqual(len(sweeps), 1, self.calls)
        self.assertEqual(sweeps[0], script_at + 1, "the sweep is the call right after the script")
        # Root reads the artifact (dpkg-query and Rscript answer the record) only after the sweep.
        reads_after_script = [i for i, argv in enumerate(self.calls)
                              if i > script_at and argv[0] in ("dpkg-query", "Rscript")]
        self.assertTrue(reads_after_script)
        self.assertTrue(all(i > sweeps[0] for i in reads_after_script), self.calls)

    def test_the_build_user_is_swept_after_a_failed_script_too(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script("#!/bin/sh\nexit 3\n")

        report = self._git_source(snapshot, script, out)

        self.assertEqual(report["outcomes"][0]["outcome"], "refused")
        self.assertEqual(self.calls.count(self.KILL_SWEEP), 1)

    def test_the_build_user_is_swept_after_a_timeout_and_the_refusal_stays(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script("#!/bin/sh\nexit 0\n")
        swept: list[list[str]] = []
        real_run = provision.subprocess.run

        def run_past_budget(cmd, *args, **kwargs):
            if cmd[0] == "setpriv" and "kill" in cmd:
                swept.append(list(cmd))
                raise subprocess.TimeoutExpired(cmd="setpriv", timeout=1)
            if cmd[0] == "setpriv":
                raise subprocess.TimeoutExpired(cmd="setpriv", timeout=provision.BUILD_SCRIPT_TIMEOUT_SECONDS)
            return real_run(cmd, *args, **kwargs)

        with mock.patch.object(provision.subprocess, "run", side_effect=run_past_budget):
            report = self._git_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn(str(provision.BUILD_SCRIPT_TIMEOUT_SECONDS), outcome["reason"])
        self.assertEqual(swept, [self.KILL_SWEEP])

    def test_the_store_parent_is_hidden_and_the_output_is_handed_over_before_the_script(self):
        snapshot = self._r_source()
        out = self.root / "out"

        self._git_source(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out)

        heads = [argv[0] for argv in self.calls]
        hide = self.calls[heads.index("hide-store-parent")]
        chown = self.calls[heads.index("give-to-build-user")]
        self.assertEqual(hide[1], str(provision.LIBS.parent))
        self.assertEqual(chown[1], str(out))
        self.assertTrue(out.is_dir(), "the run makes the output directory")
        self.assertLess(heads.index("hide-store-parent"), heads.index("setpriv"))
        self.assertLess(heads.index("give-to-build-user"), heads.index("setpriv"))

    def test_a_store_parent_of_the_root_directory_refuses(self):
        provision.LIBS = Path("/libs")

        with self.assertRaisesRegex(provision.SourceBuildError, "directly under /"):
            provision.store_parent()

    def test_the_r_library_links_are_relative_and_resolve_through_the_view(self):
        snapshot = self._r_source()
        out = self.root / "out"
        seen = self.root / "link-target"
        script = self._script(
            "#!/bin/sh\nset -e\n"
            f'readlink "$R_LIBS_USER/Rcpp" > "{seen}"\n'
            'test -f "$R_LIBS_USER/Rcpp/DESCRIPTION"\n'
            f'mkdir -p "{out}"\ncp -a "{snapshot}/built/SeedMatchR" "{out}/SeedMatchR"\n')

        report = self._git_source(snapshot, script, out)

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        target = seen.read_text().strip()
        self.assertFalse(os.path.isabs(target), target)
        self.assertRegex(target, r"^\.\./\.\./rcpp-1\.0\.13-[0-9a-f]{16}/Rcpp$")

    def test_the_script_output_goes_to_a_file_and_the_refusal_reads_its_tail(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._script(
            "#!/bin/sh\nyes 'compiler output line of the build' | head -n 100000\n"
            "echo boom >&2\nexit 3\n")

        report = self._git_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("boom", outcome["reason"])
        self.assertLess(len(outcome["reason"]), 1000)
        [run] = self.script_runs
        self.assertIsNot(run["stdout"], subprocess.PIPE)
        self.assertFalse(run["capture_output"])

    def test_the_log_tail_reads_at_most_the_tail_bytes(self):
        log = self.root / "big.log"
        log.write_bytes(b"first line\n" + b"filler\n" * 5000 + b"last line\n")

        tail = provision.log_tail(log, lines=2)

        self.assertEqual(tail, "filler\nlast line")

    # --- the apt install ---------------------------------------------------------

    def test_the_plan_apt_packages_install_as_root_after_the_pin_and_before_the_script(self):
        snapshot = self._r_source()
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out,
            apt_package=["libcurl4-openssl-dev", "g++-13"])

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        apt = [argv for argv in self.calls if argv[0] == "apt-get"]
        self.assertEqual(apt, [
            ["apt-get", "update"],
            ["apt-get", "install", "-y", "--no-install-recommends",
             "libcurl4-openssl-dev", "g++-13"]])
        heads = [argv[0] for argv in self.calls]
        self.assertLess(heads.index("apt-get"), heads.index("setpriv"))
        self.assertEqual(list(self.apt_sources.iterdir()),
                         [self.apt_sources / provision.APT_SOURCES_FILE])

    def test_a_plan_without_apt_packages_runs_no_apt_get(self):
        snapshot = self._r_source()
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out, apt_package=[])

        self.assertEqual(report["outcomes"][0]["outcome"], "source")
        self.assertNotIn("apt-get", [argv[0] for argv in self.calls])

    def test_an_apt_option_is_not_a_package_name(self):
        snapshot = self._r_source()
        out = self.root / "out"
        option = "-oAPT::Get::AllowUnauthenticated=true"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out,
            apt_package=["libcurl4-openssl-dev", option])

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn(option, outcome["reason"])
        self.assertIn("not a Debian package name", outcome["reason"])
        heads = [argv[0] for argv in self.calls]
        self.assertNotIn("apt-get", heads)
        self.assertNotIn("setpriv", heads)
        self.assertNotIn("Rscript", heads)

    def _parser_argv(self, snapshot: Path, script: Path, out: Path, *apt_words: str) -> list[str]:
        return ["provision", "acquire-source",
                "--report", str(self.root / "report.json"),
                "--snapshot", str(snapshot), "--script", str(script),
                "--lib-view", str(self.view), "--output", str(out),
                "--apt-snapshot-date", "20260214T093000Z", *apt_words]

    def test_a_leading_dash_apt_name_in_the_equals_form_reaches_the_refusal_through_the_real_parser(self):
        snapshot = self._r_source()
        out = self.root / "out"
        option = "-oAPT::Get::AllowUnauthenticated=true"
        argv = self._parser_argv(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out,
                                 f"--apt-package={option}")

        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            code = provision.main()

        self.assertEqual(code, 0)
        outcome = json.loads((self.root / "report.json").read_text())["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn(option, outcome["reason"])
        self.assertIn("not a Debian package name", outcome["reason"])
        self.assertNotIn("apt-get", [argv[0] for argv in self.calls])

    def test_the_separate_word_form_of_a_leading_dash_name_never_reaches_the_refusal(self):
        snapshot = self._r_source()
        out = self.root / "out"
        argv = self._parser_argv(snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out,
                                 "--apt-package", "-oAPT::Get::AllowUnauthenticated=true")

        with mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stderr(io.StringIO()) as stderr, \
                self.assertRaises(SystemExit) as exited:
            provision.main()

        self.assertEqual(exited.exception.code, 2)
        self.assertIn("expected one argument", stderr.getvalue())
        self.assertFalse((self.root / "report.json").exists())

    def test_a_failed_apt_install_refuses_with_the_tail_of_its_output(self):
        snapshot = self._r_source()
        out = self.root / "out"
        self.apt_failures["install"] = "E: Unable to locate package nosuchpkg\n"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out,
            apt_package=["nosuchpkg"])

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("apt-get install", outcome["reason"])
        self.assertIn("Unable to locate package nosuchpkg", outcome["reason"])
        self.assertNotIn("setpriv", [argv[0] for argv in self.calls])

    # --- the package directory -----------------------------------------------------

    def test_the_package_directory_feeds_the_r_resolve_and_the_record(self):
        snapshot = self._snapshot("mono")
        pkg = snapshot / "pkg"
        self._make_r_pkg(snapshot / "built" / "SeedMatchR", "SeedMatchR", "2.0.0")
        pkg.mkdir()
        (pkg / "DESCRIPTION").write_text(
            "Package: SeedMatchR\nVersion: 2.0.0\nTitle: t\nImports: Rcpp\n")
        self.dcf_fields = {"SeedMatchR": "Rcpp"}
        self.pak_locks[str(pkg)] = {
            "packages": [{"package": "Rcpp", "version": "1.0.13"},
                         {"package": "SeedMatchR", "version": "2.0.0"}]}
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "SeedMatchR"), out, package_dir="pkg")

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "source")
        resolves = [argv for argv in self.calls
                    if argv[0] == "Rscript" and argv[1:3] == ["/usr/local/bin/acquire_r.R", "resolve"]]
        self.assertEqual([argv[3] for argv in resolves], [str(pkg)])
        self.assertTrue(any(p.name.startswith("rcpp-1.0.13-") for p in provision.STORE.iterdir()))
        record = json.loads((provision.STORE / outcome["store_dir"] / "SeedMatchR"
                             / provision.BUILD_MARKER).read_text())
        self.assertEqual(record["source"]["package_dir"], "pkg")

    def test_a_package_directory_that_leaves_the_snapshot_or_holds_no_description_refuses(self):
        snapshot = self._r_source()
        outside = self.root / "outside"
        self._make_r_pkg(outside, "Evil", "1.0")
        (snapshot / "link").symlink_to(outside)
        (snapshot / "empty").mkdir()
        out = self.root / "out"
        script = self._copy_script(snapshot, out, "SeedMatchR")

        for package_dir, reason in (
                ("../etc", "no `..` segment"),
                ("sub/../../etc", "no `..` segment"),
                ("/etc", "must be relative"),
                ("link", "resolves outside the snapshot"),
                ("empty", "holds no DESCRIPTION")):
            with self.subTest(package_dir=package_dir):
                self.calls.clear()
                report = self._git_source(snapshot, script, out, package_dir=package_dir)

                outcome = report["outcomes"][0]
                self.assertEqual(outcome["outcome"], "refused")
                self.assertIn(package_dir, outcome["reason"])
                self.assertIn(reason, outcome["reason"])
                heads = [argv[0] for argv in self.calls]
                for ran in ("Rscript", "apt-get", "setpriv"):
                    self.assertNotIn(ran, heads)

    # --- the Python dependency refusal -----------------------------------------------

    def _python_source_with_two_requirements(self) -> tuple[Path, Path, Path]:
        snapshot = self._snapshot("py")
        built = snapshot / "built"
        built.mkdir()
        (built / "demo-1.0-py3-none-any.whl").write_bytes(b"PK\x03\x04\n")
        self.root_install_tree = {
            "demo/__init__.py": "x = 1\n",
            "demo-1.0.dist-info/METADATA":
                "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n"
                "Requires-Dist: foo\nRequires-Dist: bar\n"}
        out = self.root / "out"
        script = self._copy_script(snapshot, out, "demo-1.0-py3-none-any.whl")
        return snapshot, script, out

    def test_a_failed_python_dependency_refuses_and_frees_the_earlier_pin(self):
        snapshot, script, out = self._python_source_with_two_requirements()
        # `bar` sorts before `foo`: bar installs, then foo fails.
        self.compile_by_input = {"foo\nbar": FOO_1 + BAR_2}
        self.install_tree = dict(BAR_2_TREE)
        self.install_failures = {"foo==1.0": "error: no matching distribution for foo"}

        _code, report = self._acquire_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("no matching distribution for foo", outcome["reason"])
        self.assertEqual(report["nodes"], {})
        self.assertEqual(list(provision.STORE.iterdir()), [],
                         "the store directory of the first pin is gone")

    def test_a_python_dependency_without_a_hash_refuses_with_its_reason(self):
        snapshot, script, out = self._python_source_with_two_requirements()
        self.compile_by_input = {"foo\nbar": "foo==1.0\n"}

        _code, report = self._acquire_source(snapshot, script, out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "refused")
        self.assertIn("without a source hash", outcome["reason"])
        self.assertEqual(list(provision.STORE.iterdir()), [])

    # --- the identity rule -----------------------------------------------------

    def test_the_r_identity_comes_from_the_description(self):
        # The artifact directory and the repository spell their own names; the
        # DESCRIPTION alone names the package and its version.
        snapshot = self._r_source(built_name="fork-built-pkg")
        out = self.root / "out"

        report = self._git_source(
            snapshot, self._copy_script(snapshot, out, "fork-built-pkg"), out)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "source")
        self.assertEqual(outcome["name"], "SeedMatchR")
        self.assertRegex(outcome["store_dir"], r"^seedmatchr-2\.0\.0-[0-9a-f]{16}$")
        self.assertTrue((provision.STORE / outcome["store_dir"] / "SeedMatchR").is_dir())

    def test_the_python_identity_comes_from_the_dist_info(self):
        snapshot = self._snapshot("py")
        built = snapshot / "built"
        built.mkdir()
        # The wheel file name spells a different name and version than the
        # metadata; the metadata wins.
        (built / "fork-wheel-9.9-py3-none-any.whl").write_bytes(b"PK\x03\x04\n")
        self.root_install_tree = {
            "demo/__init__.py": "x = 1\n",
            "demo-1.0.dist-info/METADATA":
                "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n"}
        out = self.root / "out"

        _code, report = self._acquire_source(
            snapshot, self._copy_script(snapshot, out, "fork-wheel-9.9-py3-none-any.whl"),
            out, git_url="https://github.com/x/demo", commit=self.SHA)

        outcome = report["outcomes"][0]
        self.assertEqual(outcome["outcome"], "source")
        self.assertEqual(outcome["pin"], f"demo==1.0@git:{self.SHA}")
        self.assertTrue(outcome["store_dir"].startswith("demo-1.0-"))

    def test_a_repeat_source_build_reuses_its_own_directory(self):
        snapshot = self._r_source()
        out = self.root / "out"
        script = self._copy_script(snapshot, out, "SeedMatchR")

        first = self._git_source(snapshot, script, out)["outcomes"][0]
        second = self._git_source(snapshot, script, out)["outcomes"][0]

        self.assertEqual(first["outcome"], "source")
        self.assertEqual(second["outcome"], "source")
        self.assertEqual(second["store_dir"], first["store_dir"])
        self.assertIn(first["pin"], second["reused"])
        self.assertNotIn(first["pin"], second["installed"])
        self.assertEqual(len(list(provision.STORE.glob("seedmatchr-2.0.0-*"))), 1)
        self.assertEqual(len(list(provision.STORE.glob("rcpp-1.0.13-*"))), 1)


class BuildRecordTests(StoreTestCase):
    """The build record: the provenance that replaces the index hash of a
    source-built root, beside the pin marker and out of every hash and link."""

    SHA = "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e"

    def _run_r_source(self, **env) -> tuple[Path, Path, dict]:
        snapshot = self.root / "snapshot"
        pkg = self._make_r_pkg(snapshot / "built" / "SeedMatchR", "SeedMatchR", "2.0.0")
        (pkg / "DESCRIPTION").write_text(
            "Package: SeedMatchR\nVersion: 2.0.0\nTitle: t\n")
        self.pak_locks[str(snapshot)] = {"packages": []}
        out = self.root / "out"
        script = self.root / "build.sh"
        script.write_text(f'#!/bin/sh\nset -e\nmkdir -p "{out}"\n'
                          f'cp -a "{snapshot}/built/SeedMatchR" "{out}/SeedMatchR"\n')
        report = self.root / "report.json"
        args = SimpleNamespace(
            report=str(report), snapshot=str(snapshot), script=str(script), output=str(out),
            git_url="https://github.com/tacazares/SeedMatchR", commit=self.SHA,
            apt_snapshot_date="2026-09-01", apt_package=["libcurl4-openssl-dev"],
            package_dir=None, lib_view=str(self.view))
        with unittest.mock.patch.dict(os.environ, env), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_acquire_source(args), 0)
        root = next(iter(provision.STORE.glob("seedmatchr-2.0.0-*")))
        record_path = root / "SeedMatchR" / provision.BUILD_MARKER
        return root, script, json.loads(record_path.read_text())

    def test_the_record_holds_the_provenance_and_no_credential(self):
        root, script, record = self._run_r_source(
            GITHUB_PAT="ghp_secret_value_never_in_a_record",
            **{provision.PROVISIONER_DIGEST_ENV: "sha256:prov",
               provision.BASE_DIGEST_ENV: "sha256:base"})

        self.assertEqual(record["schema"], 1)
        self.assertEqual(record["source"],
                         {"url": "https://github.com/tacazares/SeedMatchR",
                          "commit": self.SHA})
        self.assertEqual(record["images"], {"provisioner": "sha256:prov", "base": "sha256:base"})
        self.assertEqual(record["apt"]["snapshot_date"], "2026-09-01")
        self.assertEqual(record["apt"]["packages"], {"libcurl4-openssl-dev": "1.2.3-1build2"})
        self.assertEqual(record["tools"]["R"], "4.6.0")
        self.assertEqual(record["tools"]["Python"], "3.12.0")
        self.assertEqual(record["tools"]["pak"], "1.1.0")
        for tool in ("gcc", "g++", "gfortran", "cmake", "uv"):
            self.assertTrue(record["tools"][tool], tool)
        self.assertEqual(record["script"], script.read_text())
        self.assertEqual(record["script_sha256"], provision.script_sha256(script))
        self.assertIn(record["arch"], ("amd64", "arm64"))
        self.assertNotIn("ghp_secret_value_never_in_a_record",
                         (root / "SeedMatchR" / provision.BUILD_MARKER).read_text())

        # Out of the content hash: the marker was taken before the record
        # wrote beside it, and a fresh hash over the published tree (record
        # present) still equals it.
        marker = (root / "SeedMatchR" / provision.HASH_MARKER).read_text().strip()
        self.assertEqual(provision.tree_hash(root), marker)

    def test_the_record_of_a_folder_holds_the_tree_hash(self):
        snapshot = self.root / "snapshot"
        built = snapshot / "built"
        built.mkdir(parents=True)
        (built / "demo-1.0-py3-none-any.whl").write_bytes(b"PK\x03\x04\n")
        self.root_install_tree = {
            "demo/__init__.py": "x = 1\n",
            "demo-1.0.dist-info/METADATA":
                "Metadata-Version: 2.1\nName: demo\nVersion: 1.0\n"}
        out = self.root / "out"
        script = self.root / "build.sh"
        script.write_text(f'#!/bin/sh\nset -e\nmkdir -p "{out}"\n'
                          f'cp "{built}/demo-1.0-py3-none-any.whl" "{out}/"\n')
        report = self.root / "report.json"
        args = SimpleNamespace(report=str(report), snapshot=str(snapshot),
                               script=str(script), output=str(out),
                               git_url=None, commit=None,
                               apt_snapshot_date=None, apt_package=[],
                               package_dir=None, lib_view=str(self.view))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(provision.cmd_acquire_source(args), 0)

        root = next(iter(provision.STORE.glob("demo-1.0-*")))
        record = json.loads((root / provision.BUILD_MARKER).read_text())
        # The folder hashes through the tree-hash function over the pristine
        # copy — a full sha256, of which the pin qualifier holds the head 16.
        self.assertEqual(record["source"]["tree_hash"], provision.tree_hash(snapshot))
        self.assertNotIn("url", record["source"])
        self.assertEqual((root / provision.PIN_MARKER).read_text().strip(),
                         f"demo==1.0@tree:{record['source']['tree_hash'][:16]}")

        # Out of every farm link: the python track links the content entries
        # of the store directory, and the record is not one of them.
        farm = provision.FARMS / "an1"
        with contextlib.redirect_stdout(io.StringIO()):
            provision.build_python_track(farm, [root])
        site = farm / "python" / "site-packages"
        self.assertTrue((site / "demo").is_symlink())
        self.assertFalse((site / provision.BUILD_MARKER).exists())
        self.assertEqual(provision.tree_hash(root),
                         (root / provision.HASH_MARKER).read_text().strip())


if __name__ == "__main__":
    unittest.main()
