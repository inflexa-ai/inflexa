# knowledge-tools Specification (delta)

## ADDED Requirements

### Requirement: Two read-only knowledge tools exist

The harness MUST give two tools, `knowledge_search` and `knowledge_read`, built by a factory that captures the resolved `KnowledgeBase`. `knowledge_search` MUST find rules by data facts or by a text query. Each match MUST carry the id, the statement, and the severity. `knowledge_read` MUST return one full record by id. Both MUST be `step`-mode and read-only. An expected outcome, which includes "not found" and "no knowledge source", MUST be a data variant, never a throw.

#### Scenario: A search returns bounded matches

- **WHEN** a planner calls `knowledge_search` with the omics type and a query
- **THEN** the result lists the applicable rules with id, statement, and severity, and it names the corpus version

#### Scenario: An absent source is a data outcome

- **WHEN** no knowledge source is resolved and an agent calls either tool
- **THEN** the tool returns the absent condition as data, and the agent continues

### Requirement: The tools attach to the planner and to the sandbox substrate

`knowledge_search` and `knowledge_read` MUST join the planner search tools, and they MUST join the always-on sandbox substrate. The sandbox attachment MUST NOT depend on the per-agent skills allowlist. The tool descriptions MUST teach a search by what the knowledge is about, never by a file location.

#### Scenario: Every sandbox agent can consult

- **WHEN** any sandbox agent runs with a resolved knowledge source
- **THEN** both tools are attached, with no change to `meta.skills`

### Requirement: Planner tool results join the invocation citation set

Inside one `generate_plan` invocation, each rule identifier that `knowledge_search` or `knowledge_read` returns MUST be recorded into the invocation citation set. The grounded gate MUST accept a plan citation only from that set.

#### Scenario: A searched rule becomes citable

- **WHEN** the planner finds a rule through `knowledge_search` and cites its id in a step
- **THEN** the gate accepts the citation
