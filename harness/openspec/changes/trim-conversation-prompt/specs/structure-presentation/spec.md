# Spec Delta

## MODIFIED Requirements

### Requirement: The agent is told where a structure is shown

The description of `alphafold_prediction` MUST name `show_user(kind: "structure", url)` with `pdbUrl` or `cifUrl` as the way to show the predicted structure. The description MUST keep its rule that the tool never returns file contents, and that the agent never reads the file to show a structure. The description of `show_user` MUST name the structure card (`kind=structure`, by the URL that `alphafold_prediction` returned). The description of `show_file` MUST name a `.pdb` or `.cif` structure that a step wrote as an artifact that it shows. The conversation prompt carries no copy of these rules, because each display tool carries its own.

#### Scenario: The description names the display path

- **WHEN** the `alphafold_prediction` tool definition is read
- **THEN** its description names `show_user` with `kind: "structure"` and the URL fields to pass

#### Scenario: An artifact structure stays on show_file

- **WHEN** a step wrote `runs/run-abc/step-1/output/model.pdb` and the agent wants to show it
- **THEN** the description of `show_file` directs it to `show_file`, not to `show_user(kind: "structure")`

#### Scenario: The display tool names the structure card

- **WHEN** the `show_user` tool definition of the conversation agent is read
- **THEN** its description names `kind=structure` with the URL that `alphafold_prediction` returned
