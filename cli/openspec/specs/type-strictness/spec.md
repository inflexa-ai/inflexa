# type-strictness Specification

## Purpose

Records the compiler strictness and the lint rules that keep the values of cli typed: the decision that `exactOptionalPropertyTypes` stays off, the rules that keep each `any` and each conditional spread out of the source, the rules that keep each type assertion behind a stated invariant, the rules that make each read of a value that can be absent state where its presence comes from, and the rule that no preset rule stays off outside its recorded exceptions.

## Requirements

### Requirement: exactOptionalPropertyTypes stays off

The TypeScript program of cli MUST NOT set `exactOptionalPropertyTypes`. The recorded reason (issue #805, 2026-11-03) has these parts:

- In cli, a missing key and a key with the value `undefined` mean the same to the type system.
- `@inflexa-ai/no-conditional-spread` prescribes the direct property as its fix under that equivalence.
- The flag reports many sites at targets that the harness types with the flag off.
- Each widening to `?: T | undefined` restores the equivalence that the flag exists to remove.
- The harness records the same decision in its own `type-strictness` capability.

Tests, not the flag, control a consumer that tells an absent key from an `undefined` value.

#### Scenario: The flag is absent from the program options

- **WHEN** a reader reads the compiler options of `cli/tsconfig.json`
- **THEN** they contain no `exactOptionalPropertyTypes` entry

### Requirement: The unchecked-value rules report nothing

The oxlint configuration of cli MUST NOT turn off `typescript/no-unsafe-call`, `typescript/no-unsafe-member-access`, `typescript/no-unsafe-assignment`, `typescript/no-unsafe-return`, `typescript/no-unsafe-argument`, or `@inflexa-ai/no-conditional-spread`. The fix shapes for a reported site are design rules of the archived change `adopt-unchecked-value-rules` (design D2 and D3), not spec obligations.

#### Scenario: The lint run reports nothing for the rules

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** each of the six rules reports no site, and the lint run passes

#### Scenario: No off entry for the rules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns any of the six rules off

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

### Requirement: A conditional key stays absent where a consumer observes presence

Some consumers of an object can tell an absent key from a key with the value `undefined`. Where a value is optional, the object for such a consumer MUST omit the key when the value is absent. A consumer observes presence when one of these is true:

- It reads `in`, `Object.keys`, `Object.entries`, `Object.values`, `Object.hasOwn`, or `hasOwnProperty` on the object.
- It spreads the object over defaults, or it passes the object to `Object.assign`.
- It converts the object to `Headers`, `URLSearchParams`, or `FormData`.
- It is a library or harness code whose handling of an `undefined` key a reader cannot read.
- A test asserts the exact key set of the object.

The change `adopt-unchecked-value-rules` rewrote each conditional spread of cli. Each such consumer of an object that it rewrote MUST have a test that asserts the absent key and the present key. One exception applies: a test cannot import the code, and the type of the object rejects an `undefined` value at the key. Then `bun run typecheck` is the check.

#### Scenario: An absent optional value leaves the key out

- **WHEN** code builds an object for a presence-observing consumer and the optional value is absent
- **THEN** the object has no own property for that key, and the test of the consumer asserts it

#### Scenario: A present value keeps its key and value

- **WHEN** code builds the same object and the optional value is present
- **THEN** the object has the key with the value of the optional value

### Requirement: The remaining preset rules report nothing

The oxlint configuration of cli MUST NOT turn off a rule of the preset outside two recorded exceptions:

- The two bun-types rules `typescript/await-thenable` and `typescript/no-confusing-void-expression` stay off for the test globs only, because bun-types types `expect().rejects.toThrow()` as `void`.
- A deliberate site keeps a named exception when each fix of the rule would remove its form or change its behavior. For a `typescript/*` rule, the exception is an inline `oxlint-disable-next-line <rule> -- <reason>`. For an `@inflexa-ai/*` rule, which the architecture-directives layer of the plugin keeps out of inline directives, the exception is a zone block in the configuration that names exactly one rule and carries a reason for each file that it covers.

The rule `@inflexa-ai/no-instanceof-error` MUST carry an `allowIn` list that names only the modules that normalize an arbitrary thrown value, with the reason of each entry beside it. The fix shapes for a reported site are design rules of the change `adopt-remaining-preset-rules` (design D1 to D15), not spec obligations.

#### Scenario: The lint run reports nothing outside the recorded exceptions

- **WHEN** `bun run lint` runs in `cli/`
- **THEN** no preset rule reports a site, and the lint run passes

#### Scenario: No blanket off entry remains

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** no override turns a preset rule off, except the bun-types block of the test globs and the zone blocks that name one rule and carry a reason for each file

#### Scenario: The instance-of-error option names its modules

- **WHEN** a reader reads the oxlint configuration of cli
- **THEN** `@inflexa-ai/no-instanceof-error` carries an `allowIn` list, through the `instanceofErrorAllowIn` option of the preset, and each entry states its reason beside it

#### Scenario: A kept typescript rule site names its reason

- **WHEN** a reader searches the TypeScript source under `cli/src/` and `cli/scripts/` for a directive that names a rule of the preset
- **THEN** each such directive is an `oxlint-disable-next-line` with a reason after ` -- `, and no directive names an `@inflexa-ai/*` rule
