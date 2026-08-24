## ADDED Requirements

### Requirement: The data-profiler prompt states that profiling is orientation, not quality control

The `data-profiler` prompt SHALL state its purpose: it produces the dataset's orientation
record — what the data *is*, so planning can proceed — and it does not perform quality
control, which belongs to analysis steps.

The prompt SHALL carry an explicit prohibition on per-file statistical quality work,
naming the measures it excludes: transition/transversion ratios, allele-frequency spectra,
replicate correlation, principal-component outlier detection, coverage depth, mapping rate,
duplicate rate, insert-size distribution, and GC bias. It SHALL NOT carry per-format
quality checklists.

The governing rule SHALL be that a check earns its place if it answers *what is this* and
not if it answers *is this good*. Whether a matrix holds raw or normalised counts is
identity and is kept; the zero-inflation level of that matrix is a verdict on quality and
is not. The distinction matters because the excluded measures require decoding files in
full, which is what made profiling cost scale with input size, and no consumer of the
profile reads them.

The prompt SHALL direct the agent that where a kind's description depends on content the
scan did not capture, it inspects **one** example file of that kind — not one per member.

#### Scenario: The prompt states the purpose

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL state that the profile is an orientation record and that quality control belongs to analysis steps

#### Scenario: The prompt excludes per-file quality measures

- **WHEN** the data-profiler prompt is read
- **THEN** it SHALL NOT instruct the agent to compute transition/transversion ratios, allele-frequency spectra, replicate correlation, principal-component outlier detection, coverage depth, mapping rate, duplicate rate, insert-size distribution, or GC bias

#### Scenario: Sampling is per kind, not per member

- **GIVEN** a kind of 1171 members
- **WHEN** the agent needs content the scan did not capture
- **THEN** the prompt SHALL direct it to inspect one example file rather than one file per member

## MODIFIED Requirements

### Requirement: Data-profiler orients via workspace tools, not cd and ls

The `data-profiler` agent prompt SHALL orient from the input scan manifest carried in its
briefing (see the input-scan-manifest spec) rather than by enumerating the tree itself, and
where it does need to explore it SHALL use the workspace tools rather than shelling out with
`cd`/`ls` (`harness/src/prompts/sandbox/data-profiler.ts`).

The manifest is the orientation pass. It is produced deterministically before the agent's
first turn and already carries the tree's kinds, axes, formats, and counts, so an agent that
began by listing the tree would spend turns rediscovering what it was handed.

For exploration beyond the manifest the prompt SHALL direct the agent to `scan_inputs` with a
path to re-scan a subtree, or to `list_files` with `path: "data/inputs"`, recursing by calling
it again on a subdirectory it returned — `path` is `list_files`' only parameter, so there is
no depth argument to pass.

#### Scenario: Data-profiler orientation uses the manifest

- **WHEN** the data-profiler prompt is read
- **THEN** it directs the agent to orient from the input scan manifest in its briefing
- **AND** it does not direct the agent to enumerate the input tree as its orientation pass

#### Scenario: Exploration beyond the manifest uses workspace tools

- **WHEN** the data-profiler prompt directs exploration beyond the manifest
- **THEN** it names `scan_inputs` with a path, or `list_files` with `path: "data/inputs"`
- **AND** it names no second `list_files` parameter, because the tool declares none
