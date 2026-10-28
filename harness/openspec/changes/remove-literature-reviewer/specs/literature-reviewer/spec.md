# Spec Delta

## REMOVED Requirements

### Requirement: Sub-agent packaged as a tool

**Reason**: The literature reviewer goes. The synthesizer was its only caller, and the synthesizer calls the lookups itself.

**Migration**: Refer to "The synthesizer looks up its evidence itself" in the `run-synthesizer` capability.

### Requirement: Bio-lookup tool surface

**Reason**: The literature reviewer goes. The synthesizer holds the same lookups.

**Migration**: Refer to "The synthesizer declares its terminal tools, its lookups, and the read tool" in the `run-synthesizer` capability.

### Requirement: Bounded iteration budget

**Reason**: The literature reviewer goes, and its loop with it.

**Migration**: None. The cap of the synthesizer loop is in "Run synthesis is the agentic run-synthesizer loop" in the `run-synthesizer` capability.

### Requirement: Sub-agent identity flows via callPath

**Reason**: The literature reviewer goes. No session has the agent id `literature-reviewer`.

**Migration**: None. The derivation of a child session stays in the `harness-session-model` capability.

### Requirement: Anti-patterns are explicitly forbidden in the prompt

**Reason**: The literature reviewer prompt goes.

**Migration**: None. The synthesis prompt tells the synthesizer to look up its evidence, and `submit_synthesis` refuses a PMID that no lookup returned.

### Requirement: Run synthesis is the agentic run-synthesizer loop

**Reason**: The synthesizer requirements move to a capability with the name of the synthesizer. The loop now has 40 iterations and no reviewer.

**Migration**: Refer to "Run synthesis is the agentic run-synthesizer loop", "The synthesizer declares its terminal tools, its lookups, and the read tool", and "synthesizeRun drives the loop and keeps its result" in the `run-synthesizer` capability.

### Requirement: The reviewer prompt teaches correct tool-argument usage

**Reason**: The literature reviewer prompt goes. Each lookup describes its own arguments.

**Migration**: None.

### Requirement: The literature reviewer can verify citations

**Reason**: The literature reviewer goes. The synthesizer holds `resolve_citation` over the shared resolver.

**Migration**: Refer to "The synthesizer looks up its evidence itself" in the `run-synthesizer` capability.

### Requirement: The run synthesis limits the literature reviewer to three calls

**Reason**: The literature reviewer goes, thus its budget has no subject.

**Migration**: Refer to "submit_synthesis refuses a PMID that no lookup of the run returned" in the `run-synthesizer` capability.

### Requirement: submit_synthesis checks a synthesis and does not end the run

**Reason**: The synthesizer requirements move to the `run-synthesizer` capability. The checks gain the PMID that a lookup returned.

**Migration**: Refer to "submit_synthesis checks a synthesis and does not end the run" in the `run-synthesizer` capability.

### Requirement: The host stamps the run id of a synthesis

**Reason**: The synthesizer requirements move to the `run-synthesizer` capability, with no change.

**Migration**: Refer to "The host stamps the run id of a synthesis" in the `run-synthesizer` capability.

### Requirement: The synthesis outcome is the last accepted submission

**Reason**: The synthesizer requirements move to the `run-synthesizer` capability. The text does not change, and a scenario adds a lookup in the salvage.

**Migration**: Refer to "The synthesis outcome is the last accepted submission" in the `run-synthesizer` capability.
