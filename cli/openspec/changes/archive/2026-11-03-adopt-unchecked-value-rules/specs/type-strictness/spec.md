# Spec Delta

## Purpose

Records the compiler strictness and the lint rules that keep the values of cli typed: the decision that `exactOptionalPropertyTypes` stays off, and the rules that keep each `any` and each conditional spread out of the source.

## ADDED Requirements

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
