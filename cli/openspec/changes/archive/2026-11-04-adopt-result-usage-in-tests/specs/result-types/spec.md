# Spec Delta

## ADDED Requirements

### Requirement: must-use-result rule covers each file under src

The configuration of the `inflexa-typecheck` command (`@inflexa-ai/typecheck`, in `typecheck.config.ts`) MUST set the `must-use-result` rule to `error` for each file under `src/`, the test files included. An override of the configuration MUST NOT turn the rule off. The rule's `consumers` option MUST name each function that takes a `Result` and handles it itself, each with its reason in the configuration. Examples are `fromCatalogStart`, `readImageSbom`, and `awaitOk`, the awaiting helper of the tests. A `Result` that the rule counts as handled is not a report. The rule's own documentation lists the handled forms (for example a `.match()` call, an `isErr()` check, a read of `.value`, a return).

A `Result` passed to a function named in `consumers` counts as handled. A directive is permitted only where code uses the `Result` in a form that the rule cannot see, for example a `yield` to the reader of a generator. Such a site MUST carry a `typecheck-disable-next-line must-use-result` directive on the line before it. The directive MUST give a reason after ` -- ` that states why the rule cannot see the use. The fix shape of a reported test site is a design rule of the change `adopt-result-usage-in-tests`, not a spec obligation.

#### Scenario: Unconsumed Result triggers lint error

- **WHEN** a function in `src/` returns a `Result`, and the caller discards it without a use that the rule counts as handled
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: Consumed Result passes lint

- **WHEN** a function in `src/` returns a `Result`, and the caller uses it in a form that the rule counts as handled
- **THEN** `bun run typecheck` reports no error for it

#### Scenario: A Result that flows into a consumer passes lint

- **WHEN** a `Result` is a direct argument of a call of a function named in `consumers`
- **THEN** `bun run typecheck` reports no error for it

#### Scenario: The rule covers the test files

- **WHEN** a test file under `src/` awaits a call that gives a `Result`, and drops the `Result`
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: No off entry for the rule

- **WHEN** a reader reads `typecheck.config.ts` of cli
- **THEN** no override turns `must-use-result` off, and the `src/**` entry sets the rule to `error`

#### Scenario: The type check reports nothing

- **WHEN** `bun run typecheck` runs in `cli/`
- **THEN** `must-use-result` reports no site, and the run passes

## REMOVED Requirements

### Requirement: must-use-result rule of the type check command

**Reason**: The requirement turned the rule off for the test globs until #810. The rule now covers the tests, and the scenario "The rule is off in the test globs" is false. A MODIFIED block cannot drop that scenario, thus the requirement "must-use-result rule covers each file under src" replaces this requirement. It keeps each other scenario of this requirement.

**Migration**: None. A test file states the `Result` of each call that it awaits, with `awaitOk` or with `_unsafeUnwrapErr`.
