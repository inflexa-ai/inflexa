# mdv-preparation-skill Specification

## Purpose

Define the `mdv-preparation` skill pack. The analyst reads it to prepare and validate an MDV asset.

## Requirements

### Requirement: Skill pack structure

The system MUST give the pack at `skills/mdv-preparation/`, with a `SKILL.md` manifest and a `references/` directory. The manifest MUST hold the workflow, the decision tree of the input, the conventions, the anti-patterns, and a table of the references.

#### Scenario: The pack has a manifest and references

- **WHEN** `skills/mdv-preparation/` is listed
- **THEN** `SKILL.md` exists
- **AND** `references/` holds the asset contract, the asset route, the validation, and one reference for each modality group

### Requirement: The pack defines an MDV-ready asset

The pack MUST define an asset as MDV-ready when the validator of the pack reports zero errors, and when the column labels and the categories are readable without help. The pack MUST tell the agent that the label of a column is the name that MDV shows, and that the README is the glossary.

#### Scenario: A raw key is not a ready label

- **GIVEN** an AnnData whose columns are raw keys such as `total_counts`
- **WHEN** the agent follows the pack
- **THEN** the asset labels the column with words and units, such as `Transcripts per cell`
- **AND** the README explains the column

### Requirement: The code of the pack is extractable

Each helper module of the pack MUST be one fenced Python block whose first line is `# file: <name>.py`. Each block MUST compile, and no file name occurs two times.

#### Scenario: The blocks extract and compile

- **WHEN** a script extracts each `# file:` block of the pack into a directory
- **THEN** each module compiles
- **AND** no module name occurs in two blocks

### Requirement: The validator reads the asset as stored

The pack MUST give a validator that reads the HDF5 encodings of the asset. It MUST give an error for each condition that stops or corrupts the conversion of MDV: an unknown encoding, a nullable string array, a type that the conversion does not map, a duplicate name, a reserved label, a dense matrix, and a gene name with `|` or `(`. It MUST exit with status 1 when it finds an error.

#### Scenario: A pandas 3 file fails

- **GIVEN** an AnnData that pandas 3 wrote with its default string type
- **WHEN** the validator runs
- **THEN** its report holds an error for the nullable string array of the names
- **AND** it exits with status 1

### Requirement: A raw CosMx run gets a measured orientation

The CosMx reference MUST measure the sign between the axes of a FOV image and the stage axes before it places the cells on the slide. It MUST refuse a measurement that does not win by a clear margin.

#### Scenario: An ambiguous orientation stops the build

- **GIVEN** neighbor FOV images whose seam scores do not separate the hypotheses
- **WHEN** `check_orientation` runs
- **THEN** it raises an error that holds the scores
