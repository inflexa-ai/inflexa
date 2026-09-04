## MODIFIED Requirements

### Requirement: The link_packages tool exists only when the seam is bound

The `ExtendAnalysisFarm` seam MUST ride as an optional field of the sandbox
agent deps. When the embedder binds the seam, the composition MUST add a
`link_packages` tool to the always-on substrate of every sandbox agent. No
`meta.tools` allowlist names the tool, because an allowlist entry would break
an embedder that binds no seam. Without the seam, the tool and its prompt
layer MUST NOT exist.

The tool MUST take `packages` as an array of strings in the one grammar
of the `package-identity` capability, and it MUST parse each with
`parseQuery`. An entry that does not parse MUST refuse the call with the
parse issue and the entry, before any link. The tool holds no `ecosystem`
field, because the prefix carries the track, and one agent learns one
grammar.

The tool links what the host staged, and it MUST NOT install, download, or
acquire anything. It MUST return one outcome per query: `linked`,
`present`, `absent` with `acquisitionPossible`, `collision`, or
`unavailable`. An outcome MUST echo the spelling of its query. A
`collision` MUST carry the two store directories. Its detail MUST name
the packages that pull each side. For one spelling in two tracks, the
detail MUST name the two prefixed forms instead. An `unavailable` outcome MUST
carry the reason that the link pass cannot answer. It MUST NOT render as
an absence, because a false absence sends the agent after packages the
pool holds. A realization throw MUST read as `unavailable` with the thrown
reason, at each call site of the seam. A link MUST be live in the running
sandbox, with no restart. The tool description MUST state these facts.

The description MUST also state the remedy of a `collision` of one
spelling in two tracks: call the tool again with the prefixed form,
`python:<name>` or `r:<name>`. It MUST state that a collision is terminal
only after that call also refuses, or when the collision is two versions
of one distribution.

#### Scenario: A bound seam adds the tool

- **GIVEN** sandbox agent deps with `extendAnalysisFarm` bound
- **WHEN** the resolved tool list of any sandbox agent is inspected
- **THEN** it contains `link_packages`, and no `meta.tools` entry names it

#### Scenario: An unbound seam means no tool

- **GIVEN** sandbox agent deps without the seam
- **WHEN** the resolved tool list is inspected
- **THEN** `link_packages` is absent, and the composition does not throw

#### Scenario: A refusal tells the agent whether an acquisition can help

- **GIVEN** a request for a package that the pool does not hold
- **WHEN** `link_packages` returns
- **THEN** the outcome is `absent`, and `acquisitionPossible` states whether the host can acquire that ecosystem

#### Scenario: A link pass that cannot answer says why

- **GIVEN** a store whose dependency graph the realization cannot read
- **WHEN** `link_packages` returns
- **THEN** each outcome is `unavailable` with the graph reason, and no outcome is `absent`

#### Scenario: A realization throw reads as unavailable

- **GIVEN** a realization that throws at the link call
- **WHEN** `link_packages` returns
- **THEN** each outcome is `unavailable` with the thrown reason, and the loop sees no raw error

#### Scenario: A prefixed entry reaches the seam as a qualified query

- **WHEN** the agent calls `link_packages` with `["r:Seurat"]`
- **THEN** the seam receives one query with the spelling `Seurat` and the track `r`

#### Scenario: An entry that does not parse refuses the call

- **WHEN** the agent calls `link_packages` with `["bioc:fgsea"]`
- **THEN** the tool refuses with an issue that names the entry and the two permitted prefixes, and no link lands

#### Scenario: The description names the prefixed retry

- **WHEN** the description of `link_packages` is inspected
- **THEN** it directs the agent to call the tool again with `python:<name>` or `r:<name>` after a two-track `collision`

### Requirement: The package-link prompt layer appends only with the seam

A static prompt layer for the link tool MUST append to the sandbox system
prompt only when the seam is bound. The layer MUST teach: call
`link_packages` after a failed import, and after `list_available_packages`
reports a package absent. It MUST teach: pass the module name verbatim, a
refusal is a real answer, and a version collision is terminal. It MUST
teach the one grammar: after a `collision` of one spelling in two tracks,
call the tool again with `python:<name>` or `r:<name>`. It MUST teach:
drop the package only when that call also refuses. It MUST place the
report of a missing package after an `absent` or `unavailable` answer of
the link tool. With the seam bound, the description of
`list_available_packages` MUST NOT state that only its own report is
importable. The reason: the link tool can extend the farm from the pool.
The layer is a composition-time constant, thus the prompt stays
byte-identical across the steps of one composition.

#### Scenario: The layer follows the seam

- **GIVEN** two compositions, one with the seam bound and one without
- **WHEN** the two system prompts are compared
- **THEN** only the bound one carries the package-link layer, and each is stable across its own steps

#### Scenario: An absent lookup routes through the link tool

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt and the description of `list_available_packages` are inspected
- **THEN** both direct the agent to call `link_packages` before it reports a package missing

#### Scenario: The layer teaches the prefixed retry

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt is inspected
- **THEN** it directs the agent to retry `link_packages` with `python:<name>` or `r:<name>` after a two-track `collision`, and to drop the package only after that refusal
