## MODIFIED Requirements

### Requirement: Utility router selects a specialist and resources

Before the harness constructs a new ad hoc plan, it MUST make one structured
call through its required utility provider/model. The deadline of the call MUST
be the maximum of the 10-second default and the advertised `requestTimeoutMs`
of the utility provider. An explicit `timeoutMs` dep, when set, overrides the
derived deadline. The call MUST receive the request, the data-profile
orientation that the server loads, the plannable specialist catalog, and the
explicit resource bounds (lower, default, upper). It MUST have no workspace
tools and no execution tools.

Its result can recommend a specialist id, and it can recommend a resource
specification. But the result MUST NOT change the requested execution mode,
make a DAG, or reject the request as plan-only.

The harness MUST accept only an id in the plannable catalog as a routed
specialist. `scientific-executor` MUST NOT be a candidate. It MUST serve only
as the deterministic agent fallback when the selection is absent, invalid,
timed out, or failed.

The router MUST validate the resource output independently. Absent, malformed,
or out-of-bounds resources MUST use the ordinary default. A resource failure
MUST NOT discard a valid agent selection. An agent failure MUST NOT discard
valid resources.

The result can recommend the packages that the step imports, each entry in
the one package grammar. The router prompt MUST teach that grammar through
the same section that the planner prompt uses. The router MUST validate each
entry independently from the agent and the resources. An entry that does not
parse MUST be dropped, and a package failure MUST NOT change the agent or the
resources. When a resolution of the names is bound, a name that the pool does
not hold MUST be dropped. A name with a known spelling MUST take that
spelling. A name that both tracks hold MUST stay as written. When no
resolution is bound, or the inventory is unavailable, each entry that parses
MUST stay. The router MUST record each dropped entry with its reason.

#### Scenario: Targeted request selects a specialist

- **GIVEN** the request and data profile clearly match a plannable specialist
- **WHEN** the utility call returns that specialist and valid resources
- **THEN** the internal step stores and uses both recommendations

#### Scenario: Router cannot select an agent

- **WHEN** the utility call times out, errors, returns no match, or returns an id outside the plannable catalog
- **THEN** the step uses `scientific-executor`
- **AND** the failure class or fallback rationale is recorded

#### Scenario: A slow provider raises the router deadline

- **GIVEN** a utility provider that advertises a `requestTimeoutMs` above 10 seconds
- **WHEN** the router makes its structured call
- **THEN** the deadline is the advertised value, not the 10-second default

#### Scenario: Invalid resources do not erase a valid route

- **GIVEN** the router returns a valid specialist and resources above the stated ceiling
- **WHEN** the result is validated
- **THEN** the specialist is retained and resources use the bounded default

#### Scenario: Router does not overrule ad hoc mode

- **GIVEN** the conversation agent called ad hoc mode with an explicit user request
- **WHEN** the utility model considers the request broad
- **THEN** it still returns or falls back to a one-step route and cannot force plan generation

#### Scenario: The router names the packages of the step

- **GIVEN** a request that names a method whose library the pool holds
- **WHEN** the utility call returns that library in `packages`
- **THEN** the internal step carries it, and the link pass receives it

#### Scenario: A package failure does not erase a valid route

- **GIVEN** the router returns a valid specialist and a package entry that is a path
- **WHEN** the result is validated
- **THEN** the specialist is retained, the entry is dropped as unparsable, and the drop is recorded

#### Scenario: An absent name leaves the step with a caveat

- **GIVEN** a bound resolution that answers absent for one name and gives no suggestion
- **WHEN** the router validates the packages
- **THEN** the step does not carry that name, and its caveats name the drop

#### Scenario: A known spelling replaces the entry

- **GIVEN** a bound resolution that answers absent for `seurat` with the suggestion `Seurat`
- **WHEN** the router validates the packages
- **THEN** the step carries `Seurat`

#### Scenario: A bare both-track name reaches the link pass

- **GIVEN** the router returns the bare name `xgboost`, and both tracks hold it
- **WHEN** the launch runs the link pass with a bound seam
- **THEN** the launch refuses with the two prefixed forms, and no run reserves

### Requirement: Internal plan is mechanical and not an approval artifact

Ad hoc mode MUST persist an `AnalysisPlan` with one step and no dependencies.
The step MUST carry the request as the analytical question, the selected
agent and resources, and the packages that the router validated. It MUST
carry the ordinary iteration limit of the selected agent, and the acceptance
criteria for reproducible script and result artifacts and a direct answer. The caveats of the step MUST name each dropped package entry
with its reason. When the step declares no packages, the caveats MUST say so,
because the link pass then links nothing. The launch record MUST carry the
count of the package queries that the link pass sent. It MUST be
constructed deterministically by harness code and MUST NOT invoke the planner.
The plan MUST NOT be emitted for user approval or represented as user-authored
planning intent.

The internal plan id MUST derive from analysis and tool invocation identity.
Persistence MUST be insert-if-absent. After any insert race, each caller MUST
reload the stored plan so the first persisted routing decision wins.

#### Scenario: New invocation creates one-step bookkeeping

- **WHEN** an ad hoc invocation has no stored internal plan
- **THEN** the harness routes once, constructs and validates a single no-dependency step, and persists it before run reservation
- **AND** no planner model call or plan approval occurs

#### Scenario: Concurrent duplicate routing converges

- **GIVEN** two deliveries of the same invocation race before its internal plan exists
- **WHEN** both attempt insert-if-absent
- **THEN** exactly one plan row survives and both deliveries reload that same stored agent/resource decision

#### Scenario: The step carries the validated packages

- **WHEN** the router returns `["scanpy", "python:igraph"]`
- **THEN** the stored step carries that array, and the link pass receives two queries

#### Scenario: A step with no packages says so

- **WHEN** the router returns no packages
- **THEN** the stored step carries an empty array, the seam is not called, and a caveat says that the step declares no packages
