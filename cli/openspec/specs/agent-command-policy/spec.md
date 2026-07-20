# agent-command-policy Specification

## Purpose

Define the registration-declared agent-availability policy for the `inflexa` CLI's commander registry: the three-kind `AgentPolicy` (`auto` with a `safeFlags` allowlist, `approval`, `blocked` with a mandatory reason) that every action command must declare at its registration site, and the enforcement layers — a compile-required registration helper, a registry-scoped lint ban on raw `.action(`, tree-walk and snapshot tests, and the consuming tool's runtime fail-closed default — that make an unclassified or drifted command a loud failure instead of a silent gap. The policy is a command's floor; explicitly-set flags can only escalate an invocation toward approval, never past a block or down from one.

## Requirements

### Requirement: Every action command declares its agent policy at registration

Every commander command that registers an action handler SHALL declare an `AgentPolicy` at its registration site, colocated with the command it governs. The policy SHALL be one of exactly three kinds: `auto` (runs without approval, carrying a `safeFlags` array), `approval` (approval-gated via `ctx.ask`, grantable per analysis), or `blocked` (never runs, carrying a mandatory model-facing reason). Registration SHALL go through a helper that takes the policy and the action handler together, so an action command without a policy is a TypeScript compile error — there is no default. The policy SHALL be attached to the `Command` instance itself (not keyed by the command's path string), so a rename or restructure cannot orphan a policy. Parent group commands without an action handler carry no policy: a bare group prints its own help and classifies as introspection.

#### Scenario: A registered action command carries a retrievable policy

- **WHEN** a command is registered through the policy-taking helper and later resolved by the classifier
- **THEN** the policy declared at registration is readable from the resolved `Command` instance

#### Scenario: A command rename cannot orphan its policy

- **WHEN** a command's name is changed at its registration site
- **THEN** its policy still applies to the renamed command without any other edit, because the policy travels with the `Command` instance rather than a path-string key

#### Scenario: A blocked declaration requires a reason

- **WHEN** a command is registered with the `blocked` kind
- **THEN** the declaration carries a model-facing reason string, and that reason is what the tool returns for the blocked invocation

### Requirement: Auto policies enumerate their safe flags

An `auto` policy SHALL carry a `safeFlags` array naming the command's options (by commander's canonical attribute name) that are approved for prompt-free invocations. A flag SHALL only be listed as safe when every value it can carry leaves the command read-only; an option whose value can change the command's effect (an output path, a refresh/force switch) is never safe. Every `safeFlags` entry SHALL name an option actually declared on that command, enforced by a CI test — a stale entry after an option rename is a loud test failure, and until fixed it is fail-safe (the invocation escalates to approval).

#### Scenario: A safeFlags entry naming no declared option fails CI

- **WHEN** an option named in a command's `safeFlags` is renamed or removed without updating the policy
- **THEN** the safeFlags-validation test fails, and at runtime the affected invocations escalate to approval rather than running free

#### Scenario: New options are unsafe until listed

- **WHEN** a new option is added to an `auto` command without touching its `safeFlags`
- **THEN** invocations that explicitly set the new option escalate to approval — the omission costs a prompt, never a silent free run

### Requirement: Static enforcement makes an unclassified command a build failure

Beyond the compile-time helper, the system SHALL enforce policy exhaustiveness statically: an ESLint restriction scoped to the command registry SHALL forbid raw commander `.action(` registration (the helper is the only path), and a CI test SHALL walk the full `buildProgram()` tree — with the dev channel forced both on and off — asserting every action-classified leaf carries a policy. A snapshot test SHALL pin the derived table of `subcommand path → policy kind (and safeFlags for auto)` so any policy change surfaces as a reviewable one-file diff. Validation SHALL live in lint and tests, never in `buildProgram()` itself — a policy mistake must not brick the CLI at startup for human use.

#### Scenario: A raw action registration is a lint error

- **WHEN** a command in the registry is given an action handler via commander's `.action()` directly instead of the policy-taking helper
- **THEN** ESLint fails the build

#### Scenario: The tree walk catches a policy-less leaf in either channel

- **WHEN** the exhaustiveness test walks the command tree with dev-channel commands enabled and again with them disabled
- **THEN** it fails if any action-classified leaf command lacks a stamped policy

#### Scenario: A policy change is a visible audit diff

- **WHEN** any command's policy kind or safeFlags change
- **THEN** the policy snapshot test fails until its expected table is consciously updated in review
