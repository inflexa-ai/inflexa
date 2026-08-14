# report-render Specification (delta)

## REMOVED Requirements

### Requirement: The page holds no local asset reference
**Reason**: The page must stand alone. A CDN reference fails print and offline view, and a frozen version decays when the CDN drops the pin.
**Migration**: The skeleton references the staged sibling assets under `assets/`, and the caller stages each manifest entry beside the page.

## ADDED Requirements

### Requirement: The page stands alone
The skeleton MUST inline the style rules. The page MUST reference each script and each font as a relative `assets/<name>` path, and it MUST reference no CDN host. The renderer MUST export one asset manifest, and each entry MUST name the staged file and its package source. The caller MUST stage each manifest entry beside the page, in the same pipeline that stages the figures.

The front door of the package MUST re-export that manifest and its entry type. An embedder that stages the assets itself reads the manifest, and it binds the asset lookup that the preview tool accepts. The front door already carries the type of that lookup, thus the value it describes belongs beside it. A hand-kept copy of the entries in an embedder would ship a build that is short one file, with nothing to say so.

#### Scenario: The page references no remote host
- **WHEN** the caller renders any valid document
- **THEN** the page holds no `src` and no `href` with an `http` or an `https` scheme

#### Scenario: The manifest and the page agree
- **WHEN** the caller renders any valid document
- **THEN** each `assets/` reference in the skeleton names one manifest entry

#### Scenario: The front door carries the manifest
- **WHEN** a consumer imports the package by its name
- **THEN** the asset manifest and its entry type resolve from that import

#### Scenario: A staged page opens with no network
- **WHEN** the caller stages the manifest and a browser opens the page offline
- **THEN** each script and each font loads from the sibling directory, and no request fails
