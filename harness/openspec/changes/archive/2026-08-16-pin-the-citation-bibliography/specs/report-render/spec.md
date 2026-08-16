# Delta: report-render

## ADDED Requirements

### Requirement: The citation card is a bibliography entry

The citation card MUST render the short citation of its pinned record, the note of the block, and the citation key. A `pmid:` key MUST also render a PubMed link, built deterministically from the id. The link is a navigation and it loads nothing, thus the stand-alone rule holds. A key with no pinned record renders the key and the note alone, because absence is a normal condition.

The citation markers MUST number in their own bracket ladder, split from the numeric ladder of the artifact footnotes. The appendix citation entry MUST show the short citation beside the key when the record exists.

#### Scenario: The card renders the bibliography

- **WHEN** a citation block binds `pmid:26997480` and the pinned record carries `Hugo et al. 2016`
- **THEN** the card shows the bracket marker, the short citation, the note, and a PubMed link for the id

#### Scenario: A record-less key still renders

- **WHEN** a citation block binds a key that the record map does not hold
- **THEN** the card shows the bracket marker, the key, and the note, with no link

#### Scenario: The two ladders split

- **WHEN** a page holds two artifact references and two citations
- **THEN** the artifact markers read `1` and `2`, and the citation markers read `[1]` and `[2]`

## MODIFIED Requirements

### Requirement: The page stands alone
The skeleton MUST inline the style rules. The page MUST reference each script and each font as a relative `assets/<name>` path, and it MUST reference no CDN host. The renderer MUST export one asset manifest, and each entry MUST name the staged file and its package source. The caller MUST stage each manifest entry beside the page, in the same pipeline that stages the figures.

The front door of the package MUST re-export that manifest and its entry type. An embedder that stages the assets itself reads the manifest, and it binds the asset lookup that the preview tool accepts. The front door already carries the type of that lookup, thus the value it describes belongs beside it. A hand-kept copy of the entries in an embedder would ship a build that is short one file, with nothing to say so.

#### Scenario: The page loads no remote resource
- **WHEN** the caller renders any valid document
- **THEN** the page holds no `src` and no stylesheet `href` with an `http` or an `https` scheme. A navigation anchor is the one admitted remote reference

#### Scenario: The manifest and the page agree
- **WHEN** the caller renders any valid document
- **THEN** each `assets/` reference in the skeleton names one manifest entry

#### Scenario: The front door carries the manifest
- **WHEN** a consumer imports the package by its name
- **THEN** the asset manifest and its entry type resolve from that import
