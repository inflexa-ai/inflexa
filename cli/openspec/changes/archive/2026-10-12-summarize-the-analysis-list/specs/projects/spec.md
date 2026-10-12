# Spec Delta

## ADDED Requirements

### Requirement: Read one project by id

The server MUST give `GET /api/v1/projects/:projectId`. The response MUST be the project with its analysis count: the fields of one item of `GET /api/v1/projects`. The id MUST match exactly, and a project name MUST NOT match. An unknown id MUST give 404 `not_found`. One statement MUST read the project and its count. The route reads only SQLite, thus it MUST answer in each phase of the server.

#### Scenario: A project by its id

- **GIVEN** a project `p1` with two analyses
- **WHEN** a client sends `GET /api/v1/projects/p1`
- **THEN** the server answers 200 with the fields of `p1` and an analysis count of 2

#### Scenario: An unknown id

- **WHEN** a client sends `GET /api/v1/projects/nope`
- **THEN** the server answers 404 `not_found`

#### Scenario: A name does not match

- **GIVEN** a project named `trial-42` whose id is different
- **WHEN** a client sends `GET /api/v1/projects/trial-42`
- **THEN** the server answers 404 `not_found`
