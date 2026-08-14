## ADDED Requirements

### Requirement: The CLI realizes the report page-asset lookup
The composition root MUST bind the asset lookup that `assembleCoreRuntime` accepts, in a release build alone. The lookup MUST map a manifest specifier onto the materialized file under the assets directory. The manifest that the harness exports MUST be the one source of that mapping, thus the composition restates no file name.

The lookup MUST throw for a specifier that the manifest does not carry. The preview tool wraps each call in a guard, and it turns a throw into its own typed outcome. Thus the throw is the protocol of the seam, and it is not a break of the rule that a failure rides the `Result` channel. The realization MUST carry the reason on the site.

A development build MUST bind nothing. A checkout holds the installation of the harness, thus the default lookup of the preview tool resolves each specifier there.

#### Scenario: A release build binds the materialized files

- **WHEN** a compiled binary composes the harness runtime after the content materializes
- **THEN** the composition binds a lookup that gives the path of each manifest entry under the assets directory

#### Scenario: The preview tool finds each asset in a compiled binary

- **WHEN** a report session renders a page in a compiled binary
- **THEN** the chart runtime and each font land beside the page, and the tool reports the page path

#### Scenario: An unknown specifier reaches the caller as a typed outcome

- **WHEN** the lookup receives a specifier that the manifest does not carry
- **THEN** it throws, and the preview tool gives back its write-failure outcome that names the cause

#### Scenario: A development build leaves the lookup unbound

- **WHEN** a development build composes the harness runtime
- **THEN** it passes no lookup, and the harness resolves each specifier against its own installation
