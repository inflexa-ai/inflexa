# Delta: farm-composition

## MODIFIED Requirements

### Requirement: A farm is made empty with its analysis

The CLI MUST make the farm of an analysis when it makes the analysis, and
the new farm is empty: the link trees and one `inflexa.lock`, with no
package. A failed farm make MUST stop the creation, and the message MUST
name the farm path, the cause, and the retry. Thus every post-release
analysis carries a farm from birth, and a missing farm marks a
pre-release analysis. The farm provider of the composition root MUST heal
a missing farm as a FULL farm, from the closure of the catalog. The
triggers and the composition of the heal are in
`package-store-management`, "A farm-less analysis heals full from the
catalog".

#### Scenario: The farm rides the analysis creation

- **WHEN** `analysis new` completes
- **THEN** `farms/<analysisId>` exists with an empty `inflexa.lock`

#### Scenario: A farm-make failure stops the creation

- **GIVEN** a farm path that cannot be written
- **WHEN** the analysis creation runs
- **THEN** the creation stops, and the message names the farm path, the cause, and the retry

#### Scenario: A deleted farm heals full

- **GIVEN** an analysis whose farm directory was removed outside the product
- **WHEN** the next sandbox action resolves the farm
- **THEN** the provider composes the full catalog farm, and the sandbox mounts it
