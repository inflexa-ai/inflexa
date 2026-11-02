## ADDED Requirements

### Requirement: Skill pack structure

The system MUST give the pack at `skills/mdv-preparation/`, with a `SKILL.md` manifest and a `references/` directory. The manifest MUST hold the workflow, the decision tree of the input, the conventions, the anti-patterns, and a table of the references.

#### Scenario: The pack has a manifest and references

- **WHEN** `skills/mdv-preparation/` is listed
- **THEN** `SKILL.md` exists
- **AND** `references/` holds the project contract, the AnnData route, the view recipes, the validation, and one reference for each modality group

### Requirement: The pack defines an MDV-ready project

The pack MUST define a project as MDV-ready when the validator of the pack reports zero errors, and when the column names, the categories, and the views are readable without help. The pack MUST tell the agent to set `permission: "edit"` and an initial view that opens on the data.

#### Scenario: The converter output is not ready

- **GIVEN** a project that `convert_scanpy_to_mdv` wrote with its defaults
- **WHEN** the agent follows the pack
- **THEN** the agent replaces the empty default view with the view set of the modality
- **AND** the state holds `permission: "edit"`, the initial view, and the name of the project

### Requirement: The code of the pack is extractable

Each helper module of the pack MUST be one fenced Python block whose first line is `# file: <name>.py`. Each block MUST compile, and no file name occurs two times.

#### Scenario: The blocks extract and compile

- **WHEN** a script extracts each `# file:` block of the pack into a directory
- **THEN** each module compiles
- **AND** no module name occurs in two blocks

### Requirement: The validator checks the project in layers

The pack MUST give a validator that checks the files, the metadata, the HDF5 layout, the views and the state, a decode of each datasource, and a request for each column through the WSGI app of `mdvtools`. It MUST exit with status 1 when it finds an error.

#### Scenario: A corrupt project fails

- **GIVEN** a project with a view that names a column that does not exist
- **WHEN** the validator runs
- **THEN** its report holds an L3 error that names the view and the column
- **AND** it exits with status 1

### Requirement: A raw CosMx run gets a measured orientation

The CosMx reference MUST measure the sign between the axes of a FOV image and the stage axes before it places the cells on the slide. It MUST refuse a measurement that does not win by a clear margin.

#### Scenario: An ambiguous orientation stops the build

- **GIVEN** neighbor FOV images whose seam scores do not separate the hypotheses
- **WHEN** `check_orientation` runs
- **THEN** it raises an error that holds the scores
