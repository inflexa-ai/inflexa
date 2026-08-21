# Delta: harness-runtime

## ADDED Requirements

### Requirement: The composition root binds the package-store seams

The composition root MUST bind the three package-store values of the
harness config. `libStorePath` names the store root. `farmSource` is
`{ kind: "per-analysis" }`, with a resolver that names `farms/<analysisId>`
and heals a missing farm as an empty one. `toolchainSource` is `"image"`,
because the published image owns conda and Node. The root MUST bind
`extendAnalysisFarm` to the composition linker, thus the `link_packages`
tool exists for every sandbox agent. The CLI wrapper of a link refusal MUST
append the remedy text that names `inflexa store add`, because the harness
error carries only the missing names.

#### Scenario: The farm resolves per analysis

- **GIVEN** two analyses with two farms
- **WHEN** each starts a sandbox
- **THEN** each sandbox mounts its own farm at `/mnt/libs/farm`

#### Scenario: The refusal carries the CLI remedy

- **GIVEN** a link request for a package that the pool does not hold
- **WHEN** the refusal reaches the user surface
- **THEN** the text names `inflexa store add <name>` as the retry
