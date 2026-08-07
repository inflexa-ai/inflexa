## MODIFIED Requirements

### Requirement: The sandbox image and resource allowance are answerable

`--sandbox` (file: `sandbox`) SHALL answer whether setup pulls the container images; the answer IS the multi-GB consent, and the pull runs without a size confirmation. The answer SHALL NOT name an image variant, because one runtime image is published and the store carries the package set. A pull SHALL obtain both the runtime image and the provisioner image. The store is the one source of an R library and a Python library, and the provisioner extends it. Absent an answer, batch setup SHALL skip both images (with the existing pull-later hint) — neither is ever downloaded implicitly. `resources.sharePct` (flag `--resource-share <pct>`, 1–100) SHALL answer the machine-allowance question as a percentage — portable across heterogeneous fleets — persisted as the absolute budget computed from the detected machine, exactly as the wizard's prompt persists it.

An answer that names a retired variant SHALL fail validation in the one up-front
pass, and the error SHALL name both spellings of the answer. It SHALL say that the
variant is retired and that the answer takes no image name.

#### Scenario: A sandbox answer pulls without confirmation

- **WHEN** `setup --yes --sandbox` runs with the images absent locally
- **THEN** the runtime image and the provisioner image are pulled with no size prompt, and the runtime image is recorded as `harness.sandboxImage`

#### Scenario: No sandbox answer downloads nothing

- **WHEN** `setup --yes` runs without `--sandbox`
- **THEN** no image is pulled and the pull-later hint is printed

#### Scenario: A retired variant answer fails validation

- **WHEN** `setup --yes --sandbox python-r` runs
- **THEN** validation fails before any mutation, names both spellings of the answer, and says the answer takes no image name

#### Scenario: The resource share persists machine-relative absolutes

- **WHEN** `setup --yes --resource-share 50` runs
- **THEN** the persisted budget is the absolute value computed from the detected machine, exactly as the wizard's prompt persists it
