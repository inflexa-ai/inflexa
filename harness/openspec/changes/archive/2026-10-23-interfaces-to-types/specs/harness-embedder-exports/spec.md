## MODIFIED Requirements

### Requirement: The root barrel carries each name that an embedder cannot otherwise write

`src/index.ts` is the curated front door of `@inflexa-ai/harness`. A name MUST
be on the front door when an embedder cannot write its own composition root
without that name. Two conditions make a name necessary:

- The name types a field of a dependency object that the barrel exports already.
  An embedder that cannot name the field cannot build the object.
- The name types a value that an exported function gives back. An embedder
  that cannot name the value cannot hold it or pass it on.

Each deep subpath MUST stay importable. The barrel is additive, and it is not a
wall. But an embedder MUST reach every name above through the package root, and
it MUST take no deep import to do so.

#### Scenario: A field type of an exported dependency object is on the front door

- **GIVEN** a dependency type that the root barrel exports
- **WHEN** an embedder writes a literal of that type
- **THEN** it names the type of every field through the package root

#### Scenario: A return type of an exported function is on the front door

- **GIVEN** a function that the root barrel exports
- **WHEN** an embedder holds the value that the function gives back
- **THEN** it names that value's type through the package root

#### Scenario: A deep subpath stays importable

- **WHEN** a consumer imports `@inflexa-ai/harness/<subpath>.js`
- **THEN** the import resolves, and the front door removes no deep subpath
