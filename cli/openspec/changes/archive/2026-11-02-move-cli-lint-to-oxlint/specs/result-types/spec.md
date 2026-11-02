# result-types Specification

## RENAMED Requirements

- FROM: `### Requirement: ESLint must-use-result rule`
- TO: `### Requirement: must-use-result rule of the type check command`

## MODIFIED Requirements

### Requirement: must-use-result rule of the type check command

The system SHALL enable the `must-use-result` rule of the `inflexa-typecheck` command (`@inflexa-ai/typecheck`, configured in `typecheck.config.ts`) at `error` level for the files under `src/`. The rule SHALL be off for the test globs, with a comment in the configuration that names #810 as the issue that turns it back on. The configuration SHALL name in the rule's `consumers` option each function that takes a `Result` and handles it itself (for example `fromCatalogStart` and `readImageSbom`), each with its reason in the configuration. A `Result` that the rule counts as handled is not a report. The rule's own documentation lists the handled forms (for example a `.match()` call, an `isErr()` check, a read of `.value`, a return), and a `Result` passed to a function named in `consumers` counts as handled.

#### Scenario: Unconsumed Result triggers lint error

- **WHEN** a function in `src/` returns a `Result` and the caller discards it without a use the rule counts as handled
- **THEN** `bun run typecheck` reports an error on that line

#### Scenario: Consumed Result passes lint

- **WHEN** a function in `src/` returns a `Result` and the caller consumes it in a use the rule counts as handled, including a call of a function named in `consumers`
- **THEN** `bun run typecheck` reports no error for it

#### Scenario: The rule is off in the test globs

- **WHEN** `bun run typecheck` runs over a file that matches the test globs
- **THEN** `must-use-result` reports nothing in that file, whatever the file does with a `Result`
