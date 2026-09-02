# Tasks — carry-the-image-inventory-in-the-store

## 1. The image record

- [x] 1.1 Make the conda load check emit a JSON fragment with the `name`,
  the `version` from `micromamba list --json` over the prefix, and the
  `executable` when it differs (`images/sandbox-base/Dockerfile`, the
  conda-builder stage, with a script under `images/sandbox-base/scripts/`).
- [x] 1.2 Make the node load check emit a JSON fragment with the `name` and
  the `version` from `node_modules/<name>/package.json`
  (`images/sandbox-base/scripts/node-load-check.js`).
- [x] 1.3 Add `ARG IMAGE_VERSION` to the runtime stage. Assemble
  `/opt/inflexa/image-packages.json` from the two fragments, the identity
  (the repository constant, `IMAGE_VERSION`, `TARGETARCH`), and the
  `runtimes` versions from `python3 --version`, `R --version`, and
  `node --version`, as the last write of the runtime stage.
- [x] 1.4 Remove the text fragments and the `cat` assembly of
  `image-packages.txt`.
- [x] 1.5 Name the record in place of the text fragment in
  `images/sandbox-base/README.md` and `images/README.md`.
- [x] 1.6 Remove `images/sandbox-base/scripts/conda-binaries.py`, because
  the conda load check holds its probe-name rule and nothing else calls it.
- [x] 1.7 Make the acceptance validator
  `scripts/package-store-validate/validate.py` read the image record in
  place of the text fragment: a conda entry contributes its executable
  name, a node entry its name, and an absent record or an unknown schema
  fails loud.

## 2. The workflows

- [x] 2.1 Pass `--build-arg IMAGE_VERSION=$VERSION` in the `sandbox-base`
  build step of `.github/workflows/sandbox-images-build.yml`.
- [x] 2.2 Pass the same build arg in the local image build of
  `.github/workflows/package-store-build.yml`.
- [x] 2.3 Add a step to `package-store-build.yml` after the load check and
  before the pack: run the local image with the store volume mounted
  read-write, and copy `/opt/inflexa/image-packages.json` to
  `/mnt/libs/image-packages.json`.

## 3. The harness reader

- [x] 3.1 Add the zod schema of the record in
  `src/sandbox/image-packages.ts`, a sibling of `FarmLockSchema`: a
  `schema` literal of 1, the `image`, `runtimes`, `system_tools`, and
  `node` fields, with passthrough for additive fields.
- [x] 3.2 Add `imageSections(record)` beside `lockSections` in
  `src/tools/sandbox/list-available-packages.ts`: `system_tools` under
  `System tools (CLI)` by the executable name, `node` under `Node (npm)`,
  each with its version.
- [x] 3.3 Set `DEFAULT_IMAGE_PACKAGES_FILE` to
  `${LIBS_CONTAINER_PATH}/image-packages.json`.
- [x] 3.4 Read and validate the record at each call. An absent or invalid
  record merges nothing.
- [x] 3.5 Delete `parsePackagesFile` and the text section format.
- [x] 3.6 Update the documentation of `imagePackagesFile` in
  `src/config/environment-stores.ts` and the module header of the tool to
  name the store root.

## 4. Tests

- [x] 4.1 Schema tests: a valid record parses, a record at an unknown
  schema is refused, and an additive field passes through.
- [x] 4.2 Tool tests in `src/tools/sandbox/catalog-tools.test.ts`: the
  record merges with `name==version` rows, the `cli` and `node` language
  filters hit their sections, and a `names` check finds a tool by its
  executable name.
- [x] 4.3 Tool tests: an absent record and an invalid record each report
  the farm tracks alone, without a throw.
- [x] 4.4 Replace the `parsePackagesFile` tests and the text fixtures.

## 5. Verification

- [x] 5.1 Run `bun run format:file` on each changed file under `src/`.
- [x] 5.2 Run `tsc -p tsconfig.json` and `bun test`.

## 6. The twin change

- [x] 6.1 Make sure that the twin change of the same name exists in the
  CLI tree, for the download update rule, the removal of the container
  extraction, and the path from the store root.
