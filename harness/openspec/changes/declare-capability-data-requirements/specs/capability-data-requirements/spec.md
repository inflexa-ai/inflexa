## ADDED Requirements

### Requirement: A capability declares the datasets that it cannot run without

`AgentMeta` MUST carry an optional `dataRequirements` list. Each entry MUST hold one capability phrase of the same agent, and the reference-catalog dataset ids that the phrase cannot run without.

An entry MUST NOT name an id that the catalog does not hold. An entry MUST NOT name a recommended dataset, because a default store already holds one. An agent without a data-hungry capability MUST omit the field.

The declaration states which catalog entry carries the data. The skill of the agent still states what the data is and how to use it. The two are not a duplicate.

#### Scenario: Each declared id is a catalog id

- **WHEN** the agent catalog is parsed
- **THEN** each id of each `dataRequirements` entry is the id of a dataset of the reference catalog

#### Scenario: Each declared phrase belongs to its own agent

- **WHEN** the agent catalog is parsed
- **THEN** the `capability` value of each entry is one of the `capabilities` phrases of the same agent

#### Scenario: An agent declares no requirement

- **WHEN** an agent omits `dataRequirements`
- **THEN** the launch of a step of that agent demands no dataset, and nothing changes for it

### Requirement: A plan step names the capability that it was assigned for

The step schema MUST carry an optional `capability` field. It holds one capability phrase of the assigned agent, copied from the rendered catalog.

The planner MUST fill the field when it assigns a step for a capability of the catalog. A step without the field MUST launch as it does today. A phrase that matches no declaration MUST demand no dataset.

The step schema MUST NOT carry a dataset id, because the planner prompt renders that schema and a prompt names no dataset.

#### Scenario: The planner assigns a declared capability

- **WHEN** the planner assigns a step to an agent for a capability that declares a requirement
- **THEN** the step carries that capability phrase, verbatim from the catalog

#### Scenario: A step carries no phrase

- **WHEN** a step reaches the launch with no `capability` field
- **THEN** the launch resolves no requirement, and it starts the run

### Requirement: The launch refuses a plan whose declared data is absent

Before the run starts, the harness MUST resolve the declaration of each step against the reference store. The resolution MUST take the agent of the step, the phrase of the step, and the declaration of that phrase.

An absent dataset MUST refuse the launch. The refusal MUST name each absent id. It MUST NOT name a remedy command, because the remedy belongs to the embedder. The check MUST run in the pass that links the packages, because the store can change after the approval.

#### Scenario: One declared dataset is absent

- **WHEN** a step declares a capability whose requirement names a dataset that the store does not hold
- **THEN** the launch refuses, and the refusal names each absent dataset id

#### Scenario: Each declared dataset is present

- **WHEN** the store holds each dataset of the requirement
- **THEN** the launch proceeds, and the refusal does not occur

#### Scenario: The store cannot answer

- **WHEN** the reference store cannot be read
- **THEN** the refusal gives that one reason, and it names no dataset as absent

### Requirement: One tool answers the data requirement of a capability

The harness MUST give one tool that lists each declared data requirement. Each row MUST hold the agent, the capability phrase, and the state of each dataset in the live store.

The tool MUST name an absent dataset by its catalog id, because an install takes the id. The conversation agent MUST hold the tool. No prompt names a dataset. Thus the tool is the one route to the ids for a surface that reads no skill.

#### Scenario: A chat surface asks before it plans

- **WHEN** the conversation agent calls the tool on a store that holds none of the datasets of a capability
- **THEN** the answer names that capability, and it names each absent dataset by its catalog id

#### Scenario: The datasets are installed

- **WHEN** each dataset of each declaration is in the store
- **THEN** the answer reports each one as present, and it names no absent dataset

### Requirement: The matched negative capability declares its six datasets

The matched negative gene set capability of `translational-safety-agent` MUST declare these ids: `string-aliases-human`, `mgi-mouse-human-homology`, `impc-phenotyping`, `hpo-annotations`, `opentargets-mouse-phenotype`, and `opentargets-target-safety-event`.

It MUST NOT declare the expression table, the network, the gene tables, or the GO collection. Each of those is recommended, thus a default store holds it.

#### Scenario: A default store lacks the six

- **WHEN** the conversation agent calls the tool on a default store
- **THEN** the answer names the six datasets of the matched negative capability as absent

#### Scenario: A run starts without the six

- **WHEN** a plan step declares the matched negative capability on a store without the six
- **THEN** the launch refuses, and the refusal names the absent ids
