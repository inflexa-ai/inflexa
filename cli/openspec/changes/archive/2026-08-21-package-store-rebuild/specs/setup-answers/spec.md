# Delta: setup-answers

## MODIFIED Requirements

### Requirement: The sandbox image and resource allowance are answerable

`--sandbox` (file: `sandbox`, a boolean — `sandbox: true`) MUST be a bare
flag: the answer IS the one consent for the three transfers — the runtime image, the provisioner image,
and the catalog — and no size confirmation follows. The transfers start at
the START of setup, detached, thus the user continues through the setup
while they run. Setup MUST exit without a wait on them. Absent an answer,
batch setup skips the transfers with the pull-later hint — nothing
downloads implicitly. A decline writes the `declined` state, thus the app
asks nothing at open. A second setup during a live transfer reports the run
and opens no second consent. `resources.sharePct` (flag `--resource-share
<pct>`, 1-100) answers the machine-allowance question as a percentage. The
value persists as the absolute budget computed from the detected machine,
exactly as the wizard's prompt persists it.

#### Scenario: The sandbox answer starts three detached transfers

- **WHEN** `setup --yes --sandbox` runs with nothing present
- **THEN** the three transfers start detached at the start of setup, and setup completes without a wait

#### Scenario: No sandbox answer downloads nothing

- **WHEN** `setup --yes` runs without `--sandbox`
- **THEN** no transfer starts and the pull-later hint is printed

#### Scenario: A second setup never blocks

- **GIVEN** a live catalog transfer
- **WHEN** `inflexa setup` runs again
- **THEN** it reports the live transfer, opens no second consent, and completes

#### Scenario: The resource share persists machine-relative absolutes

- **WHEN** `setup --yes --resource-share 50` runs on an 8-core / 32 GB machine
- **THEN** `harness.resourceLimits.budget` persists 4 CPU / 16 GB
