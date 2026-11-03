## ADDED Requirements

### Requirement: The assertion-safety rules report nothing

The oxlint configuration of cli MUST NOT turn off `@inflexa-ai/require-assertion-safety`, `typescript/no-unsafe-type-assertion`, or `@inflexa-ai/no-double-cast`. A type assertion that stays in the source MUST carry the invariant that makes it sound. A `SAFETY:` comment states the invariant, and a site that `typescript/no-unsafe-type-assertion` reports also needs an inline disable with a reason. The fix shapes for a reported site are design rules of the change `adopt-assertion-safety` (design D1 to D6), not spec obligations.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** each of the three rules reports no site, and the lint run passes

#### Scenario: No off entry for the rules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns any of the three rules off

#### Scenario: A double cast does not exist

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/`
- **THEN** no `as unknown as` and no `as any as` expression remains
