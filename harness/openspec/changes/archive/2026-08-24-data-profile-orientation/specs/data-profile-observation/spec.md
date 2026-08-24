## MODIFIED Requirements

### Requirement: The profile reports activity across its whole duration, not only its agent loop

The body SHALL emit, in this order:

| Where | Phase | Activity phrase |
|-|-|-|
| before creating its sandbox | `sandbox-init` | `Starting sandbox` |
| before the deterministic input scan | `executing` | `Scanning input files` |
| before starting the agent loop | `executing` | `Running data-profiler` |
| per tool call | `executing` | the phrase derived from the tool's name and input |
| the vector-store indexing pass | `indexing` | `Indexing input descriptions for search` |
| after the terminal ledger write | `complete` | `Profile complete` |
| on any terminal failure | `failed` | the user-safe ledger reason |

The phrases are normative. They are what a user reads, so leaving them to the
implementation would leave the observable result of this capability unspecified. They
follow the imperative-gerund vocabulary the sandbox-step producer established, so the
two producers read as one voice.

Emitting `sandbox-init` before sandbox creation is likewise normative rather than
incidental: container provisioning is the longest single operation in a profile and
precedes the agent loop entirely, so a body that emitted only from the loop would
leave the longest wait unreported. The `Running data-profiler` emission covers the
remaining gap between a ready sandbox and the agent's first tool call.

`Scanning input files` is emitted for the same reason. The deterministic scan (see the
input-scan-manifest spec) runs between a ready sandbox and the agent's first turn, walks
every staged input, and on a large tree is the second-longest operation in a profile. Left
unreported it would read as `Running data-profiler` for minutes before the agent had begun,
which is the misreport `sandbox-init` exists to prevent.

The body SHALL emit **exactly one** terminal activity. `complete` SHALL be emitted
only AFTER the terminal ledger write has succeeded: emitted before it, a ledger write
that then failed would reach the failure path and emit `failed` as well, leaving two
terminal activities for one profile and a fold whose winner depends on arrival order.
The sandbox teardown SHALL emit nothing, for the same reason.

The terminal `failed` activity SHALL carry the same user-safe reason persisted to
the ledger, never internal detail.

The body SHALL NOT emit the contract's remaining phases, and their absence is a
decision rather than an omission: `generating-metadata` and `generating-summary`
describe a post-agent pipeline a profile does not run, `persisting` describes an
artifact-store upload a profile does not perform, `retrying` requires a retry loop the
body does not have, and `warning` requires a non-fatal user-facing warning channel —
the body's two soft conditions are logged and neither warrants interrupting the
activity line.

#### Scenario: The scan is reported before the agent loop

- **WHEN** the body runs the deterministic input scan
- **THEN** it SHALL emit `Scanning input files` before the scan begins
- **AND** SHALL emit `Running data-profiler` only once the scan has returned and the agent loop is starting

#### Scenario: A long scan does not read as agent work

- **GIVEN** an analysis whose input scan takes minutes
- **WHEN** a consumer reads the activity line during the scan
- **THEN** it SHALL read `Scanning input files` rather than `Running data-profiler`

#### Scenario: Exactly one terminal activity is emitted

- **WHEN** the body completes a profile successfully
- **THEN** it SHALL emit `Profile complete` after the terminal ledger write and no `failed` activity
