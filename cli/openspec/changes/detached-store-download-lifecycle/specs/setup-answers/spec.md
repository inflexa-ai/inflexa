## ADDED Requirements

### Requirement: A second `inflexa setup` never blocks on a live catalog download

`inflexa setup` SHALL complete each of its steps while a catalog download runs. A
live transfer SHALL block no step of setup.

Setup does many things, for example the references, the database, and the model
configuration. Each of those steps SHALL run to its end during a transfer.

At its store step, a second setup SHALL open no consent. The first answer stands,
thus setup asks that question one time only.

The store step SHALL report the live transfer. It SHALL name the state, and it
SHALL name the bytes transferred and the total bytes.

The store step SHALL name `inflexa store cancel`, which stops the transfer. It
SHALL name `inflexa sandbox remove`, which removes the two pulled images. The user
owns the two decisions, and setup makes neither one.

Setup SHALL then continue to the remaining steps. It SHALL NOT wait for the
transfer, and the held lock SHALL make it start no second downloader.

#### Scenario: A second setup opens no consent for the catalog

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` runs a second time
- **THEN** the store step opens no consent, because the first answer stands

#### Scenario: A second setup reports the live transfer

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it names the state, the bytes transferred, and the total bytes

#### Scenario: A second setup names the two commands

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it names `inflexa store cancel` and `inflexa sandbox remove`

#### Scenario: The live transfer blocks no other step

- **GIVEN** a live catalog download
- **WHEN** `inflexa setup` runs a second time
- **THEN** the references, the database, and the model configuration each complete, and setup exits

#### Scenario: A second setup starts no second downloader

- **GIVEN** a live catalog download that holds the lock
- **WHEN** `inflexa setup` reaches its store step
- **THEN** it starts no process, and it reports the live run

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

The answer SHALL cover one bundle of three transfers:

- the runtime image
- the provisioner image
- the package store catalog

Setup SHALL list the three items in one message. The user SHALL answer one time,
and that one answer SHALL cover the whole bundle. Setup SHALL ask no second
consent for the catalog.

There SHALL be no answer that takes the two images and refuses the catalog. The
store is mandatory, and no runtime image bakes a library. Thus a sandbox with no
catalog can import nothing, and a partial answer has no working result.

When the answer is yes, setup SHALL start the detached store downloader at the
moment that it starts the image pulls. The catalog transfers while the images
pull. Setup SHALL NOT wait for the catalog, and it SHALL name the command that
reports the progress. `lib-store-download-process` owns the lifecycle of that
process.

Setup SHALL exit when the image pulls finish. The catalog transfer SHALL continue
after that exit, because the downloader is a detached process.

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

#### Scenario: One answer covers the whole bundle

- **WHEN** `setup --sandbox` runs interactively
- **THEN** setup lists the two images and the catalog in one message, and the user answers one time

#### Scenario: No answer takes the images and refuses the catalog

- **WHEN** the user looks for a way to accept the images and refuse the catalog
- **THEN** no such answer exists, because the store is mandatory

#### Scenario: The catalog transfers while the images pull

- **WHEN** `setup --sandbox` starts the two image pulls
- **THEN** the detached catalog downloader starts at the same moment, and the two transfers run together

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
