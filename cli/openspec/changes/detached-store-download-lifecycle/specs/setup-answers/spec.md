## MODIFIED Requirements

### Requirement: The sandbox image and resource allowance are answerable

`--sandbox` (file: `sandbox`) SHALL answer whether setup obtains the container
images and the package store catalog. The answer IS the multi-GB consent, and each
transfer then runs with no size confirmation. The answer SHALL NOT name an image
variant, because one runtime image is published and the store carries the package
set.

A pull SHALL obtain both the runtime image and the provisioner image. The store is
the one source of an R library and a Python library, and the provisioner extends
it.

The same answer SHALL consent to the catalog. The catalog is the third
multi-gigabyte transfer that setup starts, beside the two images. Thus the user
answers one question about size, and setup asks no second consent.

When the answer is yes, setup SHALL start the detached store downloader. Setup
SHALL NOT wait for the transfer, and it SHALL name the command that reports the
progress. `lib-store-download-process` owns the lifecycle of that process.

When the user answers no in an interactive run, setup SHALL record the download
state as `declined`. The app SHALL NOT ask that question again at app open, and
`inflexa store download` SHALL stay the way to start the transfer later.

Absent an answer, batch setup SHALL skip both images and SHALL start no download.
The existing pull-later hint SHALL name the command for the images and the command
for the catalog. Nothing SHALL download implicitly.

An answer that names a retired variant SHALL fail validation in the one up-front
pass, and the error SHALL name both spellings of the answer. It SHALL say that the
variant is retired and that the answer takes no image name.

`resources.sharePct` (flag `--resource-share <pct>`, 1 to 100) SHALL answer the
machine-allowance question as a percentage, which is portable across heterogeneous
fleets. The CLI SHALL persist the absolute budget that it computes from the
detected machine, exactly as the prompt of the wizard persists it.

#### Scenario: A sandbox answer pulls and downloads without confirmation

- **WHEN** `setup --yes --sandbox` runs with the images absent locally
- **THEN** the runtime image and the provisioner image are pulled with no size prompt, and the detached store download starts

#### Scenario: Setup does not wait for the store transfer

- **GIVEN** `setup --yes --sandbox` that started the store download
- **WHEN** the setup command finishes
- **THEN** setup exits, it names the command that reports the progress, and the transfer continues

#### Scenario: One answer covers each large transfer

- **WHEN** `setup --sandbox` runs interactively
- **THEN** the user answers one size question, and setup asks no second consent for the catalog

#### Scenario: No sandbox answer downloads nothing

- **WHEN** `setup --yes` runs without `--sandbox`
- **THEN** no image is pulled, no store download starts, and the pull-later hint names both commands

#### Scenario: A refusal records the declined state

- **GIVEN** an interactive `inflexa setup`
- **WHEN** the user answers no to the images and the catalog
- **THEN** the download state is `declined`, no process starts, and the app asks nothing at its next open

#### Scenario: A retired variant answer fails validation

- **WHEN** `setup --yes --sandbox python-r` runs
- **THEN** validation fails before any mutation, names both spellings of the answer, and says the answer takes no image name

#### Scenario: The resource share persists machine-relative absolutes

- **WHEN** `setup --yes --resource-share 50` runs
- **THEN** the persisted budget is the absolute value computed from the detected machine, exactly as the prompt of the wizard persists it
