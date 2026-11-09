# Tasks

## 1. The build-session interface in the harness

- [x] 1.1 Add the `BuildSession` interface to `harness/src/sandbox/types.ts` (`start(source)`, `exec(handle, command)`, `commit(handle, script)`, `stop(handle)`) beside `ExtendAnalysisFarm`, and export it from the harness index. Verify with `cd harness && bun test src/sandbox` green.
- [x] 1.2 Add `source` to the R subtrees of `libStoreEnv` in `harness/src/sandbox/mount-plan.ts` so `R_LIBS_SITE` covers `r/source`, and verify the mount-plan tests assert the new subtree on both toolchain sources.
- [x] 1.3 Add the optional `source` field to `FarmLockPackageSchema` in `harness/src/sandbox/farm.ts` (additive, schema stays 1), and verify `farm.test.ts` parses a lock whose source-built entry carries it.

## 2. The `install_from_source` conversation tool

- [x] 2.1 Create the tool module under `harness/src/tools/` with `defineTool`: the four-operation input (start/exec/commit/stop with a session id), roster gating on the bound `BuildSession` (the `link_packages` pattern — no `hostTools` route), and a tool description that carries the session discipline: absolute paths or `cd <dir> && <command>`, the standard-path-first strategy (pak lockfile resolve for R, wheel build plus hash-pinned resolve for Python), identity from `DESCRIPTION`/`.dist-info`, and the stop rule. Verify with a new test file that pins the description text, the roster on/off behavior, and the input schema.
- [x] 2.2 Wire the ask flow into the tool over a stubbed `BuildSession`: the plan ask after exploration (source, full commit sha, host list, apt packages, strategy), the amended plan ask on a wall failure, the per-command ask with a session-scoped `grantKey` and a root marker on root execs, and the commit ask with the script and the record preview. Verify with tests that assert the ask sequence, the grant key, the root marker, and that each rejection ends the session with no store change.
- [x] 2.3 Wire the exec and commit semantics: each exec a fresh shell (exec id from session id plus sequence, default cwd the working-copy root), results through the tool-output cap with a kept reference; a clean-run failure returns to the same session for a corrected script. Verify with tests that drive the stubbed interface and assert the fresh-shell contract, the excerpt behavior, and the retry-in-session path.

## 3. The provisioner `acquire-source` mode

- [x] 3.1 Add the `acquire-source` subcommand to `images/sandbox-provisioner/provision.py`: it takes `--report`, the pristine source snapshot directory, and the build script; it runs the script; it enforces the script contract (exactly one root artifact in the output directory, no dependencies installed by the script); it resolves and installs the dependencies itself through the current hash-pinned paths; it stores the root through the existing store functions; it stages the graph nodes with `emit_deps` and writes the acquire-report shape with the `source` outcome kind. Verify with new `test_provision.py` cases (monkeypatched subprocess runner) covering the clean path, the no-artifact refusal, the extra-artifact refusal, and the dangling-edge refusal.
- [x] 3.2 Extend the pin marker of a source build with the source qualifier (`@git:<full sha>` / `@tree:<sha16>`), keep the bare metadata version in the store directory name, and make `find_stored` strip the qualifier for the directory glob and match the full marker text. Verify with unit tests covering: index pin never matches a source build, source pin never matches an index build, and a repeat source build reuses its own directory.
- [x] 3.3 Write the build record `.inflexa-build.json` beside the pin and hash markers (source URL and full commit or folder tree hash, provisioner and base image digests from the launch environment, apt snapshot date and packages, versions of the compilers, cmake, R, Python, uv, and pak, build script and sha256, arch; no credential), hash a folder source with `tree_hash`, and add the record to `NOT_CONTENT` so it stays out of the content hash and the farm links. Verify with unit tests over a staged tree, including the no-credential and out-of-hash assertions.
- [x] 3.4 Assert in `test_provision.py` that the name and version of the stored root come from the package metadata (`DESCRIPTION` for R, `.dist-info` for Python), not from the script or the repository name.

## 4. The link rule and the image

- [x] 4.1 Add the `ldd` link-rule check to `images/package-store/load-check.py`: walk each ELF file of the staged source-built directories inside the sandbox image, run `R CMD ldd` for the R track and plain `ldd` otherwise, and fail with the missing library named on a `not found` line. Verify with unit tests over a stubbed runner, plus the existing suite staying green.
- [x] 4.2 Add `autoconf`, `automake`, `libtool`, `meson`, `ninja-build`, and `patchelf` to the provisioner image in `images/sandbox-provisioner/Dockerfile` on its own `RUN` line, leaving `install-build-toolchain.sh` untouched. Verify with the Dockerfile diff review and `ruff check` where the image scripts are linted.

## 5. The inventory mapping

- [x] 5.1 Add `source` to the lock-subtree-to-track mapping and its section title in `harness/src/tools/sandbox/list-available-packages.ts`, and cover it with a test that lists a `source`-subtree entry under the R track. Verify with `cd harness && bun test src/tools/sandbox`.

## 6. Verification of the harness change

- [x] 6.1 Run the full relevant suites: `cd harness && bun test src/sandbox src/tools`, `cd images/sandbox-provisioner && python3 -m unittest test_provision test_package_identity`, and `openspec validate add-source-build-session` in both trees. Record the results in the change notes.
