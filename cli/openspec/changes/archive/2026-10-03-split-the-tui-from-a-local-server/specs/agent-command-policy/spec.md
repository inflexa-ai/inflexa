## MODIFIED Requirements

### Requirement: Every action command declares its agent policy at registration

Every commander command that registers an action handler SHALL declare an `AgentPolicy` at its registration site, colocated with the command it governs. The policy SHALL be one of exactly three kinds: `auto` (runs without approval, carrying a `safeFlags` array), `approval` (approval-gated via `ctx.ask`, grantable per analysis), or `blocked` (never runs, carrying a mandatory model-facing reason). Registration SHALL go through a helper that takes the command kind (the `cli-core` capability), the policy, and the action handler together, so an action command without a kind or a policy is a TypeScript compile error — there is no default. The policy and the kind SHALL be attached to the `Command` instance itself (not keyed by the command's path string), so a rename or restructure cannot orphan either. Parent group commands without an action handler carry no policy and no kind: a bare group prints its own help and classifies as introspection.

#### Scenario: A registered action command carries a retrievable policy

- **WHEN** a command is registered through the policy-taking helper and later resolved by the classifier
- **THEN** the policy declared at registration is readable from the resolved `Command` instance

#### Scenario: A command rename cannot orphan its policy

- **WHEN** a command's name is changed at its registration site
- **THEN** its policy still applies to the renamed command without any other edit, because the policy travels with the `Command` instance rather than a path-string key

#### Scenario: A blocked declaration requires a reason

- **WHEN** a command is registered with the `blocked` kind
- **THEN** the declaration carries a model-facing reason string, and that reason is what the tool returns for the blocked invocation

#### Scenario: The kind travels with the command

- **WHEN** a command is registered through the helper with a command kind
- **THEN** the kind is readable from the `Command` instance, the same as the policy

### Requirement: Static enforcement makes an unclassified command a build failure

Beyond the compile-time helper, the system SHALL enforce policy exhaustiveness statically: an ESLint restriction scoped to the command registry SHALL forbid raw commander `.action(` registration (the helper is the only path), and a CI test SHALL walk the full `buildProgram()` tree — with the dev channel forced both on and off — asserting every action-classified leaf carries a policy and a command kind. A snapshot test SHALL pin the derived table of `subcommand path → policy kind (and safeFlags for auto)` so any policy change surfaces as a reviewable one-file diff. A second snapshot SHALL pin the table of `subcommand path → command kind (and the machine options of an instance command)`, and each machine option SHALL name an option that the command declares. Validation SHALL live in lint and tests, never in `buildProgram()` itself — a policy mistake must not brick the CLI at startup for human use.

#### Scenario: A raw action registration is a lint error

- **WHEN** a command in the registry is given an action handler via commander's `.action()` directly instead of the policy-taking helper
- **THEN** ESLint fails the build

#### Scenario: The tree walk catches a policy-less leaf in either channel

- **WHEN** the exhaustiveness test walks the command tree with dev-channel commands enabled and again with them disabled
- **THEN** it fails if any action-classified leaf command lacks a stamped policy or a stamped command kind

#### Scenario: A policy change is a visible audit diff

- **WHEN** any command's policy kind or safeFlags change
- **THEN** the policy snapshot test fails until its expected table is consciously updated in review

#### Scenario: A kind change is a visible audit diff

- **WHEN** a command's command kind or its machine options change
- **THEN** the kind snapshot test fails until its expected table is consciously updated in review
