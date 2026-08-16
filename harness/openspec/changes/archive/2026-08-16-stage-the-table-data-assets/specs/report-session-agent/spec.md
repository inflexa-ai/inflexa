# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The render-and-preview tool

The preview MUST stage each data-script payload and each table sidecar beside the page, in the pipeline that stages the figures. The stage MUST be authoritative over the assets directory: after the page lands, every file that the new page does not reference goes, and the manifest statics stay. Thus a removed block leaves no orphan, and the directory is exactly the page's closure.

#### Scenario: The data asset lands beside the page

- **WHEN** the preview renders a document with a bound table
- **THEN** the data-script asset and the raw sidecar sit under `assets/`, and the page references both

#### Scenario: The stage removes what nothing references

- **WHEN** a block goes and the next preview runs
- **THEN** the stale data asset and the stale sidecar are gone, and the manifest statics stay
