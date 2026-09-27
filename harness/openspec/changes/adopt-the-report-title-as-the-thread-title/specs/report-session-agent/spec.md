## ADDED Requirements

### Requirement: The preview names the thread after the rendered document

After the stamp passes, the preview tool MUST give the trimmed title of the rendered document to `setAutoTitle` of the thread store, before it emits the `data-report-rendered` part. It MUST NOT write an empty title. A failed write MUST log a warning, and the tool MUST keep its result.

#### Scenario: A render names the thread

- **GIVEN** a report thread with the title "RNA-seq QC — Report 1"
- **WHEN** the preview renders a document with the title "Tumor microenvironment findings"
- **THEN** the tool gives "Tumor microenvironment findings" to `setAutoTitle`

#### Scenario: An empty document title changes nothing

- **WHEN** the preview renders a document whose title holds only whitespace
- **THEN** the tool does not call `setAutoTitle`

#### Scenario: A failed write keeps the render

- **WHEN** `setAutoTitle` fails
- **THEN** the tool logs a warning, and the result is the `rendered` arm
