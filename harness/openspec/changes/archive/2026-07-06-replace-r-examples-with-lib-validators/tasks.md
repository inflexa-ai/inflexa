## 1. Relocate the validator suite

- [x] 1.1 `git mv cli/scripts/lib-validator scripts/lib-validator` (261 files; history preserved)
- [x] 1.2 Update the `.gitignore` comment that references `cli/scripts/lib-validator/*.py` to `scripts/lib-validator/`
- [x] 1.3 Confirm no other file references the old `cli/scripts/lib-validator/` path (grep repo)

## 2. Wire run_all.py into the acceptance suite (behavioral pass)

- [x] 2.1 `validate.py`: remove the anchors phase (`run_anchors`) and the R-examples phase (`run_r_examples`), and their `--anchors/--no-anchors` / `--r-examples` flags
- [x] 2.2 `validate.py`: add a behavioral phase that runs `python3 $LIB_VALIDATOR_DIR/run_all.py --json` (default dir `/opt/lib-validator`), passing `--lang py` when `shutil.which("Rscript")` is absent else `--lang all`; parse the JSON for the verdict + summary
- [x] 2.3 `validate.py`: add a `--no-validators` escape hatch (import-all only) replacing the old `--no-anchors` fast-core mode; keep import-all always-on as part of the reported validation
- [x] 2.4 `run.sh`: mount `scripts/lib-validator` read-only at `/opt/lib-validator` and export `LIB_VALIDATOR_DIR=/opt/lib-validator` in both the `--image` and `--store` docker invocations
- [x] 2.5 `run.sh`: drop `--full` / `--r-examples` / `--no-anchors` args and the `LIB_STORE_R_EXAMPLE_LIMIT` / `LIB_STORE_R_EXAMPLE_TIMEOUT` env plumbing; update the usage header comment

## 3. Acceptance run-summary results table

- [x] 3.1 `validate.py`: print a concise human summary (import-all per track + per-library counts + failures) to stdout for the CI log
- [x] 3.2 `validate.py`: when `$LIB_STORE_SUMMARY_MD` is set, assemble a markdown table — header (arch + `$LIB_STORE_VERSION` + green/red), import-all per-track tally, per-library counts (pass/fail/error/skip), and a "needs attention" list of failing/errored libraries — and write it to that path
- [x] 3.3 `run.sh`: add `--summary-md <host-file>`; when set, `mkdir -p` its dir, bind-mount the dir writable at `/out`, and pass `-e LIB_STORE_SUMMARY_MD=/out/<basename>` (and `-e LIB_STORE_VERSION` if provided) in both docker invocations

## 4. Make acceptance non-gating; the build owns `latest`

- [x] 4.1 `lib-store-acceptance.sh`: **remove the S3 promotion block** (the `aws s3 cp … latest …` for manifest + coverage); drop the `S3_BUCKET` requirement; update the header comment (no longer promotes)
- [x] 4.2 `lib-store-acceptance.sh`: pass `--summary-md "$RUNNER_TEMP/acceptance-<arch>.md"` and `LIB_STORE_VERSION=$VERSION` to `run.sh`; after the run, `cat` the file into `$GITHUB_STEP_SUMMARY` when that env is set (no-op locally); exit green/red as status
- [x] 4.3 `lib-store-publish.sh`: after writing `<version>/<arch>/manifest.json`, also copy it to `latest/<arch>/manifest.json`; update the "candidate-only / latest NOT moved — awaits acceptance" prose to "advances latest (build-floor gated)"
- [x] 4.4 `lib-store.yml` (builder): in the publish step, copy `dist/coverage.json` to `s3://$S3_BUCKET/latest/linux-$ARCH/coverage.json` alongside the versioned copy (baseline advances with the build)
- [x] 4.5 `lib-store-acceptance.yml` (validator): rename the "Validate + promote" step to "Validate + report"; drop the promotion; keep the image pull + suite run; the results table renders in the step summary (via 4.2)

## 5. Delete the retired code

- [x] 5.1 `git rm scripts/lib-store-validate/r_examples.R`
- [x] 5.2 `git rm scripts/lib-store-validate/anchors.json` and `git rm -r scripts/lib-store-validate/anchors/`
- [x] 5.3 Verify `validate.py` no longer imports/references anchors or r_examples paths

## 6. Update spec and docs

- [ ] 6.1 The `lib-store-build` delta is authored + validated in the change; the main spec (`harness/openspec/specs/lib-store-build/spec.md`) is synced at archive time (`/opsx:archive`), not hand-edited during apply
- [x] 6.2 Correct workflow header comments (`lib-store.yml`, `lib-store-acceptance.yml`) that described the candidate→acceptance→promote flow / R examples / anchors as current behavior

## 7. Verify

- [x] 7.1 Syntax-check: `python3 -m py_compile scripts/lib-store-validate/validate.py scripts/lib-validator/run_all.py`; `bash -n scripts/lib-store-validate/run.sh scripts/lib-store-acceptance.sh scripts/lib-store-publish.sh` — all pass
- [x] 7.2 Smoke-run `run_all.py` on the host over the moved suite — discovery + classification work from the new location (11 pass / 90 absent / 1 host-only fail: networkx needs scipy, absent on this dev host; passes in the image)
- [ ] 7.3 Dry-run the acceptance path against a local image (`run.sh --image <ref> --summary-md /tmp/acc.md`) — NOT RUN here (no local sandbox image); exercised in CI
- [x] 7.4 `openspec validate --changes replace-r-examples-with-lib-validators` — passes
