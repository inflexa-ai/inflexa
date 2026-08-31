# Delta: data-profile-init

## ADDED Requirements

### Requirement: The profile run carries the farm-extension seam

The deps bag of the profiler MUST carry the farm-extension seam when the
embedder binds one. The always-on substrate then attaches `link_packages`,
per the harness-sandbox-agents requirement. Thus the profiler links a reader
that the farm does not hold yet. An unbound seam keeps the current shape: no
link tool, and no error.

#### Scenario: The profiler links a reader before the first plan

- **GIVEN** a new analysis whose farm holds no packages, and a bound farm-extension seam
- **WHEN** the profiler meets an input that its scripts cannot read
- **THEN** it links the reader with `link_packages`, and the profile continues

#### Scenario: An unbound seam changes nothing

- **GIVEN** an embedder that binds no farm-extension seam
- **WHEN** the profile runs
- **THEN** the profiler has no `link_packages`, and the composition does not throw
