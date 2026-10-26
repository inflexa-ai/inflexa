## ADDED Requirements

### Requirement: A block read tells an unknown id from a block that the authoring grammar refuses
The block read MUST give `found: false` only when no block of the draft holds the id. A stored atom that the authoring grammar refuses MUST give an error that names the block id.

The draft grammar admits each stored atom, and the read gives the atom in the authoring grammar. The two grammars differ in the stamped hash alone. Thus a stored atom that the authoring grammar refuses shows drift between the two grammars, not a missing block. A result of `found: false` would hide that drift.

#### Scenario: An unknown id is not found
- **WHEN** the agent reads a block with an id that no block of the draft holds
- **THEN** the read gives `found: false`

#### Scenario: A stored atom that the authoring grammar refuses is an error
- **GIVEN** a draft that holds an atom that the authoring grammar refuses
- **WHEN** the agent reads that atom by its id
- **THEN** the read gives an error that names the block id, and it does not give `found: false`
