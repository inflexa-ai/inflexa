# Design — the knowledge plane tools

## Context

The harness is host-agnostic. A capability means the same thing under the CLI and under a managed deployment. Thus the knowledge plane is a seam of the harness, and the CLI binds it. The service is closed and remote. The harness never knows about a license. It sees a client, or it sees nothing.

Three constraints of Phase 0 bind this design: no prompt change, no seam change other than the new optional client, and no kernel change. The grounding rides in one optional field of the plan step and in a written decision record.

## Decisions

### D1 — One client interface, three operations, typed absence

`KnowledgeClient` has `recommend`, `check`, and `render`. Each answers a data variant. A service that is configured but unreachable answers `{ match: "unavailable" }` after the retry policy of `apiFetch`, and the run continues from the prose skills. A 400 answers `{ match: "rejected" }` with the field or the slot and the permitted values, thus the model corrects itself in one turn. No operation throws on a service outcome.

The alternative was a tool that throws on an unreachable service. The loop then reports an error tool result and the model retries a call that cannot succeed. A typed absence is what lets the planner mark a step ungrounded and continue.

### D2 — The tools attach only when a client is bound

`createKnowledgeTools({ client })` gives the two planner tools, or an empty list. `knowledgeTemplate` is a member of the sandbox allowlist that resolves to nothing without a client. The allowlist keeps its closed-union guarantee for every other member: an unknown name still throws at composition time.

The alternative was an always-on tool that answers `unavailable` for every call. That puts a description into the context of every run of the open-source host and invites a call that cannot succeed.

### D3 — The template tool writes through the mutator

The tool takes the mutator of the step, the same object behind `write_file` and `edit_file`. The script and the decision record land in the confined working directory, and the lineage collector records each write with its hash and the tool name `knowledge_template`. The script is never output tokens. A residual change goes through `edit_file` on a marked line.

### D4 — The farm versions ride from the tool

The tool reads the `inflexa.lock` of the farm when the host names one, and it sends the package versions with the render request. The service compares them with the pins of the template and answers the environment match, which the decision record keeps. The model never types a version.

### D5 — The grounding field is optional in both schemas

A stored plan and a plan made without the service load and validate as before. The tool description asks the planner to fill the field. The evaluation counts an empty field as ungrounded. Phase 1 adds the gate that requires the field when the service is configured.

### D6 — The harness keeps a lenient copy of the wire contract

The two subsystems are independent packages. The harness parses each answer with `looseObject` schemas that name the fields it reads, thus a richer answer of a later snapshot still parses, and a contract break fails as `invalid_response` and becomes `unavailable`.

## Risks

- The model ignores the tool. The description carries the contract and one example. The call rate is a Phase 0 measurement, and the Phase 1 brief is the remedy.
- The tool descriptions add tokens to every planner run under a bound client. The gain must come from fewer retries. The evaluation reports the breakdown.
