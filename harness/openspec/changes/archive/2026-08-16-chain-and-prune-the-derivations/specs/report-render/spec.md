# Delta: report-render

## ADDED Requirements

### Requirement: Every evidentiary binding joins the provenance appendix

The whole-table binding of a table block and of a chart block MUST join the provenance ledger, and the card shows the marker. The appendix entry names the path, in the artifact-table entry form. The appendix entry of a derived path MUST add the chain of its record: each source path with its hash prefix, and the script hash prefix. The derivation records ride the render call, exactly as the citation records do, and the renderer stays pure.

#### Scenario: A bound table gains its appendix entry

- **WHEN** the caller renders a table block over a pinned artifact
- **THEN** the card carries a marker, and the appendix names the path

#### Scenario: A derived chart states its chain

- **WHEN** the caller renders a chart over a derived path whose record names two sources and a script
- **THEN** the appendix entry carries the two source paths with hash prefixes, and the script hash prefix

#### Scenario: A document with no derivation renders as before

- **WHEN** the caller renders a document whose bindings name no derived path
- **THEN** no chain line renders, and the appendix holds the plain entries
