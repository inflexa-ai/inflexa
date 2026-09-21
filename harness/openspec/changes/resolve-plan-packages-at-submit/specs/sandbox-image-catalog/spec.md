## MODIFIED Requirements

### Requirement: The image owns the toolchain

The image MUST own the interpreters, the conda prefix at `/opt/conda`, and
the Node packages at `/opt/node`. Builder stages install them, because a
conda prefix does not relocate and cannot join a content-addressed store.
The image MUST bake its inventory as one JSON record at
`/opt/inflexa/image-packages.json`. The record MUST carry:

- `schema` — the number 1.
- `image` — the `repository`, the `version` from the `IMAGE_VERSION` build
  arg, and the `arch` from the `TARGETARCH` build arg.
- `runtimes` — the versions of `python`, `r`, and `node`.
- `system_tools` — one entry for each conda tool that passed the load
  check: the `name`, the `version`, and the `executable` when it differs
  from the name.
- `node` — one entry for each Node package that passed the load check: the
  `name` and the `version`.
- `r_base` — the name of each R package that the R runtime of the image
  installs at the priority `base`.
- `python_stdlib` — each public name of `sys.stdlib_module_names` of the
  Python runtime of the image. A private name with a leading underscore, such
  as `_abc`, MUST NOT appear, because no plan can name one.

The keys `system_tools` and `node` MUST equal the manifest keys. Additive
fields pass through, and a breaking change MUST move the schema number.
The fields `r_base` and `python_stdlib` are additive, thus a reader MUST
accept a record that carries neither. The record assembly MUST ask the
runtimes of the image for the two sets, and an empty set MUST fail the build.
A conda tool whose binary is on PATH, but whose package has no version in
the prefix, MUST fail the build, because a silent drop narrows the record
with no signal. The store mount point MUST stay empty in the image.

#### Scenario: The conda tools live in the image

- **GIVEN** a running sandbox container without a store mount
- **WHEN** a baked conda tool such as `samtools` runs from `/opt/conda/bin`
- **THEN** the tool executes

#### Scenario: The inventory record is baked

- **WHEN** `/opt/inflexa/image-packages.json` is read in a running container
- **THEN** it parses at schema 1, and it lists each image-owned tool and package with its version

#### Scenario: The record names its own image

- **GIVEN** an image built with `IMAGE_VERSION=20260901-3031713` and `TARGETARCH=amd64`
- **WHEN** the record is read
- **THEN** `image.version` is `20260901-3031713` and `image.arch` is `amd64`

#### Scenario: A binary with a different name is recorded under both

- **GIVEN** a manifest `binaries:` entry `eagle2: eagle`
- **WHEN** the record is read on an arch that holds `eagle2`
- **THEN** the `system_tools` entry has `name` `eagle2` and `executable` `eagle`

#### Scenario: A tool with no package version fails the build

- **GIVEN** a manifest tool whose binary is on PATH, and whose package the prefix does not list
- **WHEN** the conda load check runs
- **THEN** the build fails, and the check names the package

#### Scenario: The record carries the base sets of the runtimes

- **WHEN** `/opt/inflexa/image-packages.json` is read in a running container
- **THEN** `r_base` holds `stats` and `grid`, and `python_stdlib` holds `json` and `pickle` and no name with a leading underscore

#### Scenario: A record from before the base sets still parses

- **GIVEN** a record at schema 1 with no `r_base` and no `python_stdlib`
- **WHEN** the harness reads the record
- **THEN** the read succeeds, and the image index holds nothing
