# Report Provenance Export

## ADDED Requirements

### Requirement: The document source seam
The harness MUST take an optional document source seam. The source gives the current provenance document and its attestation as opaque bytes, for one analysis, or absence. The harness MUST NOT parse the bytes.

#### Scenario: The source gives a document
- **WHEN** the preview asks the bound source for the analysis
- **THEN** the source gives the document bytes and the attestation bytes

#### Scenario: The source gives absence
- **WHEN** the bound source has no document for the analysis
- **THEN** the preview proceeds, and the page carries no document asset

### Requirement: The preview exports the document into the page assets
The preview MUST write the document and the attestation as content-addressed script assets that register one page global. The asset name derives from the content hash, thus an unchanged document writes the same asset. The sweep keeps the assets of the run, and a stale document asset is swept. When the seam is not bound, the preview writes no document asset.

#### Scenario: The document rides the page
- **WHEN** the preview renders with a bound source that gives a document
- **THEN** the assets hold the document and the attestation as script assets, and the page loads them

#### Scenario: The document changes between previews
- **WHEN** a second preview runs after the document changes
- **THEN** the new asset lands under a new name, and the sweep removes the old asset

#### Scenario: The page opens offline
- **WHEN** the rendered page opens through `file://`
- **THEN** the document loads through the script asset, with no fetch of a local file
