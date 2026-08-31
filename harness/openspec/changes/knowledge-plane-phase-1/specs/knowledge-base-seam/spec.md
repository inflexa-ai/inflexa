# knowledge-base-seam Specification (delta)

## ADDED Requirements

### Requirement: The harness declares a KnowledgeBase seam

The harness MUST declare a `KnowledgeBase` interface with three operations: `findRules(facts, session)`, `getRule(id, session)`, and `describeCorpus()`. Each read operation MUST take the session, in the convention of the other capability seams. The harness MUST NOT branch on which realization is bound.

#### Scenario: One realization serves every consumer

- **WHEN** the composition resolves a realization
- **THEN** the planner brief, the knowledge tools, and the plan gate all read through that one instance

### Requirement: Assembly resolves the knowledge source one time with a fixed precedence

A `resolveCompositionKnowledge(seam, knowledgeDir)` function MUST resolve the source apart from `assembleCoreRuntime`, in the shape of `resolveCompositionEyes`. A bound seam MUST win. Otherwise a configured directory MUST become the file-backed realization. Otherwise the source MUST be absent.

#### Scenario: A bound seam wins over a configured directory

- **WHEN** the deps carry both a `knowledge` seam and a `knowledgeDir`
- **THEN** the resolution returns the bound seam and never constructs the file-backed realization

#### Scenario: A directory alone gives the file-backed realization

- **WHEN** the deps carry only a `knowledgeDir`
- **THEN** the resolution returns a file-backed `KnowledgeBase` over that directory

#### Scenario: Neither input gives an absent source

- **WHEN** the deps carry neither a seam nor a directory
- **THEN** the resolution returns `undefined`, and each consumer reports the absent condition as data

### Requirement: The file-backed realization reads a validated local corpus

The file-backed realization MUST read the rule files and the manifest from the supplied directory. A rule-file path that resolves outside the corpus directory MUST be excluded and reported, because the manifest is data. The containment MUST follow symlinks, thus a link planted inside the corpus cannot read a file outside it. It MUST validate each record against the rule-record schema. A record that fails validation MUST be excluded and reported through the injected `Logger`, and the valid records MUST still load. Construction over a directory with no readable manifest MUST refuse with a typed error.

#### Scenario: An invalid record does not sink the corpus

- **WHEN** one file holds a record with no resolvable source locator
- **THEN** that record is excluded, a log record names it, and `findRules` serves the remaining records

#### Scenario: A missing manifest refuses at construction

- **WHEN** the directory has no readable manifest
- **THEN** construction returns a typed error, and the composition treats the source as absent

#### Scenario: A symlink out of the corpus is excluded

- **WHEN** a manifest names a rule file that is a symlink to a file outside the corpus directory
- **THEN** the loader excludes it and reports it, and none of its records enter the corpus

### Requirement: Each successful consultation reports to an optional observation callback

The assembly MUST wrap the resolved source one time with an observation wrapper when `observeKnowledge` is supplied. Each successful `findRules` and `getRule` MUST report one event. The event carries the query kind, the corpus identity and version, the returned rule identifiers, and the agent identity. The callback contract copies `UsageRecorder`: a realization MUST NOT throw and MUST NOT block, and the harness MUST NOT await it.

#### Scenario: A consultation is observed

- **WHEN** `observeKnowledge` is supplied and the planner brief calls `findRules`
- **THEN** the callback receives one event with the corpus version and the returned rule identifiers

#### Scenario: No callback changes nothing

- **WHEN** `observeKnowledge` is not supplied
- **THEN** every consultation behaves identically, and no wrapper is constructed

### Requirement: Absence of a knowledge source is a normal condition

An absent source MUST NOT fail boot, a tool call, or plan validation. Each consumer MUST report the condition as a data outcome, and the plan flow MUST match today's behavior exactly.

#### Scenario: The OSS build with no corpus behaves as today

- **WHEN** no seam is bound and no directory is configured
- **THEN** plan generation, validation, and the sandbox loop run with no knowledge behavior and no error
