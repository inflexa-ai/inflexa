## ADDED Requirements

### Requirement: The non-null and unnecessary-condition rules report nothing

The oxlint configuration of cli MUST NOT turn off `typescript/no-non-null-assertion`, `typescript/no-unnecessary-type-assertion`, or `typescript/no-unnecessary-condition`. A non-null assertion (`x!`) MUST NOT remain in the TypeScript source of cli. A directive that turns off `typescript/no-unnecessary-condition` MUST apply to one line only, and it MUST state why the guard is live. The fix shapes for a reported site are design rules of the change `adopt-non-null-narrowing` (design D1 to D6), not spec obligations.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** each of the three rules reports no site, and the lint run passes

#### Scenario: No off entry for the rules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns any of the three rules off

#### Scenario: No directive turns off the non-null rule

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/`
- **THEN** no directive names `no-non-null-assertion`, and each directive that names `no-unnecessary-condition` is an `oxlint-disable-next-line` with a reason
