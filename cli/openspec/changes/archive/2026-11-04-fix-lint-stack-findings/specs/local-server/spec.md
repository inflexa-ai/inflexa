## MODIFIED Requirements

### Requirement: A client reaches the server state only through the API

The TUI and the API client MUST read and change the server state only through the HTTP API. A lint rule MUST refuse a static import from the TUI or the API client of these parts: the SQLite layer, the server, the bus, the harness runtime, and a module that holds state or does I/O. The rule MUST permit these parts: the pure harness contracts, the pure data profile view, the pure plan and part readers, the file check of an exported provenance document, and the update module. A type-only import of a server row type MUST also be refused, because each wire type comes from the shared API types.

The rule reads the module path of a re-export and of a dynamic `import()` the same way. A dynamic `import()` in the TUI or the API client MUST name its module with a written-out path: a string literal, or a template literal with no interpolation. The lint MUST refuse each other source, for example an interpolation, a variable, or a concatenation, because the rule cannot read a path that the program computes.

#### Scenario: The TUI imports the database

- **WHEN** a file of the TUI imports the SQLite query layer
- **THEN** the lint fails with the instruction to call a route of the server

#### Scenario: A client computes the path of a dynamic import

- **WHEN** a file of the TUI or of the API client calls `import()` with a template literal that holds an interpolation, or with a variable
- **THEN** the lint fails with the instruction to write the path out

#### Scenario: A client imports a pure helper lazily with a written-out path

- **WHEN** a file of the API client calls `import()` with a string literal or a template literal with no interpolation that names a permitted part
- **THEN** the lint reports nothing for that import
