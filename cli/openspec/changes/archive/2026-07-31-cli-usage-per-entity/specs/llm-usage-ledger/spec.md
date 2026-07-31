## MODIFIED Requirements

### Requirement: The CLI realizes the harness UsageRecorder seam at its composition root

The CLI SHALL supply a `UsageRecorder` realization to `assembleCoreRuntime` at the single composition root that builds the harness runtime, so that every `runAgent` invocation the CLI can reach — the conversation turn, the planner and other sub-agent loops, the data-profile agent, and every analysis run step — delivers its records to that one realization. The realization SHALL be constructed once per booted runtime, not per turn or per call.

Supplying it at the composition root is NECESSARY BUT NOT SUFFICIENT, and the difference is where this requirement has already failed once. `runAgent` reads its recorder from the OPTIONS it is called with and falls back to the no-op realization when the field is absent — it does not read one off the agent definition, so an agent assembled with a recorder still records nothing when its loop is invoked without one. Every direct `runAgent` call site the CLI owns — the conversation turn above all, being the loop the user drives most — SHALL therefore pass the runtime's recorder in that options bag. A call site that omits it is silently unaccounted: the turn succeeds, the figure renders live from the finish rollup, and nothing is written, so no error surfaces anywhere.

Coverage SHALL be verified through the REAL call site rather than a substituted seam. A test that hands `runAgent` a fake and asserts the fake was called proves only that the fake was called; it cannot observe that production builds an options bag missing the field, which is exactly the defect that shipped under this requirement's earlier wording. The assertion SHALL be made against the options the production path actually constructs.

The realization SHALL satisfy the seam's two contract terms without qualification: `record` SHALL NOT throw for any input, and SHALL NOT await. A storage fault encountered while recording SHALL be reported through the structured logger and otherwise discarded, so that a usage-ledger failure can never fail, abort, or alter a turn that would otherwise have succeeded.

#### Scenario: Every reachable loop records under one realization

- **WHEN** a conversation turn dispatches a sub-agent tool that itself runs an agent loop
- **THEN** the calls of both loops arrive at the same injected recorder, each carrying its own `agentId` and `callPath`

#### Scenario: The conversation turn's own calls reach the ledger

- **GIVEN** a booted runtime and a chat turn that makes at least one reported LLM call
- **WHEN** the turn completes
- **THEN** the ledger holds that call under the conversation agent's id, not only the calls of the sub-agents the turn dispatched

#### Scenario: The production call site is what is asserted on

- **WHEN** the chat turn's `runAgent` options are examined as the production path builds them
- **THEN** they carry the runtime's recorder, so an omission fails the test rather than degrading to the no-op at runtime

#### Scenario: A storage fault cannot fail a turn

- **GIVEN** a recorder whose underlying write fails for every record
- **WHEN** a turn completes
- **THEN** `record` throws nothing, the turn's outcome is unchanged, and the failure is logged

#### Scenario: A host that wires nothing is unaffected

- **GIVEN** a harness runtime assembled without a recorder
- **WHEN** an agent loop runs
- **THEN** the no-op recorder absorbs every record and no ledger row is written
