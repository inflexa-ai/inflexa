# harness-session-model Specification

## Purpose

Defines the session value objects carried through the core agent loop,
providers, tools, and DBOS workflows. Core models caller identity and durable
run identity without depending on a host's auth system.

This is one face of the OSS-core / managed split: core is a host-agnostic
library behind a small set of injected capability seams, runnable with
filesystem/no-op defaults, and core never branches on which realization is
bound. The session reflects that line. `Credential` and `AuthContext` are opaque
branded values whose concrete shape is an embedder refinement — core forwards
them but never inspects, downcasts, or pattern-matches on them, so the "never
branch on credential kind" promise is type-enforced. The session carries no
top-level `orgId` or `credential` field: the opaque `auth` capability is the
*sole* carrier of credential/org behind a session, and an embedder reads it via
a single contained `getAuth` cast per adapter while the OSS build supplies a
trivial empty `auth` (`makeLocalAuth`). The one place credential kind matters —
minting a fresh run credential versus reusing an existing one — lives at the
`RunAuthorizer` seam, not in core tools. Resolved billing headers live on no
session; they are resolved lazily at the LLM call site through the
`ResolveBilling` seam (see the harness-providers spec).

## Requirements

### Requirement: Request identity is composed of typed value objects

Core SHALL model request identity as immutable value objects: `Identity`,
`Scope`, opaque `Credential`, `Provenance`, optional `RunFrame`, and opaque
`AuthContext`. Optional concerns SHALL be modeled as whole present-or-absent
sub-objects, never as optional fields sprinkled on a flat struct.

#### Scenario: An analysis scope resolves to an analysis resource

- **WHEN** a `Scope` of kind `analysis` is constructed with an `analysisId`
- **THEN** `scopeResource(scope)` returns `{ resourceType: "analysis", resourceId: analysisId }`

#### Scenario: A target-assessment scope carries both ids and resolves through billing context

- **WHEN** a `Scope` of kind `target-assessment` is constructed with both a `targetAssessmentId` and a `billingContextId`
- **THEN** `scopeResource(scope)` returns `{ resourceType: "billing_context", resourceId: billingContextId }`, while `scopeWorkloadId(scope)` returns the `targetAssessmentId`

#### Scenario: threadId lives only on the analysis scope

- **WHEN** the `Scope` union is inspected
- **THEN** `threadId` is a field of the `analysis` variant only, and `billingContextId` is a required field of the `target-assessment` variant only

### Requirement: Credential and AuthContext are opaque to core

`Credential` and `AuthContext` SHALL be opaque branded values. Core SHALL
forward them to seams and providers but SHALL NOT inspect, downcast, or branch
on their concrete host-specific shape.

#### Scenario: Local auth carries no host fields

- **WHEN** `makeLocalAuth()` is used to build a local session
- **THEN** the resulting auth value satisfies `AuthContext`
- **AND** core code cannot read host-specific fields from it

### Requirement: Two lifetime-typed session bundles

Core SHALL expose exactly two session bundles: `RequestSession` for live
request work and `RunSession` for durable workflow work. `RequestSession`
SHALL NOT carry a `RunFrame` and SHALL NOT be JSON-serialized into durable
state. `RunSession` SHALL carry a `RunFrame` and SHALL be the only session type
accepted by async/durable workflow APIs.

#### Scenario: A RequestSession has no RunFrame

- **WHEN** a `RequestSession` is constructed for a live request
- **THEN** it carries no `RunFrame`

#### Scenario: Durable APIs require RunSession

- **WHEN** a caller attempts to start durable work with a `RequestSession`
- **THEN** the code fails to compile, because durable APIs accept only `RunSession`

#### Scenario: Neither bundle carries billing headers

- **WHEN** either bundle is inspected
- **THEN** it contains no resolved billing header map

### Requirement: The agent loop, provider, and tools accept AgentSession

The agent loop (`runAgent`), the provider seams, and `ToolContext` SHALL each accept an `AgentSession` structural view. Both `RequestSession` and `RunSession` SHALL satisfy that view so the same agent path can run under a live request or inside a workflow.

#### Scenario: A RunSession runs the same agent path as a RequestSession

- **GIVEN** the agent loop and provider seam typed on `AgentSession`
- **WHEN** a `RunSession` is passed where a `RequestSession` flows in chat
- **THEN** it type-checks and runs the same loop

### Requirement: RunAuthorizer is the sole constructor of RunSession

`RunAuthorizer.authorize(input)` SHALL be the only seam that produces a
`RunSession`. It takes a single `AuthorizeRunInput` (`{ auth, scope, provenance,
frame }`) and returns `Promise<RunAuthorization>`, where `RunAuthorization` is
`{ runSession, ownsMandate }` — `ownsMandate` true only when this authorizer
minted the run credential and therefore must `revoke` it on the terminal path.
The local realization (`createLocalRunAuthorizer`) issues a durable session with
no remote mint, no revoke (`ownsMandate: false`). Embedders may provide their
own realization, but workflow bodies SHALL NOT re-authorize; the `RunSession`
rides in workflow input and DBOS replay reconstructs it from input.

#### Scenario: Local authorizer issues a RunSession it does not own

- **WHEN** `createLocalRunAuthorizer().authorize(input)` is called
- **THEN** it returns `{ runSession, ownsMandate: false }`, with `runSession` carrying the requested `RunFrame`

#### Scenario: Workflow bodies do not mint

- **WHEN** `executeAnalysis`, `executeTargetAssessment`, or `sandboxStep` executes
- **THEN** no run authorization call is made inside the workflow body

### Requirement: Sub-agent derivation changes provenance; step derivation changes runFrame

Core SHALL expose two pure derivation helpers:

- `forSubAgent(session, agentId)` sets the child `agentId` and appends it to `callPath`.
- `forStep(parent: RunSession, stepId: string)` sets `runFrame.stepId`.

Sub-agent provenance and step framing are independent: a child workflow that
internally calls `forSubAgent` does so on top of a `forStep`-derived parent
session.

#### Scenario: A sub-agent session appends to callPath

- **GIVEN** a session whose `callPath` is `["conversation-agent"]`
- **WHEN** a child session is derived via `forSubAgent(session, "literature-reviewer")`
- **THEN** the child `callPath` is `["conversation-agent", "literature-reviewer"]`

#### Scenario: forStep sets stepId and leaves identity intact

- **GIVEN** a parent `RunSession` with `runFrame = { runId: "r1" }`
- **WHEN** `forStep(parent, "step-A")` is called
- **THEN** the returned `RunSession` has `runFrame = { runId: "r1", stepId: "step-A" }`
