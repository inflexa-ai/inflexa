## ADDED Requirements

### Requirement: The farm lock path resolves for the analysis of each read

The embedder MUST give the host path of the farm `inflexa.lock` as one path or as a function of the analysis id. A host that keeps one farm for each analysis, and serves many analyses from one runtime, gives the function. Each reader of the farm inventory MUST resolve the path with the analysis id of its own session. The readers are `list_available_packages` and the package resolution of the ad hoc router. A reader MUST NOT keep a path that it resolved for a different analysis. A string path MUST name the same farm lock for each analysis, as before.

#### Scenario: A function path reads the farm of the session

- **GIVEN** an embedder that gives the farm lock path as a function of the analysis id
- **WHEN** `list_available_packages` runs in a session of analysis `a2`
- **THEN** the tool reads the `inflexa.lock` of the farm of `a2`, not of a different analysis

#### Scenario: A string path reads one farm lock

- **GIVEN** an embedder that gives the farm lock path as a string
- **WHEN** `list_available_packages` runs in sessions of two analyses
- **THEN** each read uses the same `inflexa.lock`
